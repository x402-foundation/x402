/**
 * auth-capture wire-format types.
 *
 * Spec-level field names (captureAuthorizer, captureDeadline, refundDeadline,
 * feeRecipient) live here at the extra/wire layer. The onchain PaymentInfo
 * struct keeps the canonical Solidity field names (operator, authorizationExpiry,
 * refundExpiry, feeReceiver) so the EIP-712 typehash stays byte-identical with
 * the AuthCaptureEscrow contract.
 *
 * Salt is NOT in extra. It is generated client-side per signing call and rides
 * on the payload alongside the signature. When salt binding is on, `saltNonce`
 * is added beside `salt`.
 */

import type { PendingSettlementStore } from "@x402/core/facilitator";
import type { TypedData } from "viem";
import type { AssetTransferMethod } from "../types";

export type AuthCapturePaymentFlow = "escrow" | "authorization";
export type AuthCaptureCaptureMode = "sync" | "deferred";
export type AuthCaptureOperatorType = "delegated" | "custom" | "policy";

export interface AuthorizerSigner {
  address: `0x${string}`;
  signTypedData(params: {
    domain: Record<string, unknown>;
    types: TypedData;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

type AuthCaptureLifecycleExtra =
  | {
      paymentFlow?: "escrow";
      captureMode?: AuthCaptureCaptureMode;
      receiverAuthorizer?: `0x${string}`;
    }
  | { paymentFlow: "authorization"; captureMode?: never; receiverAuthorizer?: `0x${string}` };

type AuthCaptureDeadlineExtra =
  | {
      captureDeadline: number;
      refundDeadline: number;
      captureDeadlineSeconds?: never;
      refundDeadlineSeconds?: never;
    }
  | {
      captureDeadlineSeconds: number;
      refundDeadlineSeconds: number;
      captureDeadline?: never;
      refundDeadline?: never;
    };

type AuthCaptureMerchantFeesExtra = {
  feeRecipient: `0x${string}`;
  minFeeBps: number;
  maxFeeBps: number;
  name: string;
  version: string;
  policy?: `0x${string}`;
  assetTransferMethod?: AssetTransferMethod;
};

type AuthCaptureDelegatedRouteExtra = AuthCaptureMerchantFeesExtra & {
  operatorType?: "delegated";
  /** Omitted for delegated routes when the facilitator advertises it on `/supported` extra. */
  captureAuthorizer?: `0x${string}`;
};

type AuthCaptureCustomRouteExtra = AuthCaptureMerchantFeesExtra & {
  operatorType: "custom";
  captureAuthorizer: `0x${string}`;
  /** Collect-only: the facilitator relays no lifecycle, so sync has nothing to finalize with. */
  captureMode?: "deferred";
};

/**
 * Merchant-authored route extra. Correlated optionals are unions so forbidden
 * combinations (captureMode on an authorization route, sync capture on a custom
 * operator, mixed absolute/relative deadlines) are unrepresentable when the
 * literal is checked with `satisfies AuthCaptureRouteExtra`. Escrow sync derives
 * `receiverAuthorizer` from the scheme signer when the route omits it.
 */
export type AuthCaptureRouteExtra = (AuthCaptureDelegatedRouteExtra | AuthCaptureCustomRouteExtra) &
  AuthCaptureLifecycleExtra &
  AuthCaptureDeadlineExtra;

/**
 * Wire extra after `enhancePaymentRequirements`. Deadlines are always absolute.
 * `paymentFlow` / `captureMode` / `receiverAuthorizer` are independent optionals
 * here because the facilitator validates untrusted `Record<string, unknown>`.
 */
export interface AuthCaptureExtra {
  captureAuthorizer: `0x${string}`;
  captureDeadline: number;
  refundDeadline: number;
  feeRecipient: `0x${string}`;
  minFeeBps: number;
  maxFeeBps: number;
  name: string;
  version: string;
  authCaptureEscrow?: `0x${string}`;
  paymentFlow?: AuthCapturePaymentFlow;
  captureMode?: AuthCaptureCaptureMode;
  receiverAuthorizer?: `0x${string}`;
  policy?: `0x${string}`;
  operatorType?: AuthCaptureOperatorType;
  assetTransferMethod?: AssetTransferMethod;
}

export type AuthCaptureFeeTerms = {
  feeRecipient: `0x${string}`;
  minFeeBps: number;
  maxFeeBps: number;
};

export type OperatorAllowlistEntry = {
  address: "*" | `0x${string}`;
  operatorType: "custom";
};

export type AuthCaptureFacilitatorConfig = {
  feeTerms?: AuthCaptureFeeTerms;
  operators?: OperatorAllowlistEntry[];
  receiverAuthorizer?: `0x${string}`;
  /**
   * Max gas for a custom-operator collect relay (`authorize` or `charge`).
   * Used as the verify reject threshold and as a hard broadcast ceiling.
   *
   * @default DEFAULT_CUSTOM_OPERATOR_AUTHORIZE_GAS_LIMIT (1_000_000)
   */
  customOperatorAuthorizeGasLimit?: bigint;
  /**
   * Allowlist of ERC-6492 preparation targets (hex strings, case-insensitive) the
   * facilitator accepts for an undeployed payer wallet.
   *
   * A counterfactual payer has no `isValidSignature` to call, so its signature can only
   * be validated by the onchain simulation, where the canonical token collector deploys
   * the wallet before checking the inner signature. The collector makes that preparation
   * call through Multicall3, so the facilitator is never its sender; the allowlist exists
   * to bound the gas an unknown preparation target can burn. An empty or omitted list
   * rejects every counterfactual payment.
   *
   * @default []
   */
  eip6492AllowedFactories?: string[];
  /**
   * When true, the facilitator relays `type: "refund"` for `"delegated"`
   * operators. Requires an out-of-band funding agreement: refunds pull tokens
   * from `PaymentInfo.operator`. With a rotated submitter set, every address
   * in the rotation must be funded and approved — `OperatorRefundCollector`
   * pulls with `safeTransferFrom(token, PaymentInfo.operator, ...)`.
   *
   * Each submitter also gets its own CREATE2 `TokenStore` on first authorize,
   * so N keys mean N deployment costs and escrow-held balances split N ways.
   */
  refundFunding?: boolean;
  /**
   * Lets a retried settle for the same payload reconcile against an
   * already-broadcast transaction instead of re-verifying and
   * re-broadcasting (see {@link PendingSettlementStore}). Defaults to a
   * fresh in-memory store shared across all settle calls on this scheme
   * instance.
   */
  pendingSettlementStore?: PendingSettlementStore;
};

export type CaptureOptions = {
  feeReceiver?: `0x${string}`;
  feeBps?: number;
  feeAmount?: string;
} & ({ amount?: string; voidRemainder?: false } | { amount: string; voidRemainder: true });

/**
 * Type guard for AuthCaptureExtra. Checks the structural shape an auth-capture
 * scheme requires inside `PaymentRequirements.extra`: every spec-mandated
 * required field present with the right primitive type.
 *
 * @param value - Candidate object from `requirements.extra`.
 * @returns True if `value` has every required AuthCaptureExtra field.
 */
export function isAuthCaptureExtra(value: unknown): value is AuthCaptureExtra {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.captureAuthorizer === "string" &&
    typeof v.captureDeadline === "number" &&
    typeof v.refundDeadline === "number" &&
    typeof v.feeRecipient === "string" &&
    typeof v.minFeeBps === "number" &&
    typeof v.maxFeeBps === "number" &&
    typeof v.name === "string" &&
    typeof v.version === "string"
  );
}

type ChargeCompletionV1_0 = {
  amount: string;
  feeBps: number;
  feeReceiver: `0x${string}`;
  authorizerSignature: `0x${string}`;
};

type ChargeCompletionV1_1 = {
  amount: string;
  feeAmount: string;
  feeReceiver: `0x${string}`;
  authorizerSignature: `0x${string}`;
};

type ChargeCompletion = ChargeCompletionV1_0 | ChargeCompletionV1_1;

type NoChargeCompletion = {
  amount?: never;
  feeBps?: never;
  feeAmount?: never;
  feeReceiver?: never;
  authorizerSignature?: never;
};

type CollectEnvelope<TAuth> =
  | (TAuth & { salt: `0x${string}`; saltNonce?: never; type?: never } & NoChargeCompletion)
  | (TAuth & { salt: `0x${string}`; saltNonce: `0x${string}`; type?: never } & NoChargeCompletion)
  | (TAuth & { salt: `0x${string}`; saltNonce: `0x${string}`; type?: never } & ChargeCompletion);

export type Eip3009Authorization = {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
};

export type Permit2Authorization = {
  from: `0x${string}`;
  permitted: {
    token: `0x${string}`;
    amount: string;
  };
  spender: `0x${string}`;
  nonce: string;
  deadline: string;
};

export type Eip3009Payload = CollectEnvelope<{
  authorization: Eip3009Authorization;
  signature: `0x${string}`;
}>;

export type Permit2Payload = CollectEnvelope<{
  permit2Authorization: Permit2Authorization;
  signature: `0x${string}`;
}>;

export type AuthCaptureCollectPayload = Eip3009Payload | Permit2Payload;

type LifecycleBase = {
  paymentInfo: PaymentInfoStruct;
  saltNonce: `0x${string}`;
  authorizerSignature: `0x${string}`;
};

export type CapturePayload = LifecycleBase & {
  type: "capture";
  amount: string;
  feeReceiver: `0x${string}`;
  expectedCapturableAmount: string;
  expectedRefundableAmount: string;
  voidAuthorizerSignature?: `0x${string}`;
} & ({ feeBps: number; feeAmount?: never } | { feeAmount: string; feeBps?: never });

export type VoidPayload = LifecycleBase & {
  type: "void";
  voidAuthorizerSignature?: never;
};

export type RefundPayload = LifecycleBase & {
  type: "refund";
  amount: string;
  expectedCapturableAmount: string;
  expectedRefundableAmount: string;
  voidAuthorizerSignature?: never;
};

export type AuthCaptureLifecyclePayload = CapturePayload | VoidPayload | RefundPayload;

export type AuthCapturePayload = AuthCaptureCollectPayload | AuthCaptureLifecyclePayload;

/**
 * True when `value` has a collect-payload `type` discriminant of `capture` /
 * `void` / `refund`. Field-level validation happens in the lifecycle verifier.
 *
 * @param value - Candidate payment payload from the wire.
 * @returns True if `value` names a lifecycle operation.
 */
export function isLifecyclePayload(value: unknown): value is AuthCaptureLifecyclePayload {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as Record<string, unknown>).type;
  return type === "capture" || type === "void" || type === "refund";
}

/**
 * Type guard for a capture lifecycle payload.
 *
 * @param value - Candidate payment payload from the wire.
 * @returns True if `value` is a capture envelope with the required fields.
 */
export function isCapturePayload(value: unknown): value is CapturePayload {
  if (!isLifecyclePayload(value) || value.type !== "capture") return false;
  const v = value as Record<string, unknown>;
  const hasFeeBps = typeof v.feeBps === "number";
  const hasFeeAmount = typeof v.feeAmount === "string";
  if (hasFeeBps === hasFeeAmount) return false;
  return (
    isPaymentInfoStruct(v.paymentInfo) &&
    typeof v.saltNonce === "string" &&
    typeof v.amount === "string" &&
    typeof v.feeReceiver === "string" &&
    typeof v.expectedCapturableAmount === "string" &&
    typeof v.expectedRefundableAmount === "string" &&
    typeof v.authorizerSignature === "string" &&
    (v.voidAuthorizerSignature === undefined || typeof v.voidAuthorizerSignature === "string")
  );
}

/**
 * Type guard for a void lifecycle payload.
 *
 * @param value - Candidate payment payload from the wire.
 * @returns True if `value` is a void envelope with the required fields.
 */
export function isVoidPayload(value: unknown): value is VoidPayload {
  if (!isLifecyclePayload(value) || value.type !== "void") return false;
  const v = value as Record<string, unknown>;
  return (
    isPaymentInfoStruct(v.paymentInfo) &&
    typeof v.saltNonce === "string" &&
    typeof v.authorizerSignature === "string" &&
    v.voidAuthorizerSignature === undefined
  );
}

/**
 * Type guard for a refund lifecycle payload.
 *
 * @param value - Candidate payment payload from the wire.
 * @returns True if `value` is a refund envelope with the required fields.
 */
export function isRefundPayload(value: unknown): value is RefundPayload {
  if (!isLifecyclePayload(value) || value.type !== "refund") return false;
  const v = value as Record<string, unknown>;
  return (
    isPaymentInfoStruct(v.paymentInfo) &&
    typeof v.saltNonce === "string" &&
    typeof v.amount === "string" &&
    typeof v.expectedCapturableAmount === "string" &&
    typeof v.expectedRefundableAmount === "string" &&
    typeof v.authorizerSignature === "string" &&
    v.voidAuthorizerSignature === undefined
  );
}

/**
 * Type guard for the onchain PaymentInfo struct shape.
 *
 * @param value - Candidate struct from a lifecycle payload.
 * @returns True if every PaymentInfo field is present with the expected type.
 */
function isPaymentInfoStruct(value: unknown): value is PaymentInfoStruct {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.operator === "string" &&
    typeof v.payer === "string" &&
    typeof v.receiver === "string" &&
    typeof v.token === "string" &&
    typeof v.maxAmount === "string" &&
    typeof v.preApprovalExpiry === "number" &&
    typeof v.authorizationExpiry === "number" &&
    typeof v.refundExpiry === "number" &&
    typeof v.minFeeBps === "number" &&
    typeof v.maxFeeBps === "number" &&
    typeof v.feeReceiver === "string" &&
    typeof v.salt === "string"
  );
}

