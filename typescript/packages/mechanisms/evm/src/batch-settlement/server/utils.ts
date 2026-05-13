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
  if (typeof value === "string") return parseInt(value, 10) || fallback;
  return fallback;
}

export type RefundSettlementSnapshot = {
  balance: string;
  totalClaimed: string;
  withdrawRequestedAt: number;
  refundNonce: number;
};

/**
 * Parses the facilitator's post-refund channel snapshot.
 *
 * @param extra - Settlement response extra fields.
 * @returns Validated refund settlement snapshot.
 */
export function parseRefundSettlementSnapshot(
  extra: Record<string, unknown> | undefined,
): RefundSettlementSnapshot {
  const channelState = readChannelStateExtra(extra);
  return {
    balance: parseUintStringExtra(channelState, "balance"),
    totalClaimed: parseUintStringExtra(channelState, "totalClaimed"),
    withdrawRequestedAt: parseUintNumberExtra(channelState, "withdrawRequestedAt"),
    refundNonce: parseUintNumberExtra(channelState, "refundNonce"),
  };
}

/**
 * Parses a non-negative integer as a decimal string from refund snapshot `extra`.
 *
 * @param extra - Settlement response extra fields from the facilitator.
 * @param key - Field name: `balance` or `totalClaimed`.
 * @returns Decimal string representation of the uint (digits only).
 */
function parseUintStringExtra(
  extra: Partial<Record<keyof BatchSettlementChannelStateExtra, unknown>> | undefined,
  key: "balance" | "totalClaimed",
): string {
  const value = extra?.[key];
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return String(value);
  throw new Error(ErrRefundPayload);
}

/**
 * Parses a non-negative integer from refund snapshot `extra`.
 *
 * @param extra - Settlement response extra fields from the facilitator.
 * @param key - Field name: `withdrawRequestedAt` or `refundNonce`.
 * @returns Parsed non-negative integer.
 */
function parseUintNumberExtra(
  extra: Partial<Record<keyof BatchSettlementChannelStateExtra, unknown>> | undefined,
  key: "withdrawRequestedAt" | "refundNonce",
): number {
  const value = extra?.[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = parseInt(value, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw new Error(ErrRefundPayload);
}
