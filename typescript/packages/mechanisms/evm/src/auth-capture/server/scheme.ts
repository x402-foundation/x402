/**
 * AuthCapture Scheme - Server
 * Handles price parsing, requirement enhancement, and payment-flow selection.
 */

import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemeServerHooks,
  SupportedKind,
} from "@x402/core/types";
import type { FacilitatorClient, VerifiedPaymentCanceledContext } from "@x402/core/server";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { getAddress, isAddressEqual, zeroAddress } from "viem";
import { findDefaultAsset, getDefaultAsset } from "../../defaultAssets";
import type { AssetTransferMethod } from "../../types";
import { AUTH_CAPTURE_SCHEME } from "../constants";
import { canonicalAuthCaptureEscrow } from "../extra";
import { isNonZeroAddress } from "../nonce";
import type { AuthorizerSigner } from "../types";
import { AuthCaptureLifecycleManager } from "./lifecycleManager";
import { AuthCaptureSettlementHooks } from "./settlementHooks";
import { InMemoryAuthorizedPaymentStorage, type AuthorizedPaymentStorage } from "./storage";

export interface AuthCaptureServerConfig {
  storage?: AuthorizedPaymentStorage;
  receiverAuthorizerSigner?: AuthorizerSigner;
  /**
   * When true, skip startup checks that the facilitator advertises
   * `extra.receiverAuthorizer` when no local signer is configured. Use only when
   * every route is collect-only (escrow + deferred + explicit `receiverAuthorizer:
   * zeroAddress`).
   */
  collectOnlyRoutes?: boolean;
}

/** Align relative deadline conversion so repeated 402s in the same minute share values. */
const DEADLINE_OFFSET_BUCKET_SECONDS = 60;

const AUTH_CAPTURE_MERCHANT_FIELD_HINTS: Record<string, string> = {
  captureAuthorizer:
    ' For operatorType "delegated", omit extra.captureAuthorizer so the scheme copies it from ' +
    "the facilitator's /supported extra.captureAuthorizer.",
  captureDeadline:
    " Set extra.captureDeadlineSeconds (relative, recommended) or extra.captureDeadline (absolute).",
  refundDeadline:
    " Set extra.refundDeadlineSeconds (relative, recommended) or extra.refundDeadline (absolute).",
};

/**
 * Validate a relative-offset extras key and resolve it to an absolute Unix
 * second. Returns `undefined` when the key is absent. Throws on a present-
 * but-invalid value so the merchant gets a clear error at the layer they
 * configured it, rather than a downstream facilitator rejection with a
 * cryptic reason.
 *
 * @param extras - Merged `extra` map being assembled for publication.
 * @param key - The relative-offset key to read (e.g. `"captureDeadlineSeconds"`).
 * @param now - Unix-second clock value used for the conversion.
 * @returns Absolute Unix-second deadline, or `undefined` if the key wasn't set.
 * @throws If `extras[key]` is present but not a finite positive number.
 */
function resolveOffsetToDeadline(
  extras: Record<string, unknown>,
  key: string,
  now: number,
): number | undefined {
  const raw = extras[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(
      `extra.${key} must be a positive finite number of seconds-from-now (got ${String(raw)})`,
    );
  }
  return now + raw;
}

/**
 * Assert that the merged `extra` carries every field that comes from the
 * merchant's route config.
 *
 * @param extra - The merged `extra` map about to be returned by `enhancePaymentRequirements`.
 * @throws With a message naming the first missing or wrongly-typed merchant field.
 */
function assertAuthCaptureMerchantExtraComplete(extra: Record<string, unknown>): void {
  const required: Array<[string, "string" | "number"]> = [
    ["captureAuthorizer", "string"],
    ["captureDeadline", "number"],
    ["refundDeadline", "number"],
    ["feeRecipient", "string"],
    ["minFeeBps", "number"],
    ["maxFeeBps", "number"],
  ];
  for (const [key, expectedType] of required) {
    if (typeof extra[key] !== expectedType) {
      const hint = AUTH_CAPTURE_MERCHANT_FIELD_HINTS[key] ?? "";
      throw new Error(`AuthCapture requires extra.${key} (${expectedType}).${hint}`);
    }
  }
}

