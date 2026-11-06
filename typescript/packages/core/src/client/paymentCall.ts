import type { HttpPaymentCall, McpPaymentCall, PaymentCall } from "../types/mechanisms";

/** Options accepted by `createPaymentPayload` alongside the PaymentRequired response. */
export interface CreatePaymentPayloadOptions {
  /** The call being paid for. Forwarded to the payment creation hooks and the scheme. */
  call?: PaymentCall;
}

/** Request headers that carry a payment and are never part of the call being paid for. */
const PAYMENT_HEADERS = new Set(["payment-signature", "x-payment"]);

/**
 * Returns whether a value is a plain object (not null, not an array).
 *
 * @param value - Value to test
 * @returns True for non-array objects
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds the error thrown for a malformed call.
 *
 * @param detail - What is wrong
 * @returns The error
 */
function invalid(detail: string): Error {
  return new Error(`invalid_payment_call: ${detail}`);
}

/**
 * Freezes a value and everything reachable from it.
 *
 * @param value - Value to freeze
 * @returns The same value, frozen
 */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Copies request headers into a null-prototype record with lowercase names.
 * Empty names are skipped, values for names that differ only in case are
 * joined with ", ", and payment headers are dropped.
 *
 * @param headers - Caller-supplied headers
 * @returns The normalized, frozen headers
 */
function normalizeHeaders(headers: unknown): Readonly<Record<string, string>> {
  if (!isRecord(headers)) {
    throw invalid("http headers must be an object of strings");
  }
  const out: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      throw invalid(`http header ${JSON.stringify(name)} must be a string`);
    }
    const key = name.trim().toLowerCase();
    if (key === "" || PAYMENT_HEADERS.has(key)) continue;
    out[key] = Object.prototype.hasOwnProperty.call(out, key) ? `${out[key]}, ${value}` : value;
  }
  return Object.freeze(out);
}

/**
 * Validates and copies an HTTP call.
 *
 * @param call - Caller-supplied call
 * @returns The normalized call
 */
function normalizeHttpCall(call: Record<string, unknown>): HttpPaymentCall {
  if (typeof call.method !== "string" || call.method === "") {
    throw invalid("http method must be a non-empty string");
  }
  if (typeof call.url !== "string" || call.url === "") {
    throw invalid("http url must be a non-empty string");
  }
  if (call.getBody !== undefined && typeof call.getBody !== "function") {
    throw invalid("http getBody must be a function");
  }
  const normalized: HttpPaymentCall = {
    kind: "http",
    method: call.method,
    url: call.url,
    headers: normalizeHeaders(call.headers ?? {}),
    ...(call.getBody ? { getBody: call.getBody as HttpPaymentCall["getBody"] } : {}),
  };
  return Object.freeze(normalized);
}

/**
 * Validates and snapshots an MCP tool call. The arguments are structurally
 * cloned and frozen, so later changes to the caller's object are not seen.
 *
 * @param call - Caller-supplied call
 * @returns The normalized call
 */
function normalizeMcpCall(call: Record<string, unknown>): McpPaymentCall {
  if (typeof call.toolName !== "string" || call.toolName === "") {
    throw invalid("mcp toolName must be a non-empty string");
  }
  const args = call.arguments ?? {};
  if (!isRecord(args)) {
    throw invalid("mcp arguments must be an object");
  }
  let snapshot: Record<string, unknown>;
  try {
    snapshot = structuredClone(args);
  } catch {
    throw invalid("mcp arguments must be structured-cloneable");
  }
  return Object.freeze({ kind: "mcp", toolName: call.toolName, arguments: deepFreeze(snapshot) });
}

/**
 * Validates the options passed to `createPaymentPayload` and returns a copy of
 * the call that cannot change while the payment is created. Fails closed: a
 * malformed call is rejected before any hook runs or anything is signed.
 *
 * @param options - Caller-supplied options
 * @returns The normalized call, or undefined when none was given
 */
export function resolvePaymentCall(options: unknown): PaymentCall | undefined {
  if (options === undefined) return undefined;
  if (!isRecord(options)) {
    throw invalid("options must be an object");
  }
  const call = options.call;
  if (call === undefined) return undefined;
  if (!isRecord(call)) {
    throw invalid("call must be an object");
  }
  switch (call.kind) {
    case "http":
      return normalizeHttpCall(call);
    case "mcp":
      return normalizeMcpCall(call);
    default:
      throw new Error(`unsupported_payment_call_kind: ${JSON.stringify(call.kind)}`);
  }
}