/**
 * Whether `value` is a 0x-prefixed hex string.
 *
 * @param value - Candidate wire field.
 * @returns True when `value` is hex.
 */
function isHexString(value: unknown): value is `0x${string}` {
  return typeof value === "string" && value.startsWith("0x");
}

/**
 * Parse the four charge-completion fields as an all-or-none group.
 *
 * @param v - Collect payload fields.
 * @returns ChargeCompletion when all four are present and well-typed; undefined when all are absent.
 */
function readChargeCompletion(v: Record<string, unknown>): ChargeCompletion | undefined {
  const hasAny =
    "amount" in v ||
    "feeBps" in v ||
    "feeAmount" in v ||
    "feeReceiver" in v ||
    "authorizerSignature" in v;
  if (!hasAny) return undefined;
  if (
    typeof v.amount === "string" &&
    typeof v.feeBps === "number" &&
    v.feeAmount === undefined &&
    typeof v.feeReceiver === "string" &&
    typeof v.authorizerSignature === "string"
  ) {
    return {
      amount: v.amount,
      feeBps: v.feeBps,
      feeReceiver: v.feeReceiver as `0x${string}`,
      authorizerSignature: v.authorizerSignature as `0x${string}`,
    };
  }
  if (
    typeof v.amount === "string" &&
    typeof v.feeAmount === "string" &&
    v.feeBps === undefined &&
    typeof v.feeReceiver === "string" &&
    typeof v.authorizerSignature === "string"
  ) {
    return {
      amount: v.amount,
      feeAmount: v.feeAmount,
      feeReceiver: v.feeReceiver as `0x${string}`,
      authorizerSignature: v.authorizerSignature as `0x${string}`,
    };
  }
  return undefined;
}

