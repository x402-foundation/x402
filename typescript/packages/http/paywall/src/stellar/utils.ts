/**
 * Stellar-only utility functions for the browser paywall. Kept free of
 * `viem/chains` so the Stellar bundle does not pull in EVM chain metadata.
 */

/**
 * Header field names checked when extracting an error message from an x402
 * JSON payload.
 */
export const X402_ERROR_MESSAGE_FIELDS = ["error", "message", "detail", "details"] as const;

type StellarPaywallRuntime = {
  config?: {
    rpcUrl?: string;
  };
};

/**
 * Reads the optional Soroban RPC URL override injected by the server handler
 * as `window.x402.config.rpcUrl`.
 *
 * @returns The RPC URL override, or undefined to use the network default
 */
export function getRuntimeRpcUrl(): string | undefined {
  return (window as Window & { x402?: StellarPaywallRuntime }).x402?.config?.rpcUrl;
}

/**
 * Provides a human-readable display name for a Stellar network.
 *
 * @param network - The network identifier (CAIP-2 format, e.g. "stellar:testnet").
 * @returns A display name suitable for UI use.
 */
export function getNetworkDisplayName(network: string): string {
  if (network.startsWith("stellar:")) {
    const ref = network.split(":")[1];
    return ref === "testnet" ? "Stellar Testnet" : "Stellar Mainnet";
  }
  return network;
}

/**
 * Extracts a string message from an unknown error value.
 *
 * @param error - The thrown value
 * @param fallback - Message to use when `error` is not an `Error` instance
 * @returns `error.message` for `Error` instances, otherwise `fallback` or `String(error)`
 */
export function parseError(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  return fallback ?? String(error);
}

/**
 * Formats a raw bigint value with the given number of decimals.
 * Drop-in replacement for viem's `formatUnits` that avoids pulling the
 * whole library into the Stellar bundle.
 *
 * @param value - The raw bigint value (e.g. balance in stroops).
 * @param decimals - Number of decimal places.
 * @returns Formatted string (e.g. "12.3456789").
 */
export function formatUnits(value: bigint, decimals: number): string {
  const str = value.toString();

  if (decimals === 0) {
    return str;
  }

  const isNegative = str.startsWith("-");
  const abs = isNegative ? str.slice(1) : str;
  const padded = abs.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals);

  // Trim trailing zeros from the fractional part
  const trimmed = fracPart.replace(/0+$/, "");

  const result = trimmed.length > 0 ? `${intPart}.${trimmed}` : intPart;
  return isNegative ? `-${result}` : result;
}

/**
 * Decodes a base64-encoded x402 header value to a UTF-8 string, using
 * `Buffer` in Node.js and `atob` + `TextDecoder` in the browser.
 *
 * @param base64HeaderValue - The raw header value
 * @returns The decoded UTF-8 string
 */
function decodeBase64(base64HeaderValue: string): string {
  const nodeBuffer = (globalThis as { Buffer?: typeof Buffer }).Buffer;
  if (nodeBuffer) {
    return nodeBuffer.from(base64HeaderValue, "base64").toString("utf8");
  }

  const binary = globalThis.atob(base64HeaderValue);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Parses a base64-encoded JSON x402 header value into a typed payload.
 * Returns `undefined` when the value is absent, empty, or not valid JSON.
 *
 * @param x402HeaderValue - The raw header value
 * @param onParseError - Optional callback invoked with malformed input
 * @returns The parsed payload, or undefined
 */
export function parseX402Header<T = unknown>(
  x402HeaderValue: string | null | undefined,
  onParseError?: (err: unknown, raw: string) => void,
): T | undefined {
  if (!x402HeaderValue) {
    return undefined;
  }

  try {
    return JSON.parse(decodeBase64(x402HeaderValue)) as T;
  } catch (err) {
    onParseError?.(err, x402HeaderValue);
    return undefined;
  }
}

/**
 * Extracts a human-readable error message from an x402 JSON payload object,
 * checking `X402_ERROR_MESSAGE_FIELDS` in order.
 *
 * @param x402Payload - The decoded payload
 * @returns The first non-empty string field found, or undefined
 */
export function getX402ErrorMessage(x402Payload: unknown): string | undefined {
  if (!x402Payload || typeof x402Payload !== "object") {
    return undefined;
  }

  const record = x402Payload as Record<string, unknown>;
  for (const field of X402_ERROR_MESSAGE_FIELDS) {
    const candidate = record[field];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Builds a user-facing error message from a failed payment response. Prefers
 * the error carried in the `PAYMENT-REQUIRED` header, then JSON body fields,
 * then short plain text; long or HTML bodies are logged to the console.
 *
 * @param prefix - Message prefix identifying the failure stage
 * @param status - HTTP status code of the response
 * @param body - Response body text
 * @param paymentRequiredHeader - Optional `PAYMENT-REQUIRED` header value
 * @returns A single-line message for the status area
 */
export function formatPaymentError(
  prefix: string,
  status: number,
  body: string,
  paymentRequiredHeader?: string | null,
): string {
  const paymentRequiredError = getX402ErrorMessage(
    parseX402Header<Record<string, unknown>>(paymentRequiredHeader, err => {
      console.warn("Malformed x402 payment-required header:", err);
    }),
  );
  if (paymentRequiredError) {
    return `${prefix}: ${paymentRequiredError}`;
  }

  const trimmed = body.trim();
  if (!trimmed) {
    return `${prefix}: ${status}`;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const message = parsed.error || parsed.message || parsed.detail;
      if (typeof message === "string") {
        return `${prefix}: ${message}`;
      }
    }
  } catch {
    /* body is not JSON */
  }
  if (trimmed.startsWith("<") || trimmed.length > 200) {
    console.error(
      `${prefix} (${status}) — response body (first 2000 chars):`,
      trimmed.slice(0, 2000),
    );
    return `${prefix}: ${status} (see browser console for details)`;
  }
  return `${prefix}: ${trimmed}`;
}
