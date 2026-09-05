import { SettleResponse, SupportedKind, VerifyResponse } from "./facilitator";
import { PaymentPayload, PaymentRequired, PaymentRequirements, ResourceInfo } from "./payments";
import { Price, Network, AssetAmount } from ".";
import { FacilitatorExtension } from "./extensions";
import type { DeepReadonly } from "./readonly";
import type {
  BeforeVerifyHook,
  AfterVerifyHook,
  BeforeSettleHook,
  AfterSettleHook,
  OnVerifyFailureHook,
  OnSettleFailureHook,
  OnVerifiedPaymentCanceledHook,
  SettleContext,
  SettleResultContext,
  VerifiedPaymentCanceledContext,
} from "../server/x402ResourceServer";
import type {
  BeforePaymentCreationHook,
  AfterPaymentCreationHook,
  OnPaymentCreationFailureHook,
  OnPaymentResponseHook,
} from "../client/x402Client";

/**
 * Money parser that converts a decimal amount to an AssetAmount.
 * `parsePrice` always passes the decimal string produced by parseMoney.
 * Returns null to indicate "cannot handle this amount", causing fallback to next parser.
 * Always returns a Promise for consistency - use async/await
 *
 * @param amount - Decimal amount as a string (or number, if the parser is called directly)
 * @param network - The network identifier for context
 * @returns AssetAmount or null to try next parser
 */
export type MoneyParser = (
  amount: string | number,
  network: Network,
) => Promise<AssetAmount | null>;

/**
 * Result of createPaymentPayload - the core payload fields.
 * Contains the x402 version, scheme-specific payload data, and optional extension data.
 * Schemes may return extensions (e.g., EIP-2612 gas sponsoring) that get merged
 * with server-declared extensions in the final PaymentPayload.
 */
export type PaymentPayloadResult = Pick<PaymentPayload, "x402Version" | "payload"> & {
  extensions?: Record<string, unknown>;
};

/**
 * Context passed to scheme `createPaymentPayload`.
 * `maxAmountPerPayment` is the resolved atomic spend cap; omitted when uncapped.
 */
export interface PaymentPayloadContext {
  extensions?: Record<string, unknown>;
  maxAmountPerPayment?: string;
}

export interface SchemeClientHooks {
  onBeforePaymentCreation?: BeforePaymentCreationHook;
  onAfterPaymentCreation?: AfterPaymentCreationHook;
  onPaymentCreationFailure?: OnPaymentCreationFailureHook;
  onPaymentResponse?: OnPaymentResponseHook;
}

/** USD-pegged asset for money strings and client spend caps. See DEFAULT_ASSETS.md. */
export interface DefaultAsset {
  /** Asset id as advertised in payment requirements. */
  asset: string;
  decimals: number;
  /** Ticker for suffixed prices (e.g. `"0.10 USDC"`). */
  symbol: string;
}

/** Per-network default assets; index 0 is the bare `"$0.10"` default. */
export type DefaultAssetTable<T extends DefaultAsset = DefaultAsset> = Record<string, readonly T[]>;

/** `(network, symbol?) => entry`; throws when unknown. */
export type GetDefaultAsset<T extends DefaultAsset = DefaultAsset> = (
  network: Network,
  symbol?: string,
) => T;

/** `(asset, network) => entry | undefined`. */
export type FindDefaultAsset<T extends DefaultAsset = DefaultAsset> = (
  asset: string,
  network: Network,
) => T | undefined;

export interface SchemeNetworkClient {
  readonly scheme: string;
  readonly schemeHooks?: SchemeClientHooks;

  /** Optional reverse lookup for USD spend caps. Not the same as `getAssetDecimals`. */
  findDefaultAsset?: FindDefaultAsset;

  createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult>;
}

/**
 * Context passed to SchemeNetworkFacilitator.verify/settle, providing
 * access to registered facilitator extensions. Mechanism implementations
 * use this to retrieve extension-provided capabilities (e.g., a batch signer).
 */
