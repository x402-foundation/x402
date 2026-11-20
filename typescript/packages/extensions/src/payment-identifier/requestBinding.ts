/**
 * Request Binding for the Payment-Identifier Extension
 *
 * Implements the "Request Binding" section of
 * specs/extensions/payment_identifier.md: before serving a cached response
 * for a repeated `id`, implementations should bind that `id` to a normalized
 * fingerprint of the paid operation (scheme, network, asset, amount, payTo,
 * resource, scheme-declared `extra` terms, and optionally the HTTP method
 * and an application-level operation id) and reject a later request that
 * reuses the `id` with a different fingerprint.
 *
 * Fingerprinting these specific terms, rather than the full signed payload,
 * matters because a byte-level payload hash only recognizes an exact retry.
 * It cannot tell a routine retry apart from a new request that happens to
 * reuse the same `id` with a different amount, payTo, or asset, since none
 * of those fields individually change the signature bytes most schemes
 * place in the payload.
 */

import { createHash } from "crypto";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]+$/;

/**
 * Lowercases a value when it looks like a `0x`-prefixed hex address, so two
 * requests that differ only in checksum casing of the same EVM address or
 * asset contract fingerprint identically. Non-hex identifiers (e.g. Solana
 * base58 addresses, which are case-sensitive) are left untouched.
 *
 * @param value - The `payTo` or `asset` value to normalize.
 * @returns The lowercased value when it matches a hex address, otherwise `value` unchanged.
 */
function normalizeIfHexAddress(value: string): string {
  return HEX_ADDRESS_RE.test(value) ? value.toLowerCase() : value;
}

/**
 * Returns a copy of `obj` with the given keys removed.
 *
 * @param obj - The object to copy, or `undefined`.
 * @param keys - Keys to omit; `undefined` or empty omits nothing.
 * @returns A new object without the omitted keys.
 */
function omitKeys(
  obj: Record<string, unknown> | undefined,
  keys: string[] | undefined,
): Record<string, unknown> {
  if (!obj) {
    return {};
  }
  if (!keys || keys.length === 0) {
    return obj;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!keys.includes(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * JSON-stringifies a value with object keys sorted at every level, so the
 * result does not depend on the original key order.
 *
 * @param value - The value to stringify.
 * @returns A key-order-independent JSON string.
 */
function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/**
 * Caller-supplied context that is not part of `PaymentPayload` itself but is
 * part of the paid operation, such as the HTTP method of the protected
 * route or an application-level order/operation id.
 */
export interface RequestBindingContext {
  /** HTTP method of the protected resource, when known to the caller. */
  method?: string;
  /** Application-level order/operation identifier, when the integration has one. */
  operationId?: string;
  /**
   * Scheme-declared `extra` keys that are regenerated per `PaymentRequired`
   * (e.g. a fresh nonce) and should not be bound, matching the same keys a
   * resource server passes as `dynamicExtraFields` when matching accepted
   * requirements against its own advertised ones.
   */
  dynamicExtraFields?: string[];
}

/**
 * Computes a deterministic fingerprint of the terms that make a paid
 * operation unique, for binding to a payment `id`.
 *
 * The fingerprint is built from a fixed-shape object with a fixed key
 * order, so it does not depend on property order in the payload or in
 * `context`. `payTo` and `asset` are compared case-insensitively when they
 * look like hex addresses, since checksum casing does not change the
 * underlying identity. `accepted.extra` is included (minus
 * `dynamicExtraFields`), matching how `extra` is already treated as part of
 * the binding payment terms elsewhere in this SDK.
 *
 * @param payload - The payment payload to fingerprint. Must have `accepted` set.
 * @param context - Caller-supplied fields not present on `PaymentPayload`.
 * @returns SHA-256 hex digest of the normalized request terms.
 */
export function computeRequestFingerprint(
  payload: PaymentPayload,
  context: RequestBindingContext = {},
): string {
  if (!payload?.accepted) {
    throw new TypeError("computeRequestFingerprint: payload.accepted is required");
  }
  const accepted: PaymentRequirements = payload.accepted;
  const extra = omitKeys(accepted.extra, context.dynamicExtraFields);
  const terms = {
    scheme: accepted.scheme,
    network: accepted.network,
    asset: normalizeIfHexAddress(accepted.asset),
    amount: accepted.amount,
    payTo: normalizeIfHexAddress(accepted.payTo),
    extra: canonicalStringify(extra),
    resource: payload.resource?.url ?? null,
    method: context.method ?? null,
    operationId: context.operationId ?? null,
  };
  return createHash("sha256").update(JSON.stringify(terms)).digest("hex");
}

/**
 * Compares a stored fingerprint against the fingerprint of an incoming
 * request for the same payment `id`.
 *
 * @param storedFingerprint - The fingerprint recorded for the `id` on first use.
 * @param currentFingerprint - The fingerprint of the current request.
 * @returns `true` when the `id` is being reused for a different operation
 * (the caller should respond with 409 Conflict); `false` when it is safe to
 * serve the cached response.
 */
export function isRequestBindingConflict(
  storedFingerprint: string,
  currentFingerprint: string,
): boolean {
  return storedFingerprint !== currentFingerprint;
}
