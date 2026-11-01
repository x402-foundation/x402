/**
 * x402 wire-format encoding helpers.
 *
 * The PAYMENT-REQUIRED, PAYMENT-SIGNATURE, and PAYMENT-RESPONSE headers
 * are all base64-encoded JSON (x402 v2 wire format).
 */

export const HEADER_PAYMENT_REQUIRED_V2 = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE_V2 = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE_V2 = "PAYMENT-RESPONSE";

/**
 *
 * @param value
 */
export function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** Max accepted size of a base64 envelope before decode (defense vs.
 *  attacker-supplied PAYMENT-SIGNATURE / X-PAYMENT headers, which arrive
 *  OUTSIDE the server's body-size limit). x402 envelopes are a few KiB;
 *  128 KiB is generous. Reject larger input before spending CPU/memory on
 *  base64-decode + JSON.parse. */
export const MAX_BASE64_JSON_INPUT = 128 * 1024;

/**
 *
 * @param encoded
 */
export function decodeBase64Json<T>(encoded: string): T {
  if (typeof encoded !== "string") {
    throw new Error("decodeBase64Json: input is not a string");
  }
  if (encoded.length > MAX_BASE64_JSON_INPUT) {
    throw new Error(
      `decodeBase64Json: input too large (${encoded.length} > ${MAX_BASE64_JSON_INPUT})`,
    );
  }
  const json = Buffer.from(encoded, "base64").toString("utf8");
  return JSON.parse(json) as T;
}
