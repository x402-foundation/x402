/**
 * Runtime validation for the server-injected `window.x402` configuration.
 * Guards against malformed or stale data surfacing as cryptic React crashes.
 */

export function validateX402Config(): string | null {
  const x402: unknown = window.x402;

  if (x402 == null || typeof x402 !== "object") {
    return "window.x402 is missing or not an object. The server may have failed to inject the paywall configuration.";
  }

  const config = x402 as Record<string, unknown>;

  if (!config.paymentRequired || typeof config.paymentRequired !== "object") {
    return "window.x402.paymentRequired is missing or invalid.";
  }

  const pr = config.paymentRequired as Record<string, unknown>;

  if (!Array.isArray(pr.accepts) || pr.accepts.length === 0) {
    return "window.x402.paymentRequired.accepts is missing or empty. No payment methods available.";
  }

  if (config.config != null && typeof config.config !== "object") {
    return "window.x402.config is present but not an object.";
  }

  return null;
}
