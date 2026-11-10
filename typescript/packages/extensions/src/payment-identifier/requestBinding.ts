/**
 * Request Binding for the Payment-Identifier Extension
 *
 * Implements the "Request Binding" section of
 * specs/extensions/payment_identifier.md: before serving a cached response
 * for a repeated `id`, implementations should bind that `id` to a normalized
 * fingerprint of the paid operation (scheme, network, asset, amount, payTo,
 * resource, and optionally the HTTP method and an application-level
 * operation id) and reject a later request that reuses the `id` with a
 * different fingerprint.
 *
 * Fingerprinting these specific terms, rather than the full signed payload,
 * matters because a byte-level payload hash only recognizes an exact retry.
 * It cannot tell a routine retry apart from a new request that happens to
 * reuse the same `id` with a different amount, payTo, or asset, since none
 * of those fields individually change the signature bytes most schemes
 * place in the payload.
 */

import { createHash } from "crypto";
import type { PaymentPayload } from "@x402/core/types";

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
}

/**
 * Computes a deterministic fingerprint of the terms that make a paid
 * operation unique, for binding to a payment `id`.
 *
 * The fingerprint is built from a fixed-shape object with a fixed key
 * order, so it does not depend on property order in the payload or in
 * `context`.
 *
 * @param payload - The payment payload to fingerprint.
 * @param context - Caller-supplied fields not present on `PaymentPayload`.
 * @returns SHA-256 hex digest of the normalized request terms.
 */
export function computeRequestFingerprint(
  payload: PaymentPayload,
  context: RequestBindingContext = {},
): string {
  const terms = {
    scheme: payload.accepted.scheme,
    network: payload.accepted.network,
    asset: payload.accepted.asset,
    amount: payload.accepted.amount,
    payTo: payload.accepted.payTo,
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
