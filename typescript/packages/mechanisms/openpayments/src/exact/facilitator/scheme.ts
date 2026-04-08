import {
  createAuthenticatedClient,
  isFinalizedGrantWithAccessToken,
  isPendingGrant,
  type AuthenticatedClient,
  type IncomingPayment,
} from "@interledger/open-payments";
import {
  FacilitatorContext,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  DEFAULT_CACHE_EVICTION_TTL_MS,
  DEFAULT_IDEMPOTENCY_WINDOW_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  OPEN_PAYMENTS_SCHEME,
} from "../../constants";
import { InMemoryPaymentUrlCache } from "../../types";
import {
  generatePaymentUrlCacheKey,
  getAssetScaleFromExtra,
  normalizeUrl,
  retryWithBackoff,
  RetryConditionNotMetError,
  wrapError,
} from "../../utils";
import type {
  OpenPaymentsFacilitatorConfig,
  OpenPaymentsPayload,
  PaymentUrlCache,
} from "../../types";

type ResolvedOpenPaymentsFacilitatorConfig = Required<
  Omit<OpenPaymentsFacilitatorConfig, "usedPaymentUrlsCache" | "publicKey" | "useHttp">
> & {
  usedPaymentUrlsCache: PaymentUrlCache;
  publicKey?: string;
  useHttp?: boolean;
};

/**
 * Facilitator for the `exact` scheme on `ilp:openpayments`.
 * Verifies ILP payments by fetching the incoming payment from the resource server; settle is a no-op.
 */
export class ExactOpenPaymentsScheme implements SchemeNetworkFacilitator {
  readonly scheme = OPEN_PAYMENTS_SCHEME;
  readonly caipFamily = "ilp:openpayments";

  private readonly config: ResolvedOpenPaymentsFacilitatorConfig;
  private openPaymentsClient: AuthenticatedClient | null = null;
  private openPaymentsClientPromise: Promise<AuthenticatedClient> | null = null;

  /** Cached read access tokens keyed by auth server URL + merchant wallet (payTo). */
  private readTokenCache: Map<string, { value: string; expiresAt: number }> = new Map();

  /** In-flight GNAP read token requests; prevents stampede on concurrent cache misses. */
  private inFlightReadTokenRequests: Map<string, Promise<string>> = new Map();

  /** In-flight verifications keyed by cache key; prevents concurrent double-accept of the same payment URL. */
  private inFlightVerifications: Map<string, Promise<VerifyResponse>> = new Map();

  /**
   * Creates the facilitator.
   *
   * @param config - Wallet address, key pair, and cache settings
   */
  constructor(config: OpenPaymentsFacilitatorConfig) {
    this.config = {
      keyId: config.keyId,
      privateKey: config.privateKey,
      publicKey: config.publicKey,
      walletAddress: config.walletAddress,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryDelayMs: config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      usedPaymentUrlsCache: config.usedPaymentUrlsCache ?? new InMemoryPaymentUrlCache(),
      idempotencyWindowMs: config.idempotencyWindowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS,
      cacheEvictionTtlMs: config.cacheEvictionTtlMs ?? DEFAULT_CACHE_EVICTION_TTL_MS,
      useHttp: config.useHttp,
    };
  }

  /**
   * ILP has no mechanism-specific extra data.
   *
   * @param _ - Unused
   * @returns undefined
   */
  getExtra(_: string): Record<string, unknown> | undefined {
    return undefined;
  }

  /**
   * Returns the facilitator's wallet address as the signer.
   *
   * @param _ - Unused
   * @returns Wallet address array
   */
  getSigners(_: string): string[] {
    return [this.config.walletAddress];
  }

