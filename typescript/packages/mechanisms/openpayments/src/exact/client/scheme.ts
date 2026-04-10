import {
  OpenPaymentsClientError,
  createAuthenticatedClient,
  isFinalizedGrantWithAccessToken,
  isPendingGrant,
  type AuthenticatedClient,
  type GrantRequest,
  type OutgoingPaymentWithSpentAmounts,
} from "@interledger/open-payments";
import {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import { OPEN_PAYMENTS_SCHEME } from "../../constants";
import {
  discoverWalletAddress,
  getAssetScaleFromExtra,
  waitForCondition,
  wrapError,
} from "../../utils";
import type { OpenPaymentsClientConfig } from "../../types";

/** GNAP grant request body without the `client` field (injected by the SDK). */
type GrantBody = Omit<GrantRequest, "client">;

/** Client implementation for the `exact` scheme on `ilp:openpayments`. */
export class ExactOpenPaymentsScheme implements SchemeNetworkClient {
  readonly scheme = OPEN_PAYMENTS_SCHEME;
  private openPaymentsClient: AuthenticatedClient | null = null;
  private openPaymentsClientPromise: Promise<AuthenticatedClient> | null = null;
  private config: OpenPaymentsClientConfig;
  private grantTokenManageUrl: string | undefined;

  /**
   * Creates the client.
   *
   * @param config - Wallet address, key pair, and grant token
   */
  constructor(config: OpenPaymentsClientConfig) {
    this.config = { ...config };
    this.grantTokenManageUrl = config.grantTokenManageUrl;
  }

  /**
   * Sends an ILP payment and returns the incoming payment URL as proof.
   *
   * @param x402Version - Protocol version
   * @param paymentRequirements - Payment requirements from the 402 response
   * @param _ - Unused
   * @returns Payment payload result
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const client = await this.getOpenPaymentsClient();
    const serverWalletUrl = paymentRequirements.payTo;

    const serverWalletInfo = await discoverWalletAddress(serverWalletUrl);
    const incomingPaymentToken = await this.requestIncomingPaymentToken(
      client,
      serverWalletInfo.authServer,
      serverWalletUrl,
    );
    const incomingPaymentUrl = await this.createIncomingPaymentWithGrant(
      client,
      serverWalletInfo.resourceServer,
      serverWalletUrl,
      incomingPaymentToken,
      paymentRequirements,
    );

    const clientWalletInfo = await discoverWalletAddress(this.config.clientWalletAddress);
    const quoteId = await this.createQuoteWithGrant(
      client,
      clientWalletInfo.authServer,
      clientWalletInfo.resourceServer,
      incomingPaymentUrl,
    );

    await this.createOutgoingPaymentWithRetry(client, clientWalletInfo.resourceServer, quoteId);

    await waitForCondition(
      () => this.pollIncomingPaymentCompletion(client, incomingPaymentUrl, incomingPaymentToken),
      paymentRequirements.maxTimeoutSeconds * 1000,
      500,
    );

    return {
      x402Version,
      payload: { incomingPaymentUrl },
    };
  }

  /**
   * Returns the current grant token, for tests or external lifecycle management.
   *
   * @returns Current grant token
   */
  getGrantToken(): string {
    return this.config.grantToken;
  }

  /**
   * Updates the grant token and its management URL for rotation.
   *
   * @param grantToken - New grant token
   * @param manageUrl - New management URL for rotation
   */
  updateGrantToken(grantToken: string, manageUrl?: string): void {
    this.config.grantToken = grantToken;
    if (manageUrl) {
      this.grantTokenManageUrl = manageUrl;
    }
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
      walletAddressUrl: this.config.clientWalletAddress,
      ...(this.config.useHttp !== undefined && { useHttp: this.config.useHttp }),
    });
  }

  /**
   * Fetches an incoming payment and returns it if completed, or null to continue polling.
   * Re-throws 4xx errors immediately; swallows transient network failures and 5xx for retry.
   *
   * @param client - SDK client
   * @param incomingPaymentUrl - URL of the incoming payment to fetch
   * @param accessToken - Bearer token with read access
   * @returns Completed payment or null
   */
  private async pollIncomingPaymentCompletion(
    client: AuthenticatedClient,
    incomingPaymentUrl: string,
    accessToken: string,
  ) {
    try {
      const payment = await client.incomingPayment.get({ url: incomingPaymentUrl, accessToken });
      return payment.completed ? payment : null;
    } catch (error) {
      // 4xx errors indicate a real problem (auth failure, payment not found); stop polling.
      if (
        error instanceof OpenPaymentsClientError &&
        error.status !== undefined &&
        error.status < 500
      ) {
        throw error;
      }
      // Network failures and 5xx are transient; return null to retry on the next tick.
      return null;
    }
  }

  /**
   * Requests a non-interactive GNAP grant. Throws if the server requires interaction.
   *
   * @param client - SDK client
   * @param authServerUrl - Auth server URL
   * @param grantBody - Full grant request body
   * @param label - Used in error messages
   * @returns Access token value
   */
  private async requestNonInteractiveGrant(
    client: AuthenticatedClient,
    authServerUrl: string,
    grantBody: GrantBody,
    label: string,
  ): Promise<string> {
    const grantResponse = await client.grant
      .request({ url: authServerUrl }, grantBody)
      .catch(wrapError(`Failed to obtain ${label} grant from ${authServerUrl}`));

    if (isPendingGrant(grantResponse) || !isFinalizedGrantWithAccessToken(grantResponse)) {
      throw new Error(
        `Auth server ${authServerUrl} requires interactive grant for ${label} — ` +
          "ensure the auth server auto-approves this grant type",
      );
    }

    return grantResponse.access_token.value;
  }

  /**
   * Obtains a GNAP grant token for creating and reading incoming payments at the server wallet.
   *
   * @param client - SDK client
   * @param authServerUrl - Server wallet auth server URL
   * @param serverWalletUrl - Server wallet URL (grant scope identifier)
   * @returns Access token
   */
  private async requestIncomingPaymentToken(
    client: AuthenticatedClient,
    authServerUrl: string,
    serverWalletUrl: string,
  ): Promise<string> {
    const grant: GrantBody = {
      access_token: {
        access: [
          { type: "incoming-payment", actions: ["create", "read"], identifier: serverWalletUrl },
        ],
      },
    };
    return this.requestNonInteractiveGrant(
      client,
      authServerUrl,
      grant,
      "incoming-payment:create,read",
    );
  }

  /**
   * Creates an incoming payment at the server wallet using a pre-obtained access token.
   *
   * @param client - SDK client
   * @param resourceServerUrl - Server resource server URL
   * @param serverWalletUrl - Server wallet address
   * @param accessToken - Bearer token with create access
   * @param requirements - Payment requirements
   * @returns Incoming payment URL
   */
  private async createIncomingPaymentWithGrant(
    client: AuthenticatedClient,
    resourceServerUrl: string,
    serverWalletUrl: string,
    accessToken: string,
    requirements: PaymentRequirements,
  ): Promise<string> {
    const incomingPayment = await this.createIncomingPayment(
      client,
      resourceServerUrl,
      serverWalletUrl,
      accessToken,
      requirements,
    );

    if (!incomingPayment.id) {
      throw new Error("Incoming payment response missing id");
    }

    return incomingPayment.id;
  }

  /**
   * Obtains a quote grant and creates a quote for the given incoming payment.
   *
   * @param client - SDK client
   * @param authServerUrl - Client wallet auth server URL
   * @param resourceServerUrl - Client resource server URL
   * @param incomingPaymentUrl - Incoming payment to quote against
   * @returns Quote ID
   */
  private async createQuoteWithGrant(
    client: AuthenticatedClient,
    authServerUrl: string,
    resourceServerUrl: string,
    incomingPaymentUrl: string,
  ): Promise<string> {
    // Separate quote grant needed — ILP_GRANT_TOKEN only covers outgoing-payment:create.
    const quoteGrant: GrantBody = {
      access_token: { access: [{ type: "quote", actions: ["create"] }] },
    };
    const quoteToken = await this.requestNonInteractiveGrant(
      client,
      authServerUrl,
      quoteGrant,
      "quote:create",
    );

    const quote = await client.quote
      .create(
        { url: resourceServerUrl, accessToken: quoteToken },
        {
          walletAddress: this.config.clientWalletAddress,
          receiver: incomingPaymentUrl,
          method: "ilp",
        },
      )
      .catch(wrapError(`Failed to create quote at ${resourceServerUrl}`));

    if (!quote.id) {
      throw new Error("Quote response missing id/url");
    }

    return quote.id;
  }

  /**
   * Creates an incoming payment at the server's resource server.
   *
   * @param client - SDK client
   * @param resourceServerUrl - Resource server URL
   * @param walletAddress - Server wallet address
   * @param accessToken - Bearer token with create access
   * @param requirements - Payment requirements
   * @returns Created incoming payment
   */
  private async createIncomingPayment(
    client: AuthenticatedClient,
    resourceServerUrl: string,
    walletAddress: string,
    accessToken: string,
    requirements: PaymentRequirements,
  ): Promise<{ id: string }> {
    const assetScale = getAssetScaleFromExtra(requirements.extra);
    if (assetScale === undefined) {
      throw new Error(
        "Cannot create incoming payment: assetScale is missing from payment requirements",
      );
    }

    return client.incomingPayment
      .create(
        { url: resourceServerUrl, accessToken },
        {
          walletAddress,
          incomingAmount: {
            value: requirements.amount,
            assetCode: requirements.asset,
            assetScale,
          },
          expiresAt: new Date(Date.now() + requirements.maxTimeoutSeconds * 1000).toISOString(),
        },
      )
      .catch(wrapError(`Failed to create incoming payment at ${resourceServerUrl}`));
  }

  /**
   * Creates an outgoing payment, retrying once on 401/403.
   *
   * @param client - SDK client
   * @param resourceServerUrl - Resource server URL
   * @param quoteId - Quote to fulfil
   * @returns Outgoing payment response
   */
  private async createOutgoingPaymentWithRetry(
    client: AuthenticatedClient,
    resourceServerUrl: string,
    quoteId: string,
  ): Promise<OutgoingPaymentWithSpentAmounts> {
    const body = {
      walletAddress: this.config.clientWalletAddress,
      quoteId,
    };

    return this.withGrantRetry(client, () =>
      client.outgoingPayment.create(
        { url: resourceServerUrl, accessToken: this.config.grantToken },
        body,
      ),
    ).catch(wrapError(`Failed to create outgoing payment at ${resourceServerUrl}`));
  }

  /**
   * Runs `op`, rotating the grant token and retrying once on 401/403.
   * If no management URL is configured, auth errors are re-thrown immediately without a retry.
   *
   * @param client - SDK client
   * @param op - Operation to run
   * @returns Operation result
   */
  private async withGrantRetry<T>(client: AuthenticatedClient, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      if (this.isAuthError(error) && this.grantTokenManageUrl) {
        await this.rotateGrantToken(client);
        return await op();
      }

      throw error;
    }
  }

  /**
   * Rotates the grant token via the management URL. No-op if unset.
   *
   * @param client - SDK client
   */
  private async rotateGrantToken(client: AuthenticatedClient): Promise<void> {
    if (!this.grantTokenManageUrl) {
      return;
    }

    const rotated = await client.token
      .rotate({
        url: this.grantTokenManageUrl,
        accessToken: this.config.grantToken,
      })
      .catch(wrapError(`Failed to rotate grant token at ${this.grantTokenManageUrl}`));
    this.config.grantToken = rotated.access_token.value;
    this.grantTokenManageUrl = rotated.access_token.manage;
  }

  /**
   * Returns true for HTTP 401/403 errors.
   *
   * @param error - Error to inspect
   * @returns True if 401 or 403
   */
  private isAuthError(error: unknown): boolean {
    return (
      error instanceof OpenPaymentsClientError && (error.status === 401 || error.status === 403)
    );
  }
}
