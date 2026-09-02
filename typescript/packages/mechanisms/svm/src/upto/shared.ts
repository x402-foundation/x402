import type { PaymentRequirements } from "@x402/core/types";

import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "../constants";
import type { ChannelSplit } from "../payment-channels/open";
import { getStablecoinTokenProgram, validateSvmAddress } from "../utils";

/** Denominator a `ChannelSplit.bps` is measured against; 10_000 = 100%. */
export const BASIS_POINTS_DENOMINATOR = 10_000;

/**
 * Commitment for reading account state the caller must act on. Opens are
 * confirmed at this level, and the RPC default (`finalized`) lags a fresh open
 * by seconds, reporting a live channel as missing.
 *
 * The Go SDK reads the same class of state at the same level, so both
 * facilitators judge the same channel identically.
 */
export const STATE_COMMITMENT = "confirmed" as const;

/**
 * Commitment for reading the slot used as an `openSlot` anchor. Clients pin
 * `openSlot` at this level to keep `openSlot <= clock.slot` when the open lands,
 * so verify and the reclaim gate must judge it in the same frame.
 */
export const SLOT_COMMITMENT = "finalized" as const;

/**
 * Commitment for reading transaction-lifetime blockhashes. A finalized hash
 * cannot be dropped by a fork before the transaction lands.
 */
export const BLOCKHASH_COMMITMENT = "finalized" as const;

/**
 * Read and validate `extra.tokenProgram`.
 *
 * A hint that is not one of the two supported programs is a broken challenge and
 * throws, rather than failing later as an opaque open-transaction mismatch.
 * Returning `undefined` for an absent hint lets callers pick their own fallback:
 * the registry for the facilitator, a mint read for the client.
 *
 * @param extra - The `extra` block of the payment requirements
 * @returns The hinted token program address, or undefined when unset
 */
export function parseTokenProgramHint(extra: PaymentRequirements["extra"]): string | undefined {
  const hint = extra?.tokenProgram;
  if (hint === undefined || hint === null || hint === "") {
    return undefined;
  }
  if (typeof hint !== "string" || !validateSvmAddress(hint)) {
    throw new Error(`extra.tokenProgram ${String(hint)} is not a valid base58 address`);
  }
  if (hint !== TOKEN_PROGRAM_ADDRESS && hint !== TOKEN_2022_PROGRAM_ADDRESS) {
    throw new Error(`extra.tokenProgram ${hint} is not a supported SPL token program`);
  }
  return hint;
}

/**
 * Resolve the SPL token program owning the requirement's mint.
 *
 * The challenge hint wins; otherwise the registry answers, so a Token-2022
 * stablecoin is not mistaken for a legacy SPL Token one.
 *
 * @param requirements - The payment requirements being paid
 * @returns The token program address
 */
export function resolveTokenProgram(requirements: PaymentRequirements): string {
  return (
    parseTokenProgramHint(requirements.extra) ??
    getStablecoinTokenProgram(requirements.asset, requirements.network)
  );
}

/**
 * Read the optional seller memo (`extra.memo`).
 *
 * A non-empty string is a requirement: the client emits exactly that memo and
 * the facilitator demands a match. Missing, empty, or non-string is unset, so
 * the client falls back to a random nonce and the facilitator does not check
 * it. Both roles resolve through here, which keeps them from disagreeing on
 * whether a memo was requested. Matches the Go SDK's `ParseExtraMemo`.
 *
 * @param extra - The `extra` map from the payment requirements
 * @returns The requested memo, or undefined when the seller set none
 */
export function resolveUptoSvmMemo(extra: PaymentRequirements["extra"]): string | undefined {
  const memo = extra?.memo;
  return typeof memo === "string" && memo !== "" ? memo : undefined;
}

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