  /**
   * Verifies the payment payload: scheme, host, replay, completion, asset, amount, and age.
   *
   * @param payload - Payment payload to verify
   * @param requirements - Payment requirements
   * @param _ - Unused
   * @returns Verification result
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    const openPaymentsPayload = payload.payload as OpenPaymentsPayload;

    if (
      payload.accepted.scheme !== OPEN_PAYMENTS_SCHEME ||
      requirements.scheme !== OPEN_PAYMENTS_SCHEME
    ) {
      return { isValid: false, invalidReason: "unsupported_scheme" };
    }

    const incomingPaymentUrl = openPaymentsPayload?.incomingPaymentUrl;
    if (!incomingPaymentUrl) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_openpayments_payload_missing_incoming_payment_url",
      };
    }

    // Fast rejection before fetching; authoritative check is post-fetch via payment.walletAddress.
    try {
      const paymentHost = new URL(incomingPaymentUrl).host;
      const payToHost = new URL(requirements.payTo).host;

      if (paymentHost !== payToHost) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_openpayments_payload_wallet_mismatch",
        };
      }
    } catch {
      return {
        isValid: false,
        invalidReason: "invalid_exact_openpayments_payload_invalid_url",
      };
    }

    const resourceUrl = payload.resource?.url ?? "";
    const cacheKey = generatePaymentUrlCacheKey(incomingPaymentUrl, resourceUrl);

    // Always evict stale entries, regardless of verify outcome.
    this.config.usedPaymentUrlsCache.clearOlderThan(Date.now() - this.config.cacheEvictionTtlMs);

    // Replay attack prevention
    const existingEntry = this.config.usedPaymentUrlsCache.get(cacheKey);
    if (existingEntry) {
      const entryAge = Date.now() - existingEntry.timestamp;

      if (entryAge > this.config.idempotencyWindowMs) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_openpayments_payload_url_already_used",
        };
      }

      if (normalizeUrl(existingEntry.resourceUrl) !== normalizeUrl(resourceUrl)) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_openpayments_payload_url_used_for_different_resource",
        };
      }
    }

    // Deduplicate concurrent verifications for the same payment URL to prevent
    // two requests from both passing the replay check before either writes to cache.
    const inflight = this.inFlightVerifications.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const verificationPromise = this.performVerification(
      incomingPaymentUrl,
      resourceUrl,
      requirements,
      cacheKey,
    ).finally(() => {
      this.inFlightVerifications.delete(cacheKey);
    });

    this.inFlightVerifications.set(cacheKey, verificationPromise);

    return verificationPromise;
  }

  /**
   * No-op settle — funds already moved via ILP. Returns the incoming payment URL as the transaction reference.
   *
   * @param payload - Payment payload
   * @param requirements - Payment requirements
   * @param _ - Unused
   * @returns Successful settle response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _?: FacilitatorContext,
  ): Promise<SettleResponse> {
    return {
      success: true,
      transaction: (payload.payload as OpenPaymentsPayload).incomingPaymentUrl,
      network: requirements.network,
    };
  }

  /**
   * Returns a lazily-initialized singleton SDK client.
   *
   * @returns Authenticated SDK client
   */
  protected async getOpenPaymentsClient(): Promise<AuthenticatedClient> {
    if (this.openPaymentsClient) {
      return this.openPaymentsClient;
    }

    if (!this.openPaymentsClientPromise) {
      this.openPaymentsClientPromise = this.createOpenPaymentsClient();
    }

    this.openPaymentsClient = await this.openPaymentsClientPromise;
    return this.openPaymentsClient;
  }

  /**
   * Override in tests to inject a mock SDK client.
   *
   * @returns Authenticated SDK client
   */
  protected async createOpenPaymentsClient(): Promise<AuthenticatedClient> {
    return createAuthenticatedClient({
      keyId: this.config.keyId,
      privateKey: Buffer.from(this.config.privateKey, "base64"),
      walletAddressUrl: this.config.walletAddress,
      ...(this.config.useHttp !== undefined && { useHttp: this.config.useHttp }),
    });
  }

  /**
   * Fetches and validates the incoming payment, then writes to the replay cache on success.
   *
   * @param incomingPaymentUrl - Incoming payment URL
   * @param resourceUrl - Resource URL for cache keying
   * @param requirements - Payment requirements
   * @param cacheKey - Pre-computed replay cache key
   * @returns Verification result
   */
  private async performVerification(
    incomingPaymentUrl: string,
    resourceUrl: string,
    requirements: PaymentRequirements,
    cacheKey: string,
  ): Promise<VerifyResponse> {
    let paymentDetails: IncomingPayment;

    try {
      paymentDetails = await retryWithBackoff(
        () => this.getIncomingPaymentDetails(incomingPaymentUrl, requirements.payTo),
        this.config.maxRetries,
        this.config.retryDelayMs,
        payment => payment.completed !== true,
      );
    } catch (error) {
      if (error instanceof RetryConditionNotMetError) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_openpayments_payload_not_completed",
        };
      }