export interface FacilitatorContext {
  getExtension<T extends FacilitatorExtension = FacilitatorExtension>(key: string): T | undefined;
}

export interface SchemeNetworkFacilitator {
  readonly scheme: string;

  /**
   * CAIP family pattern that this facilitator supports.
   * Used to group signers by blockchain family in the supported response.
   *
   * @example
   * // EVM facilitators
   * readonly caipFamily = "eip155:*";
   *
   * @example
   * // SVM facilitators
   * readonly caipFamily = "solana:*";
   */
  readonly caipFamily: string;

  /**
   * Get mechanism-specific extra data needed for the supported kinds endpoint.
   * This method is called when building the facilitator's supported response.
   *
   * @param network - The network identifier for context
   * @returns Extra data object or undefined if no extra data is needed
   *
   * @example
   * // EVM schemes return undefined (no extra data needed)
   * getExtra(network: Network): undefined {
   *   return undefined;
   * }
   *
   * @example
   * // SVM schemes return feePayer address
   * getExtra(network: Network): Record<string, unknown> | undefined {
   *   return { feePayer: this.signer.address };
   * }
   */
  getExtra(network: Network): Record<string, unknown> | undefined;

  /**
   * Get signer addresses used by this facilitator for a given network.
   * These are included in the supported response to help clients understand
   * which addresses might sign/pay for transactions.
   *
   * Supports multiple addresses for load balancing, key rotation, and high availability.
   *
   * @param network - The network identifier
   * @returns Array of signer addresses (wallet addresses, fee payer addresses, etc.)
   *
   * @example
   * // EVM facilitator
   * getSigners(network: string): string[] {
   *   return [...this.signer.getAddresses()];
   * }
   *
   * @example
   * // SVM facilitator
   * getSigners(network: string): string[] {
   *   return [...this.signer.getAddresses()];
   * }
   */
  getSigners(network: string): string[];

  verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<VerifyResponse>;
  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse>;
}

export interface SchemeServerHooks {
  onBeforeVerify?: BeforeVerifyHook;
  onAfterVerify?: AfterVerifyHook;
  onBeforeSettle?: BeforeSettleHook;
  onAfterSettle?: AfterSettleHook;
  onVerifyFailure?: OnVerifyFailureHook;
  onSettleFailure?: OnSettleFailureHook;
  onVerifiedPaymentCanceled?: OnVerifiedPaymentCanceledHook;
}

export type SchemeEnrichSettlementPayloadHook = (
  ctx: SettleContext,
) => Promise<Record<string, unknown> | void>;

export type SchemeEnrichSettlementResponseHook = (
  ctx: SettleResultContext,
) => Promise<Record<string, unknown> | void>;

export interface SchemePaymentRequiredContext {
  requirements: PaymentRequirements[];
  paymentPayload?: DeepReadonly<PaymentPayload>;
  resourceInfo: ResourceInfo;
  error?: string;
  paymentRequiredResponse: PaymentRequired;
  transportContext?: unknown;
}

export type SchemeEnrichPaymentRequiredResponseHook = (
  ctx: SchemePaymentRequiredContext,
) => Promise<PaymentRequirements[] | void>;

/**
 * Named payment flow declared by a scheme. Controls whether core verifies and/or
 * settles before the resource handler, and whether it settles after.
 *
 * Multi-settle flows (`escrow`) fire settle lifecycle hooks once per settle.
 * Side-effecting hooks should branch on {@link SettleContext.phase}.
 */
export type PaymentFlowName = "authorization" | "upfront" | "escrow";

/**
 * Phase flags for a {@link PaymentFlowName}.
 */
export interface PaymentFlowPhases {
  verifyBeforeHandler: boolean;
  settleBeforeHandler: boolean;
  settleAfterHandler: boolean;
}

/**
 * Supported payment flows for one assetTransferMethod, plus the default when
 * `extra.paymentFlow` is omitted.
 */