/**
 * Parse collect `salt` and optional `saltNonce`.
 *
 * @param v - Collect payload fields.
 * @returns Unbound or bound salt pair, or undefined when malformed.
 */
function collectExtras(
  v: Record<string, unknown>,
):
  | { salt: `0x${string}`; saltNonce?: never }
  | { salt: `0x${string}`; saltNonce: `0x${string}` }
  | undefined {
  if (!isHexString(v.salt)) return undefined;
  if (v.saltNonce === undefined) {
    return { salt: v.salt };
  }
  if (!isHexString(v.saltNonce)) return undefined;
  return { salt: v.salt, saltNonce: v.saltNonce };
}

/**
 * Type guard for an EIP-3009-shaped auth-capture collect payload. Rejects
 * lifecycle envelopes (`payload.type` set) so `payload.type` remains the
 * discriminant the facilitator dispatches on.
 *
 * @param value - Candidate payment payload from the wire.
 * @returns True if `value` has the EIP-3009 collect envelope shape.
 */
export function isEip3009Payload(value: unknown): value is Eip3009Payload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== undefined) return false;
  if (
    typeof v.authorization !== "object" ||
    v.authorization === null ||
    typeof v.signature !== "string"
  ) {
    return false;
  }
  const saltFields = collectExtras(v);
  if (!saltFields) return false;
  const hasAnyCharge =
    "amount" in v ||
    "feeBps" in v ||
    "feeAmount" in v ||
    "feeReceiver" in v ||
    "authorizerSignature" in v;
  if (hasAnyCharge) {
    if (!saltFields.saltNonce) return false;
    return readChargeCompletion(v) !== undefined;
  }
  return true;
}

