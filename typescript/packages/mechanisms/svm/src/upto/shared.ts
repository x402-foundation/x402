import type { PaymentRequirements } from "@x402/core/types";

import type { ChannelSplit } from "../payment-channels/open";

const BASIS_POINTS_DENOMINATOR = 10_000;

/** Resolved payment-channel fields derived from SVM `upto` requirements. */
export interface UptoSvmPaymentChannelConfig {
  /** Transaction fee payer, channel rent payer, and zero-share channel payee. */
  feePayer: string;
  /** Authorized voucher signer (server hot key). */
  receiverAuthorizer: string;
  /** Forced-close grace period in seconds. */
  withdrawDelay: number;
  /** Program distribution recipients sealed into open and replayed at distribute. */
  splits: readonly ChannelSplit[];
}

/**
 * Resolve and validate the SVM `upto` payment-channel fields.
 *
 * @param requirements - Payment requirements carrying SVM `upto` extra fields
 * @returns Fee payer, receiver authorizer, withdraw delay, and split recipients
 */
export function resolveUptoSvmPaymentChannelConfig(
  requirements: PaymentRequirements,
): UptoSvmPaymentChannelConfig {
  const feePayer = requirements.extra?.feePayer;
  if (typeof feePayer !== "string" || feePayer.length === 0) {
    throw new Error("feePayer must be a non-empty string");
  }

  const receiverAuthorizer = requirements.extra?.receiverAuthorizer;
  if (typeof receiverAuthorizer !== "string" || receiverAuthorizer.length === 0) {
    throw new Error("receiverAuthorizer must be a non-empty string");
  }

  const withdrawDelay = requirements.extra?.withdrawDelay;
  if (typeof withdrawDelay !== "number" || !Number.isInteger(withdrawDelay) || withdrawDelay <= 0) {
    throw new Error("withdrawDelay must be an integer greater than zero");
  }

  // Always explicit: the payee seat is held by the facilitator (feePayer)
  // with a zero implicit remainder, so 100% of settled funds must be
  // assigned to payTo through the recipients list.
  const splits = [{ bps: BASIS_POINTS_DENOMINATOR, recipient: requirements.payTo }];

  return { feePayer, receiverAuthorizer, splits, withdrawDelay };
}