/**
 * A non-empty string `extra` value as a checksummed address.
 *
 * @param value - Untrusted `extra` field.
 * @returns The address, or undefined when absent or empty.
 */
function nonEmptyAddress(value: unknown): `0x${string}` | undefined {
  return typeof value === "string" && value.length > 0 ? getAddress(value) : undefined;
}

/**
 * Server-side implementation of the auth-capture scheme.
 */
export class AuthCaptureEvmScheme implements SchemeNetworkServer {
  readonly scheme = AUTH_CAPTURE_SCHEME;
  readonly dynamicExtraFields = ["captureDeadline", "refundDeadline"];
  readonly defaultAssetTransferMethod: AssetTransferMethod = "eip3009";
  readonly paymentFlows = {
    eip3009: { supported: ["escrow", "authorization"], default: "escrow" },
    permit2: { supported: ["escrow", "authorization"], default: "escrow" },
  } as const satisfies Record<AssetTransferMethod, PaymentFlowConfig>;
  readonly schemeHooks: SchemeServerHooks;
  readonly enrichSettlementPayload: (
    ctx: Parameters<AuthCaptureSettlementHooks["enrichSettlementPayload"]>[0],
  ) => Promise<Record<string, unknown> | void>;

  private moneyParsers: MoneyParser[] = [];
  private readonly storage: AuthorizedPaymentStorage;
  private readonly receiverAuthorizerSigner: AuthorizerSigner | undefined;
  private readonly collectOnlyRoutes: boolean;
  private readonly settlementHooks: AuthCaptureSettlementHooks;

  /**
   * Construct a server-side auth-capture scheme.
   *
   * @param config - Optional storage and receiver-authorizer signer.
   */
  constructor(config?: AuthCaptureServerConfig) {
    this.storage = config?.storage ?? new InMemoryAuthorizedPaymentStorage();
    this.receiverAuthorizerSigner = config?.receiverAuthorizerSigner;
    this.collectOnlyRoutes = config?.collectOnlyRoutes === true;
    this.settlementHooks = new AuthCaptureSettlementHooks({
      storage: this.storage,
      receiverAuthorizerSigner: this.receiverAuthorizerSigner,
    });
    this.schemeHooks = {
      onBeforeSettle: ctx => this.settlementHooks.handleBeforeSettle(ctx),
      onAfterSettle: ctx => this.settlementHooks.handleAfterSettle(ctx),
    };
    this.enrichSettlementPayload = ctx => this.settlementHooks.enrichSettlementPayload(ctx);
  }