/**
 * Type guard for a Permit2-shaped auth-capture collect payload.
 *
 * @param value - Candidate payment payload from the wire.
 * @returns True if `value` has the Permit2 collect envelope shape.
 */
export function isPermit2Payload(value: unknown): value is Permit2Payload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== undefined) return false;
  if (typeof v.signature !== "string") return false;
  if (typeof v.permit2Authorization !== "object" || v.permit2Authorization === null) return false;
  const a = v.permit2Authorization as Record<string, unknown>;
  if (
    typeof a.from !== "string" ||
    typeof a.spender !== "string" ||
    typeof a.nonce !== "string" ||
    typeof a.deadline !== "string" ||
    typeof a.permitted !== "object" ||
    a.permitted === null
  ) {
    return false;
  }
  const saltFields = collectExtras(v);
  if (!saltFields) return false;
  const hasAnyCharge =
    "amount" in v ||
    "feeBps" in v ||
    "feeAmount" in v ||
    "feeReceiver" in v ||
    "authorizerSignature" in v;
  if (hasAnyCharge) {
    if (!saltFields.saltNonce) return false;
    return readChargeCompletion(v) !== undefined;
  }
  return true;
}

/**
 * Type guard for a collect (authorize/charge) payload of either envelope.
 *
 * @param value - Candidate payment payload from the wire.
 * @returns True if `value` is an EIP-3009 or Permit2 collect envelope.
 */
