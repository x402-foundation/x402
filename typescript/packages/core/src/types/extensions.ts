import type { VerifyResponse, SettleResponse } from "./facilitator";
import type {
  PaymentRequiredContext,
  SettleResultContext,
  VerifyContext,
  VerifyResultContext,
  VerifyFailureContext,
  SettleContext,
  SettleFailureContext,
  VerifiedPaymentCanceledContext,
} from "../server/x402ResourceServer";

export type {
  PaymentRequiredContext,
  SettleResultContext,
  VerifyContext,
  VerifyResultContext,
  VerifyFailureContext,
  SettleContext,
  SettleFailureContext,
  VerifiedPaymentCanceledContext,
};

export interface FacilitatorExtension {
  key: string;
}

/**
 * Per-extension verify/settle hooks. Contexts are **read-only** for core protocol fields; use
 * **abort** / **recover** return values instead of mutating `paymentPayload`, `requirements`, etc.
 */
export interface ResourceServerExtensionHooks {
  onBeforeVerify?: (
    declaration: unknown,
    context: VerifyContext,
  ) => Promise<
    | void
    | { abort: true; reason: string; message?: string }
    | { skip: true; result: VerifyResponse }
  >;
  onAfterVerify?: (declaration: unknown, context: VerifyResultContext) => Promise<void>;
  onVerifyFailure?: (
    declaration: unknown,
    context: VerifyFailureContext,
  ) => Promise<void | { recovered: true; result: VerifyResponse }>;
  onBeforeSettle?: (
    declaration: unknown,
    context: SettleContext,
  ) => Promise<
    | void
    | { abort: true; reason: string; message?: string }
    | { skip: true; result: SettleResponse }
  >;
  onAfterSettle?: (declaration: unknown, context: SettleResultContext) => Promise<void>;
  onSettleFailure?: (
    declaration: unknown,
    context: SettleFailureContext,
  ) => Promise<void | { recovered: true; result: SettleResponse }>;
  onVerifiedPaymentCanceled?: (
    declaration: unknown,
    context: VerifiedPaymentCanceledContext,
  ) => Promise<void>;
}

export interface ResourceServerExtension {
  key: string;
  enrichDeclaration?: (declaration: unknown, transportContext: unknown) => unknown;
  /**
   * Return value merges into `extensions[key]`. In-place edits to `accepts` are allowlisted only
   * (see server `assertAcceptsAllowlistedAfterExtensionEnrich`): vacant `payTo` / `amount` / `asset`
   * may be filled; locked values and `scheme` / `network` / `maxTimeoutSeconds` / baseline `extra`
   * entries are immutable.
   */
  enrichPaymentRequiredResponse?: (
    declaration: unknown,
    context: PaymentRequiredContext,
  ) => Promise<unknown>;
  /**
   * Return value merges into `settleResult.extensions[key]`. Facilitator fields (`success`,
   * `transaction`, `network`, etc.) must not be changed; only `extensions` is merged from the hook.
   */
  enrichSettlementResponse?: (
    declaration: unknown,
    context: SettleResultContext,
  ) => Promise<unknown>;
  /** Installed on `registerExtension`; runs only when `declaredExtensions[key]` is defined. */
  hooks?: ResourceServerExtensionHooks;
}