  /**
   * Add a custom money parser to the chain. Parsers run in registration order;
   * the first one to return a non-null `AssetAmount` wins.
   *
   * @param parser - Function that maps a decimal amount to an `AssetAmount`, or `null` to defer.
   * @returns This server scheme instance, for fluent chaining.
   */
  registerMoneyParser(parser: MoneyParser): AuthCaptureEvmScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Decimals for a known default asset, or undefined.
   *
   * @param asset - Asset address or symbol
   * @param network - Target network
   * @returns Decimals when the asset is a known default; otherwise undefined
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    return findDefaultAsset(asset, network)?.decimals;
  }

  /**
   * Translate a merchant-supplied `Price` into a fully-resolved `AssetAmount`.
   *
   * @param price - `"$0.01"` / `0.01` / `{ asset, amount }`.
   * @param network - CAIP-2 network identifier used for default-asset lookup.
   * @returns The resolved `AssetAmount` containing token address and base units.
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      }
      return {
        amount: price.amount,
        asset: price.asset,
        extra: price.extra || {},
      };
    }

    const { amount, symbol } = parseMoney(price);

    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    return this.defaultMoneyConversion(amount, network, symbol);
  }

  /**
   * Merge facilitator-advertised `extra` into the merchant's payment
   * requirements, resolve relative deadline offsets into absolute deadlines,
   * write the resolved `paymentFlow` / `captureMode`, and fail-fast on
   * misconfiguration.
   *
   * @param requirements - The merchant-authored payment requirements.
   * @param supportedKind - The facilitator's advertised support entry.
   * @param supportedKind.x402Version - Protocol version the facilitator advertises.
   * @param supportedKind.scheme - Scheme identifier (`"auth-capture"`).
   * @param supportedKind.network - CAIP-2 network identifier.
   * @param supportedKind.extra - Facilitator-injected `extra` fields (lowest priority on collision).
   * @param _ - Unused list of facilitator extensions (interface compatibility).
   * @returns Enhanced `PaymentRequirements` with merged `extra` and resolved deadlines.
   */
  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    _: string[],
  ): Promise<PaymentRequirements> {
    const merged: Record<string, unknown> = {
      ...supportedKind.extra,
      ...requirements.extra,
    };

    if ("autoCapture" in merged) {
      throw new Error(
        "AuthCapture extra.autoCapture was removed in v1.1. Use extra.paymentFlow " +
          '("escrow" or "authorization") instead.',
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const deadlineBase =
      Math.floor(now / DEADLINE_OFFSET_BUCKET_SECONDS) * DEADLINE_OFFSET_BUCKET_SECONDS;
    const hasAbsCapture = typeof merged.captureDeadline === "number";
    const hasAbsRefund = typeof merged.refundDeadline === "number";
    const hasRelCapture = merged.captureDeadlineSeconds !== undefined;
    const hasRelRefund = merged.refundDeadlineSeconds !== undefined;
    const absPair = hasAbsCapture && hasAbsRefund;
    const relPair = hasRelCapture && hasRelRefund;

    if (absPair && relPair) {
      throw new Error(
        "AuthCapture extra must use either both absolute deadlines (captureDeadline and " +
          "refundDeadline) or both relative offsets (captureDeadlineSeconds and " +
          "refundDeadlineSeconds), not a mix.",
      );
    }
    if (
      (hasAbsCapture !== hasAbsRefund || hasRelCapture !== hasRelRefund) &&
      !(absPair || relPair)
    ) {
      throw new Error(
        "AuthCapture extra must use either both absolute deadlines (captureDeadline and " +
          "refundDeadline) or both relative offsets (captureDeadlineSeconds and " +
          "refundDeadlineSeconds), not a mix.",
      );
    }

    const captureFromOffset = resolveOffsetToDeadline(
      merged,
      "captureDeadlineSeconds",
      deadlineBase,
    );
    const refundFromOffset = resolveOffsetToDeadline(merged, "refundDeadlineSeconds", deadlineBase);
    delete merged.captureDeadlineSeconds;
    delete merged.refundDeadlineSeconds;

    if (!absPair) {
      if (captureFromOffset !== undefined) merged.captureDeadline = captureFromOffset;
      if (refundFromOffset !== undefined) merged.refundDeadline = refundFromOffset;
    }

    const operatorType = merged.operatorType ?? "delegated";
    if (operatorType === "custom") {
      const merchantSet = requirements.extra?.captureAuthorizer;
      if (typeof merchantSet !== "string" || merchantSet.length === 0) {
        delete merged.captureAuthorizer;
      }
    }

    assertAuthCaptureMerchantExtraComplete(merged);

    merged.receiverAuthorizer = this.resolveReceiverAuthorizer(
      requirements.extra?.receiverAuthorizer,
      supportedKind.extra?.receiverAuthorizer,
    );

    const paymentFlow = merged.paymentFlow === "authorization" ? "authorization" : "escrow";
    merged.paymentFlow = paymentFlow;

    const collectOnly = !isNonZeroAddress(merged.receiverAuthorizer as `0x${string}`);
    if (paymentFlow === "authorization") {
      if (merged.captureMode !== undefined) {
        throw new Error(
          'AuthCapture extra.captureMode is only valid with paymentFlow "escrow"; ' +
            "authorization has no hold to finalize.",
        );
      }
      if (collectOnly) {
        throw new Error(
          'AuthCapture paymentFlow "authorization" requires a non-zero receiverAuthorizer ' +
            "(extra.receiverAuthorizer: zeroAddress is collect-only, valid only for escrow with " +
            'captureMode "deferred")',
        );
      }
    } else {
      const captureMode = merged.captureMode === "deferred" ? "deferred" : "sync";
      merged.captureMode = captureMode;
      if (captureMode === "sync" && operatorType === "custom") {
        throw new Error('AuthCapture operatorType "custom" is collect-only');
      }
      if (captureMode === "sync" && collectOnly) {
        throw new Error(
          "AuthCapture escrow sync routes require a non-zero receiverAuthorizer " +
            '(extra.receiverAuthorizer: zeroAddress is collect-only, valid only with captureMode "deferred")',
        );
      }
    }

    // Facilitator-only allowlist from GET /supported — not part of the 402 wire.
    delete merged.operators;

    merged.authCaptureEscrow = canonicalAuthCaptureEscrow(
      typeof merged.authCaptureEscrow === "string" ? merged.authCaptureEscrow : undefined,
    );

    return { ...requirements, extra: merged };
  }

  /**
   * On handler failure after a before-handler authorize, settle a void.
   *
   * @param context - Cancellation context.
   * @returns Requirements to settle, or void when there is no hold to release.
   */
  settleOnCancel(context: VerifiedPaymentCanceledContext): Promise<PaymentRequirements | void> {
    return this.settlementHooks.settleOnCancel(context);
  }

  /**
   * Returns the authorized-payment storage backend.
   *
   * @returns The configured {@link AuthorizedPaymentStorage}.
   */
  getStorage(): AuthorizedPaymentStorage {
    return this.storage;
  }

  /**
   * Returns the receiver-authorizer signer, if configured.
   *
   * @returns Receiver-authorizer signer, or `undefined` when not set.
   */
  getReceiverAuthorizerSigner(): AuthorizerSigner | undefined {
    return this.receiverAuthorizerSigner;
  }

  /**
   * Create a facilitator-bound manager for out-of-band capture / void / refund.
   *
   * @param facilitator - Facilitator client used to POST lifecycle settles.
   * @returns A lifecycle manager reading storage and the signer from this scheme.
   */
  createLifecycleManager(facilitator: FacilitatorClient): AuthCaptureLifecycleManager {
    return new AuthCaptureLifecycleManager({ scheme: this, facilitator });
  }

  /**
   * Fail server startup when the facilitator does not advertise a usable
   * `captureAuthorizer`, or when this server delegates receiver signing but the
   * facilitator does not advertise a non-zero `receiverAuthorizer`.
   *
   * @param network - The network identifier being validated.
   * @param supportedKind - The facilitator's advertised kind for this scheme/network.
   * @param _ - Extensions advertised by the facilitator (unused).
   * @returns A problem message when misconfigured, or void when valid.
   */
  validateFacilitatorSupport(
    network: Network,
    supportedKind: SupportedKind,
    _: string[],
  ): string | void {
    const captureAuthorizer = supportedKind.extra?.captureAuthorizer;
    if (typeof captureAuthorizer !== "string" || !isNonZeroAddress(getAddress(captureAuthorizer))) {
      return (
        `facilitator does not advertise a valid captureAuthorizer for auth-capture on ${network}; ` +
        `delegated routes copy it from GET /supported extra.captureAuthorizer`
      );
    }

    if (this.receiverAuthorizerSigner || this.collectOnlyRoutes) {
      return;
    }

    const advertised = supportedKind.extra?.receiverAuthorizer;
    const hasValidReceiver =
      typeof advertised === "string" && isNonZeroAddress(getAddress(advertised));

    if (!hasValidReceiver) {
      return (
        `no receiverAuthorizerSigner is configured and the facilitator does not advertise a ` +
        `receiverAuthorizer on ${network}. Configure a receiverAuthorizerSigner, use a ` +
        `facilitator that advertises one, or set collectOnlyRoutes: true when every route is ` +
        `collect-only (escrow + deferred + extra.receiverAuthorizer zeroAddress).`
      );
    }
  }

  /**
   * Resolve who authorizes facilitator-relayed `charge` and lifecycle, strictly and in order:
   * the scheme signer (self-managed); else the route's own `receiverAuthorizer` (`zeroAddress`
   * is explicit collect-only, the facilitator-advertised address is delegated, anything else
   * has no way to be signed); else the facilitator-advertised address. Throws instead of
   * silently falling back to collect-only.
   *
   * @param routeReceiverAuthorizer - `receiverAuthorizer` from the route's `extra`.
   * @param advertisedReceiverAuthorizer - `receiverAuthorizer` from the facilitator's `/supported` extra.
   * @returns The checksummed address to publish in `extra.receiverAuthorizer`.
   * @throws If no signer, route value, or facilitator advertisement can produce signatures.
   */
  private resolveReceiverAuthorizer(
    routeReceiverAuthorizer: unknown,
    advertisedReceiverAuthorizer: unknown,
  ): `0x${string}` {
    const route = nonEmptyAddress(routeReceiverAuthorizer);
    const advertised = nonEmptyAddress(advertisedReceiverAuthorizer);
    const advertisedNonZero = advertised && isNonZeroAddress(advertised) ? advertised : undefined;

    const signerAddress = this.receiverAuthorizerSigner?.address;
    if (signerAddress) {
      if (route && isNonZeroAddress(route) && !isAddressEqual(route, signerAddress)) {
        throw new Error(
          `AuthCapture extra.receiverAuthorizer (${route}) does not match the ` +
            `scheme's receiverAuthorizerSigner (${signerAddress}).`,
        );
      }
      return getAddress(signerAddress);
    }

    if (route) {
      if (!isNonZeroAddress(route)) return zeroAddress;
      if (advertisedNonZero && isAddressEqual(route, advertisedNonZero)) return route;
      throw new Error(
        `AuthCapture extra.receiverAuthorizer (${route}) can not be signed: the scheme has no ` +
          "receiverAuthorizerSigner and the facilitator does not advertise that address. " +
          "Configure a receiverAuthorizerSigner, omit the field to use the facilitator's " +
          'authorizer, or set it to zeroAddress for collect-only with captureMode "deferred".',
      );
    }

    if (advertisedNonZero) return advertisedNonZero;
    throw new Error(
      "AuthCapture has no receiverAuthorizer: the route sets none, the scheme has no " +
        "receiverAuthorizerSigner, and the facilitator advertises none. Fix one of: " +
        "(1) configure a receiverAuthorizerSigner on the scheme, " +
        "(2) use a facilitator that delegates the authorizer (advertises extra.receiverAuthorizer), " +
        'or (3) set extra.receiverAuthorizer to zeroAddress with captureMode "deferred" (collect-only).',
    );
  }

  /**
   * Fall-through converter: resolves a decimal amount against the default
   * asset registered for the network in `getDefaultAsset`.
   *
   * @param amount - Decimal amount in the token's display units.
   * @param network - CAIP-2 network identifier.
   * @param symbol - Optional ticker from a suffixed price.
   * @returns Resolved `AssetAmount` with the network's default asset.
   */
  private defaultMoneyConversion(amount: string, network: Network, symbol?: string): AssetAmount {
    const assetInfo = getDefaultAsset(network, symbol);
    const tokenAmount = convertToTokenAmount(amount, assetInfo.decimals);
    const includeEip712Domain = !assetInfo.assetTransferMethod || assetInfo.supportsEip2612;
    return {
      asset: assetInfo.asset,
      amount: tokenAmount,
      extra: {
        ...(includeEip712Domain && {
          name: assetInfo.name,
          version: assetInfo.version,
        }),
        ...(assetInfo.assetTransferMethod && {
          assetTransferMethod: assetInfo.assetTransferMethod,
        }),
      },
    };
  }
}