export function isAuthCaptureCollectPayload(value: unknown): value is AuthCaptureCollectPayload {
  return isEip3009Payload(value) || isPermit2Payload(value);
}

/**
 * Type guard for any auth-capture payload: collect or lifecycle.
 *
 * @param value - Candidate payment payload from the wire.
 * @returns True if `value` is a valid auth-capture envelope.
 */
export function isAuthCapturePayload(value: unknown): value is AuthCapturePayload {
  if (isLifecyclePayload(value)) {
    return isCapturePayload(value) || isVoidPayload(value) || isRefundPayload(value);
  }
  return isAuthCaptureCollectPayload(value);
}

/**
 * Onchain PaymentInfo struct (canonical Solidity names — DO NOT RENAME).
 * Reconstructed by the facilitator from extra + payload.salt + payer + receiver/asset/amount.
 */
export interface PaymentInfoStruct {
  operator: `0x${string}`;
  payer: `0x${string}`;
  receiver: `0x${string}`;
  token: `0x${string}`;
  maxAmount: string;
  preApprovalExpiry: number;
  authorizationExpiry: number;
  refundExpiry: number;
  minFeeBps: number;
  maxFeeBps: number;
  feeReceiver: `0x${string}`;
  salt: `0x${string}`;
}

export interface PaymentState {
  hasCollectedPayment: boolean;
  capturableAmount: bigint;
  refundableAmount: bigint;
}
