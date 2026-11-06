/**
 * Multi-payee splits for the exact scheme (scheme_exact_sui.md, Splits).
 *
 * Shared by the client (one `send_funds` per leg), the server (checks against
 * the facilitator's advertised `maxSplits`) and the facilitator (requirements
 * rules and the per-leg effects check).
 */

import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import type { PaymentRequirements } from "@x402/core/types";
import { MAX_SPLITS, MAX_SPLIT_MEMO_BYTES } from "./constants";

const U64_MAX = (1n << 64n) - 1n;
const CANONICAL_AMOUNT = /^[1-9][0-9]*$/;
const SPLIT_FIELDS = new Set(["payTo", "amount", "memo"]);

/**
 * One entry of `PaymentRequirements.extra.splits`.
 */
export type ExactSuiSplit = {
  payTo: string;
  amount: string;
  memo?: string;
};

/**
 * One payment leg: the remainder to `payTo`, or one split. Each leg's
 * recipient must net exactly `amount`.
 */
export type PaymentLeg = {
  payTo: string;
  amount: bigint;
};

/**
 * Consent hook for splits. Called before signing with the splits and the
 * remainder that reaches `payTo`. Return `true` only for terms the payer agreed
 * to, and show any `memo` next to its address, not in place of it.
 */
export type ApproveSplits = (
  splits: ReadonlyArray<ExactSuiSplit>,
  context: { payTo: string; primaryAmount: string; requirements: PaymentRequirements },
) => boolean | Promise<boolean>;

/**
 * A splits rule violation. Facilitators report it as `reason`.
 */
export class SplitsError extends Error {
  readonly reason = "invalid_payment_requirements";

  /**
   * Creates a splits rule violation.
   *
   * @param detail - What is wrong with the splits
   */
  constructor(readonly detail: string) {
    super(`invalid_payment_requirements: ${detail}`);
    this.name = "SplitsError";
  }
}

/**
 * Whether the requirements carry `extra.splits` other than absent or `[]`.
 *
 * @param requirements - Payment requirements to inspect
 * @returns True when the splits rules apply
 */
export function hasSplits(requirements: Pick<PaymentRequirements, "extra">): boolean {
  const splits = requirements.extra?.splits;
  return splits !== undefined && !(Array.isArray(splits) && splits.length === 0);
}

/**
 * Whether a value is a Sui address, in full or short (`0x2`) hex form.
 *
 * @param value - Candidate address
 * @returns True for a hex address of at most 32 bytes
 */
function isSuiAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^0x[0-9a-fA-F]+$/.test(value) &&
    isValidSuiAddress(normalizeSuiAddress(value))
  );
}

/**
 * Parse a canonical positive u64 decimal string.
 *
 * @param value - Candidate amount
 * @param field - Field name for the error message
 * @returns The amount
 */
function parseAmount(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !CANONICAL_AMOUNT.test(value)) {
    throw new SplitsError(`${field} must be a positive integer string, got ${String(value)}`);
  }
  const amount = BigInt(value);
  if (amount > U64_MAX) {
    throw new SplitsError(`${field} exceeds u64`);
  }
  return amount;
}

/**
 * Parse the requirements' total `amount`: a positive decimal integer.
 *
 * @param value - Candidate amount
 * @returns The amount
 */
function parseTotal(value: unknown): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value) || BigInt(value) <= 0n) {
    throw new SplitsError(`amount must be a positive integer, got ${String(value)}`);
  }
  return BigInt(value);
}

/**
 * Validate `extra.splits` and return the payment legs: the remainder to
 * `payTo` first, then one leg per split in order. Without splits this is one
 * leg of the full `amount`. Does not check a facilitator's `maxSplits`; see
 * {@link assertWithinMaxSplits}.
 *
 * @param requirements - Payment requirements to validate
 * @returns The payment legs
 * @throws SplitsError when the requirements break a splits rule
 */