export interface PaymentFlowConfig {
  readonly supported: readonly PaymentFlowName[];
  /** Must be a member of {@link PaymentFlowConfig.supported}. */
  readonly default: PaymentFlowName;
}

export interface SchemeNetworkServer {
  readonly scheme: string;
  /**
   * ATM used when `requirements.extra.assetTransferMethod` is absent.
   * Use `"default"` only as SDK plumbing when the scheme has no on-wire ATM.
   */
  readonly defaultAssetTransferMethod: string;
  /**
   * Payment flows supported per assetTransferMethod.
   * Every ATM the scheme accepts must appear here.
   */
  readonly paymentFlows: Readonly<Record<string, PaymentFlowConfig>>;
  readonly schemeHooks?: SchemeServerHooks;
  readonly dynamicExtraFields?: string[];
  enrichPaymentRequiredResponse?: SchemeEnrichPaymentRequiredResponseHook;
  enrichSettlementPayload?: SchemeEnrichSettlementPayloadHook;
  enrichSettlementResponse?: SchemeEnrichSettlementResponseHook;

  /**
   * Optional: return payment requirements to settle when a verified payment is
   * canceled (handler failure/throw or post-verify abort). Core calls
   * `settlePayment` with the returned requirements; return void to skip settle.
   *
   * @param context - Cancellation context for the verified payment
   * @returns Requirements to settle, or void to leave the payment unsettled
   */
  settleOnCancel?(
    context: VerifiedPaymentCanceledContext,
  ): PaymentRequirements | void | Promise<PaymentRequirements | void>;

  /**
   * Convert a user-friendly price to the scheme's specific amount and asset format
   * Always returns a Promise for consistency
   *
   * @param price - User-friendly price (e.g., "$0.10", "0.10", { amount: "100000", asset: "USDC" })
   * @param network - The network identifier for context
   * @returns Promise that resolves to the converted amount, asset identifier, and any extra metadata
   *
   * @example
   * // For EVM networks with USDC:
   * await parsePrice("$0.10", "eip155:8453") => { amount: "100000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }
   *
   * // For custom schemes:
   * await parsePrice("10 points", "custom:network") => { amount: "10", asset: "points" }
   */
  parsePrice(price: Price, network: Network): Promise<AssetAmount>;

  /**
   * Optional asset decimals for `$…` settlement overrides. Core throws when
   * this is missing or returns undefined
   *
   * @param asset - Asset address or symbol
   * @param network - Network identifier
   * @returns Decimal places, or undefined when unknown
   */
  getAssetDecimals?(asset: string, network: Network): number | undefined;

  /**
   * Build payment requirements for this scheme/network combination
   *
   * @param paymentRequirements - Base payment requirements with amount/asset already set
   * @param supportedKind - The supported kind from facilitator's /supported endpoint
   * @param supportedKind.x402Version - The x402 version
   * @param supportedKind.scheme - The payment scheme
   * @param supportedKind.network - The network identifier
   * @param supportedKind.extra - Optional extra metadata
   * @param facilitatorExtensions - Extensions supported by the facilitator
   * @returns Enhanced payment requirements ready to be sent to clients
   */
  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    facilitatorExtensions: string[],
  ): Promise<PaymentRequirements>;

  /**
   * Optional: validate that the facilitator's advertised capabilities for this
   * scheme/network are sufficient given the scheme's own configuration. Invoked
   * during initialize(), only when the facilitator supports the scheme.
   *
   * @param network - The network identifier being validated
   * @param supportedKind - The facilitator's advertised kind for this scheme/network
   * @param facilitatorExtensions - Extensions advertised by the facilitator
   * @returns A human-readable problem message when the configuration cannot be
   *   fulfilled, or void/undefined when valid.
   */
  validateFacilitatorSupport?(
    network: Network,
    supportedKind: SupportedKind,
    facilitatorExtensions: string[],
  ): string | void;
}
