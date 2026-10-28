// Package-internal helpers. `src/index.ts` does not re-export this module, so
// nothing here is public API.
import { HEDERA_TRANSFER_EXECUTOR_WILDCARD } from "./constants";
import type { ExactHederaTransferExecutorPayload } from "./types";
import { isValidHederaEntityId, isValidHexBytes } from "./utils";

/**
 * Returns true when `value` is a non-null, non-array object.
 *
 * @param value - Candidate value
 * @returns Whether `value` is a JSON object
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns true when the value is an array of strings.
 *
 * @param value - Candidate value
 * @returns True when `value` is a string array
 */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

/**
 * Returns true when an executor list admits an executor: it lists the id
 * exactly, or it contains the `"*"` wildcard.
 *
 * @param executors - Executor list, from configuration or `extra.executors`
 * @param executor - Executor contract id
 * @returns True when admitted
 */
export function executorListAdmits(executors: readonly string[], executor: string): boolean {
  return executors.includes(HEDERA_TRANSFER_EXECUTOR_WILDCARD) || executors.includes(executor);
}

/**
 * Returns true when requirements carry an `extra.splits` value: the exact
 * scheme's multi-payee extension, which `transferExecutor` does not implement.
 * Fails closed: only an absent, `null` or empty-array value means a
 * single-payee payment.
 *
 * @param extra - Requirements `extra`
 * @returns True when `extra.splits` is present, non-null and not an empty array
 */
export function hasSplits(extra: Record<string, unknown> | undefined): boolean {
  const splits = extra?.splits;
  if (splits === undefined || splits === null) {
    return false;
  }
  return !Array.isArray(splits) || splits.length > 0;
}

/**
 * Returns the message of a thrown value.
 *
 * @param error - Thrown value
 * @returns Its message, or the value as a string when it is not an `Error`
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Outcome of checking a `transferExecutor` payload: the typed payload, or its
 * first malformed field (`"payload"` when it is not an object at all).
 */
export type TransferExecutorPayloadParse =
  | { payload: ExactHederaTransferExecutorPayload }
  | { malformedField: "payload" | keyof ExactHederaTransferExecutorPayload };

/**
 * Checks a `transferExecutor` payload: `payer` and `executor` are Hedera ids,
 * and `authorization` is `0x`-prefixed hex, never interpreted.
 *
 * @param value - Candidate payload
 * @returns The payload with only its three fields, or the first malformed field
 */
export function parseTransferExecutorPayload(value: unknown): TransferExecutorPayloadParse {
  if (!isJsonObject(value)) {
    return { malformedField: "payload" };
  }
  const { payer, executor, authorization } = value;
  if (typeof payer !== "string" || !isValidHederaEntityId(payer)) {
    return { malformedField: "payer" };
  }
  if (typeof executor !== "string" || !isValidHederaEntityId(executor)) {
    return { malformedField: "executor" };
  }
  if (!isValidHexBytes(authorization)) {
    return { malformedField: "authorization" };
  }
  return { payload: { payer, executor, authorization } };
}
