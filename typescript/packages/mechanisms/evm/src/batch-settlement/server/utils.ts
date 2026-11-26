import type { BatchSettlementChannelStateExtra } from "../types";
import { ErrRefundPayload } from "../errors";

/**
 * Reads the nested channel snapshot from payment response extra fields.
 *
 * @param extra - Payment response extra fields.
 * @returns Channel state object, or undefined when absent.
 */
export function readChannelStateExtra(
  extra: Record<string, unknown> | undefined,
): Partial<BatchSettlementChannelStateExtra> | undefined {
  const value = extra?.channelState;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as Partial<BatchSettlementChannelStateExtra>;
}

/**
 * Reads a string value from optional payment `extra`, with a fallback when missing or invalid.
 *
 * @param extra - Optional payment extra record.
 * @param key - Key on `BatchSettlementPaymentResponseExtra` to read.
 * @param fallback - Value returned when the entry is absent or not coercible to string.
 * @returns String representation of the value, or `fallback`.
 */
export function readExtraString(
  extra: Partial<Record<keyof BatchSettlementChannelStateExtra, unknown>> | undefined,
  key: keyof BatchSettlementChannelStateExtra,
  fallback: string,
): string {
  const value = extra?.[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

/**
 * Reads a numeric value from optional payment `extra`, with a fallback when missing or invalid.
 *
 * @param extra - Optional payment extra record.
 * @param key - Key on `BatchSettlementPaymentResponseExtra` to read.
 * @param fallback - Value returned when the entry is absent or not parseable as a number.
 * @returns Parsed number, or `fallback`.
 */
export function readExtraNumber(
  extra: Partial<Record<keyof BatchSettlementChannelStateExtra, unknown>> | undefined,
  key: keyof BatchSettlementChannelStateExtra,
  fallback: number,
): number {
  const value = extra?.[key];
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? fallback : n;
  }
  return fallback;
}

/**
 * Strictly reads a non-negative integer (as a decimal string) from optional payment `extra`.
 *
 * Canonical rule shared across SDKs: a plain decimal string with no leading zeros (`"0"` is the
 * only string starting with `0`), or a JSON number that is a non-negative safe integer.
 *
 * @param extra - Optional payment extra record.
 * @param key - Key on `BatchSettlementChannelStateExtra` to read.
 * @returns Canonical decimal string, or `undefined` when absent or not a canonical non-negative integer.
 */
export function readExtraUintString(
  extra: Partial<Record<keyof BatchSettlementChannelStateExtra, unknown>> | undefined,
  key: keyof BatchSettlementChannelStateExtra,
): string | undefined {
  const value = extra?.[key];
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

export type RefundSettlementSnapshot = {
  balance?: string;
  totalClaimed?: string;
  withdrawRequestedAt?: number;
  refundNonce?: number;
};

/**
 * Parses a settle `channelState` object.
 *
 * An omitted object returns `undefined` so the caller keeps the stored channel. A present field
 * that is not a canonical non-negative integer throws `ErrRefundPayload`.
 *
 * @param extra - Settlement response extra fields.
 * @returns Validated snapshot, or `undefined` when `channelState` is omitted.
 */
export function parseRefundSettlementSnapshot(
  extra: Record<string, unknown> | undefined,
): RefundSettlementSnapshot | undefined {
  if (extra?.channelState === undefined) {
    return undefined;
  }
  const channelState = readChannelStateExtra(extra);
  if (channelState === undefined || Array.isArray(extra.channelState)) {
    throw new Error(ErrRefundPayload);
  }
  return {
    balance: requireCanonicalUint(channelState, "balance"),
    totalClaimed: requireCanonicalUint(channelState, "totalClaimed"),
    withdrawRequestedAt: requireCanonicalCount(channelState, "withdrawRequestedAt"),
    refundNonce: requireCanonicalCount(channelState, "refundNonce"),
  };
}

/**
 * Reads a canonical uint string when the field is present.
 *
 * @param extra - Channel snapshot fields from the settle response.
 * @param key - Field to read.
 * @returns Decimal string, or `undefined` when the field is absent.
 */
function requireCanonicalUint(
  extra: Partial<Record<keyof BatchSettlementChannelStateExtra, unknown>>,
  key: keyof BatchSettlementChannelStateExtra,
): string | undefined {
  if (extra[key] === undefined) return undefined;
  const parsed = readExtraUintString(extra, key);
  if (parsed === undefined) throw new Error(ErrRefundPayload);
  return parsed;
}

/**
 * Reads a canonical uint as a safe integer when the field is present.
 *
 * @param extra - Channel snapshot fields from the settle response.
 * @param key - Field name: `withdrawRequestedAt` or `refundNonce`.
 * @returns The integer, or `undefined` when the field is absent.
 */
function requireCanonicalCount(
  extra: Partial<Record<keyof BatchSettlementChannelStateExtra, unknown>>,
  key: "withdrawRequestedAt" | "refundNonce",
): number | undefined {
  const parsed = requireCanonicalUint(extra, key);
  if (parsed === undefined) return undefined;
  const value = Number(parsed);
  if (!Number.isSafeInteger(value) || String(value) !== parsed) throw new Error(ErrRefundPayload);
  return value;
}