      throw error;
    }

    // Authoritative wallet address check from the resource server.
    if (
      !paymentDetails.walletAddress ||
      normalizeUrl(paymentDetails.walletAddress) !== normalizeUrl(requirements.payTo)
    ) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_openpayments_payload_wallet_mismatch",
      };
    }

    if (!paymentDetails.receivedAmount) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_openpayments_payload_not_completed",
      };
    }

    if (paymentDetails.receivedAmount.assetCode !== requirements.asset) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_openpayments_payload_asset_mismatch",
      };
    }

    const requiredScale = getAssetScaleFromExtra(requirements.extra);

    if (
      requiredScale !== undefined &&
      paymentDetails.receivedAmount.assetScale !== undefined &&
      paymentDetails.receivedAmount.assetScale !== requiredScale
    ) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_openpayments_payload_asset_scale_mismatch",
      };
    }

    // Both values are in the smallest asset unit.
    if (paymentDetails.receivedAmount.value !== requirements.amount) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_openpayments_payload_amount_mismatch",
      };
    }

    if (!paymentDetails.createdAt) {
      throw new Error("Incoming payment response missing createdAt");
    }

    const createdAt = new Date(paymentDetails.createdAt).getTime();
    const ageSeconds = (Date.now() - createdAt) / 1000;

    if (ageSeconds > requirements.maxTimeoutSeconds) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_openpayments_payload_too_old",
      };
    }

    this.config.usedPaymentUrlsCache.set(cacheKey, { timestamp: Date.now(), resourceUrl });

    return { isValid: true };
  }

  /**
   * Returns a cached read token for the auth server, requesting a new GNAP grant when expired.
   * Concurrent requests for the same key are deduplicated via an in-flight map.
   *
   * @param authServerUrl - Auth server URL
   * @param payToWalletUrl - Merchant wallet URL (grant scope)
   * @returns Bearer token for reading incoming payments
   */
  private async getReadAccessToken(authServerUrl: string, payToWalletUrl: string): Promise<string> {
    const cacheKey = `${authServerUrl}\0${normalizeUrl(payToWalletUrl)}`;
    const cached = this.readTokenCache.get(cacheKey);

    // 30s buffer before expiry
    if (cached && cached.expiresAt > Date.now() + 30_000) {
      return cached.value;
    }

    // Deduplicate concurrent grant requests for the same auth server + wallet.
    const inflight = this.inFlightReadTokenRequests.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const tokenPromise = this.requestReadToken(authServerUrl, payToWalletUrl, cacheKey).finally(
      () => {
        this.inFlightReadTokenRequests.delete(cacheKey);
      },
    );

    this.inFlightReadTokenRequests.set(cacheKey, tokenPromise);

    return tokenPromise;
  }

  /**
   * Requests a GNAP read token, stores it in the cache, and evicts expired entries.
   *
   * @param authServerUrl - Auth server URL
   * @param payToWalletUrl - Merchant wallet URL (grant scope)
   * @param cacheKey - Pre-computed cache key
   * @returns Bearer token value
   */
  private async requestReadToken(
    authServerUrl: string,
    payToWalletUrl: string,
    cacheKey: string,
  ): Promise<string> {
    const client = await this.getOpenPaymentsClient();
    const grantResponse = await client.grant
      .request(
        { url: authServerUrl },
        {
          access_token: {
            access: [
              {
                type: "incoming-payment",
                actions: ["read", "read-all"],
                identifier: payToWalletUrl,
              },
            ],
          },
        },
      )
      .catch(wrapError(`Failed to request read grant from ${authServerUrl}`));

    if (isPendingGrant(grantResponse) || !isFinalizedGrantWithAccessToken(grantResponse)) {
      throw new Error(
        `Auth server ${authServerUrl} returned an interactive grant for incoming-payment:read,read-all — ` +
          "ensure the facilitator's wallet address is registered and the auth server auto-approves read grants",
      );
    }

    const token = grantResponse.access_token;
    const expiresIn = token.expires_in ?? 3600;
    const expiresAt = Date.now() + expiresIn * 1000;

    this.readTokenCache.set(cacheKey, { value: token.value, expiresAt });
    this.evictExpiredReadTokens();

    return token.value;
  }

  /**
   * Removes expired entries from the read token cache.
   */
  private evictExpiredReadTokens(): void {
    const now = Date.now();

    for (const [key, entry] of this.readTokenCache.entries()) {
      if (entry.expiresAt <= now) {
        this.readTokenCache.delete(key);
      }
    }
  }

  /**
   * Fetches incoming payment details by first discovering the auth server via a public fetch,
   * then using a cached read token to retrieve the authenticated payment record.
   *
   * @param incomingPaymentUrl - Incoming payment URL
   * @param payToWalletUrl - Merchant wallet URL (grant scope)
   * @returns Incoming payment details from the SDK
   */
  private async getIncomingPaymentDetails(
    incomingPaymentUrl: string,
    payToWalletUrl: string,
  ): Promise<IncomingPayment> {
    const client = await this.getOpenPaymentsClient();

    const publicPayment = await client.incomingPayment
      .getPublic({ url: incomingPaymentUrl })
      .catch(wrapError(`Failed to discover auth server for ${incomingPaymentUrl}`));

    const authServerUrl = publicPayment.authServer;
    if (!authServerUrl) {
      throw new Error(`Wallet at ${payToWalletUrl} did not return an authServer URL`);
    }

    const accessToken = await this.getReadAccessToken(authServerUrl, payToWalletUrl);

    return client.incomingPayment
      .get({ url: incomingPaymentUrl, accessToken })
      .catch(wrapError(`Failed to retrieve incoming payment at ${incomingPaymentUrl}`));
  }
}
