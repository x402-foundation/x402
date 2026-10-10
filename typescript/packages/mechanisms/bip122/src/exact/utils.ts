import type { DecodedBolt11 } from "./types";

let _decode: ((invoice: string) => unknown) | null = null;

function getDecoder(): (invoice: string) => unknown {
  if (!_decode) {
    // lazy-require so the package loads even if light-bolt11-decoder is absent
    // (facilitator-only deployments that supply their own decodeBolt11Fn)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("light-bolt11-decoder");
      _decode = mod.decode ?? mod.default?.decode ?? mod;
    } catch {
      throw new Error(
        "light-bolt11-decoder is required for BOLT11 decoding. " +
          "Install it: npm add light-bolt11-decoder",
      );
    }
  }
  return _decode!;
}

/**
 * Decode a BOLT11 invoice into the minimal fields needed for x402 verification.
 * Uses light-bolt11-decoder (zero-deps, TypeScript-native, ~12kB).
 *
 * @throws if the invoice is malformed or missing required fields
 */
export function decodeBolt11(invoice: string): DecodedBolt11 {
  const decode = getDecoder();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const decoded: any = decode(invoice);

  const getSectionValue = (name: string) =>
    decoded?.sections?.find((s: { name: string }) => s.name === name)?.value;

  const paymentHash: string | undefined =
    decoded?.payment_hash ?? getSectionValue("payment_hash");
  const amountMsat: number | undefined =
    decoded?.millisatoshis != null
      ? Number(decoded.millisatoshis)
      : decoded?.satoshis != null
        ? Number(decoded.satoshis) * 1000
        : undefined;
  const timestamp: number | undefined = decoded?.timestamp ?? getSectionValue("timestamp");
  const expiry: number | undefined =
    decoded?.expiry ?? getSectionValue("expiry") ?? 3600;

  if (!paymentHash || typeof paymentHash !== "string") {
    throw new Error("BOLT11 decode: missing payment_hash");
  }
  if (amountMsat == null || isNaN(amountMsat) || amountMsat <= 0) {
    throw new Error("BOLT11 decode: missing or invalid amount");
  }
  if (timestamp == null || isNaN(Number(timestamp))) {
    throw new Error("BOLT11 decode: missing timestamp");
  }

  const ts = Number(timestamp);
  const exp = Number(expiry);

  return {
    paymentHash,
    amountMsat,
    timestamp: ts,
    expiry: exp,
    expiresAt: ts + exp,
  };
}