export function parsePaymentLegs(
  requirements: Pick<PaymentRequirements, "amount" | "payTo" | "extra">,
): PaymentLeg[] {
  // Only an absent value means no splits; null and other values are malformed.
  const rawSplits = requirements.extra?.splits === undefined ? [] : requirements.extra.splits;
  if (!Array.isArray(rawSplits)) {
    throw new SplitsError("extra.splits must be an array");
  }
  if (rawSplits.length > MAX_SPLITS) {
    throw new SplitsError(`extra.splits has ${rawSplits.length} entries, at most ${MAX_SPLITS}`);
  }

  const total = parseTotal(requirements.amount);
  if (rawSplits.length === 0) {
    return [{ payTo: requirements.payTo, amount: total }];
  }
  if (!isSuiAddress(requirements.payTo)) {
    throw new SplitsError(`payTo is not a valid Sui address: ${String(requirements.payTo)}`);
  }
  const seen = new Set<string>([normalizeSuiAddress(requirements.payTo)]);
  const splitLegs: PaymentLeg[] = [];
  let splitTotal = 0n;

  rawSplits.forEach((raw: unknown, i: number) => {
    const field = `extra.splits[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new SplitsError(`${field} must be an object`);
    }
    const split = raw as Record<string, unknown>;
    const unknown = Object.keys(split).filter(key => !SPLIT_FIELDS.has(key));
    if (unknown.length > 0) {
      throw new SplitsError(`${field} has unsupported field(s): ${unknown.join(", ")}`);
    }
    if (!isSuiAddress(split.payTo)) {
      throw new SplitsError(`${field}.payTo is not a valid Sui address`);
    }
    const recipient = normalizeSuiAddress(split.payTo);
    if (seen.has(recipient)) {
      throw new SplitsError(`${field}.payTo duplicates another recipient`);
    }
    seen.add(recipient);
    const amount = parseAmount(split.amount, `${field}.amount`);
    if (split.memo !== undefined) {
      if (typeof split.memo !== "string") {
        throw new SplitsError(`${field}.memo must be a string`);
      }
      if (new TextEncoder().encode(split.memo).byteLength > MAX_SPLIT_MEMO_BYTES) {
        throw new SplitsError(`${field}.memo exceeds ${MAX_SPLIT_MEMO_BYTES} bytes`);
      }
    }
    splitTotal += amount;
    splitLegs.push({ payTo: split.payTo, amount });
  });

  if (splitTotal >= total) {
    throw new SplitsError(
      `splits total ${splitTotal} leaves no remainder for payTo out of amount ${total}`,
    );
  }

  return [{ payTo: requirements.payTo, amount: total - splitTotal }, ...splitLegs];
}

/**
 * The `extra.splits` entries of requirements already checked by
 * {@link parsePaymentLegs}, or an empty array.
 *
 * @param requirements - Payment requirements
 * @returns The split entries
 */
export function getSplits(requirements: Pick<PaymentRequirements, "extra">): ExactSuiSplit[] {
  const splits = requirements.extra?.splits;
  return Array.isArray(splits) ? (splits as ExactSuiSplit[]) : [];
}

/**
 * Read `maxSplits` from a `/supported` kind's `extra`. Absent or invalid means
 * 0 (no splits); values above {@link MAX_SPLITS} are clamped.
 *
 * @param extra - The kind's `extra`
 * @returns The number of splits the facilitator accepts
 */
export function getMaxSplits(extra: Record<string, unknown> | undefined): number {
  const maxSplits = extra?.maxSplits;
  return typeof maxSplits === "number" && Number.isInteger(maxSplits) && maxSplits > 0
    ? Math.min(maxSplits, MAX_SPLITS)
    : 0;
}

/**
 * Throw when the legs carry more splits than a facilitator accepts.
 *
 * @param legs - Legs from {@link parsePaymentLegs}
 * @param maxSplits - The number of splits accepted
 * @throws SplitsError when there are too many splits
 */
export function assertWithinMaxSplits(legs: readonly PaymentLeg[], maxSplits: number): void {
  const count = legs.length - 1;
  if (count > maxSplits) {
    throw new SplitsError(
      maxSplits === 0
        ? `${count} splits, but the facilitator does not accept splits`
        : `${count} splits, but the facilitator accepts at most ${maxSplits}`,
    );
  }
}
