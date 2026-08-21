/**
 * SNIP-9 v2 Outside Execution typed data (SNIP-12 revision 1).
 *
 * The facilitator never hashes client-supplied typed data as received: it
 * parses `domain.chainId` and the five message fields, reconstructs the
 * canonical typed data defined here, and computes the hash from its own
 * reconstruction. Unknown or missing keys are rejected.
 */

import { num, shortString, type TypedData } from "starknet";
import { DECIMAL_FELT_REGEX, HEX_FELT_REGEX, U128_MAX } from "./constants";

export const SNIP9_DOMAIN_NAME = "Account.execute_from_outside";
export const SNIP9_DOMAIN_VERSION = "2";
export const SNIP12_REVISION = "1";

/**
 * Canonical SNIP-9 v2 / SNIP-12 rev 1 type definitions.
 */
export const OUTSIDE_EXECUTION_TYPES: TypedData["types"] = {
  StarknetDomain: [
    { name: "name", type: "shortstring" },
    { name: "version", type: "shortstring" },
    { name: "chainId", type: "shortstring" },
    { name: "revision", type: "shortstring" },
  ],
  OutsideExecution: [
    { name: "Caller", type: "ContractAddress" },
    { name: "Nonce", type: "felt" },
    { name: "Execute After", type: "u128" },
    { name: "Execute Before", type: "u128" },
    { name: "Calls", type: "Call*" },
  ],
  Call: [
    { name: "To", type: "ContractAddress" },
    { name: "Selector", type: "selector" },
    { name: "Calldata", type: "felt*" },
  ],
};

export interface OutsideExecutionCall {
  To: string;
  Selector: string;
  Calldata: string[];
}

export interface OutsideExecutionMessage {
  Caller: string;
  Nonce: string;
  "Execute After": string | number;
  "Execute Before": string | number;
  Calls: OutsideExecutionCall[];
}

export type ParsedOutsideExecution =
  | { ok: true; chainId: string; message: OutsideExecutionMessage }
  | { ok: false; reason: string };

/**
 * Canonical message form: every felt normalized to a string (hash-neutral).
 */
export interface CanonicalOutsideExecutionMessage {
  Caller: string;
  Nonce: string;
  "Execute After": string;
  "Execute Before": string;
  Calls: OutsideExecutionCall[];
}

/**
 * Canonical typed data with a precisely-typed message.
 */
export type OutsideExecutionTypedData = TypedData & {
  message: CanonicalOutsideExecutionMessage;
};

const DOMAIN_KEYS = ["name", "version", "chainId", "revision"];
const MESSAGE_KEYS = ["Caller", "Nonce", "Execute After", "Execute Before", "Calls"];
const CALL_KEYS = ["To", "Selector", "Calldata"];

/**
 * Checks that an object has exactly the given keys, no more and no fewer.
 *
 * @param obj - The object to check
 * @param keys - The exact set of keys expected
 * @returns True when the object's keys match exactly
 */
function hasExactKeys(obj: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(obj);
  return actual.length === keys.length && keys.every(k => k in obj);
}

/**
 * Checks whether a value is a felt-like number or hex/decimal string.
 *
 * Both branches are bounded, because /verify is unauthenticated and every felt
 * here is parsed before any signature check.
 *
 * A felt sent as a JSON number is only accepted in the safe-integer range. Past
 * 2^53 a double no longer represents every integer, so which felt was meant is
 * not recoverable from the value alone - some are exact and some are not, and
 * nothing in the payload says which. Clients encode felts as hex; the number
 * form is a convenience for small values like timestamps.
 *
 * The string bounds are length limits, not range checks: a felt is under 2^252,
 * so 64 hex or 78 decimal digits cannot exclude a legal value while keeping the
 * match linear in a bounded input.
 *
 * @param v - The value to check
 * @returns True when the value can be interpreted as a felt
 */
function isFeltLike(v: unknown): v is string | number {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0;
  if (typeof v !== "string" || v.length === 0) return false;
  return HEX_FELT_REGEX.test(v) || DECIMAL_FELT_REGEX.test(v);
}

/**
 * Parses and structurally validates client-supplied SNIP-9 v2 typed data for
 * the `exact` scheme. Rejects unknown or missing keys in the domain, message,
 * and each Call.
 *
 * Scoped to this scheme rather than to SNIP-9 in general: it additionally
 * requires the single three-felt `transfer` call a payment consists of. Those
 * checks live here, before the per-element scans, so an unauthenticated
 * /verify cannot be made to walk a large call array it was always going to
 * reject. A caller wanting a general SNIP-9 parser should not use this one.
 *
 * @param typedData - The client-supplied typed data object
 * @returns The parsed chain id and message, or a rejection reason
 */
export function parseOutsideExecution(typedData: unknown): ParsedOutsideExecution {
  const td = typedData as {
    primaryType?: unknown;
    domain?: Record<string, unknown>;
    message?: Record<string, unknown>;
  };
  if (!td || typeof td !== "object") return { ok: false, reason: "typed data is not an object" };

  if (td.primaryType !== "OutsideExecution") {
    return { ok: false, reason: "primaryType must be OutsideExecution" };
  }

  const domain = td.domain;
  if (!domain || typeof domain !== "object" || !hasExactKeys(domain, DOMAIN_KEYS)) {
    return { ok: false, reason: "domain must have exactly name/version/chainId/revision" };
  }
  if (domain.name !== SNIP9_DOMAIN_NAME) {
    return {
      ok: false,
      reason: `domain.name must be ${SNIP9_DOMAIN_NAME} (SNIP-9 v1 is not supported)`,
    };
  }
  if (String(domain.version) !== SNIP9_DOMAIN_VERSION) {
    return { ok: false, reason: "domain.version must be 2 (SNIP-9 v1 is not supported)" };
  }
  if (String(domain.revision) !== SNIP12_REVISION) {
    return { ok: false, reason: "domain.revision must be 1 (SNIP-12 revision 0 is not supported)" };
  }
  // A chain id is a felt (hex/decimal) or the short string it encodes; a short
  // string is at most 31 characters, a hex felt at most 66. Anything else,
  // including the empty string, cannot round-trip through the canonical
  // reconstruction and is rejected here rather than surfacing as a hash error.
  if (
    typeof domain.chainId !== "string" ||
    domain.chainId.length === 0 ||
    domain.chainId.length > 66
  ) {
    return { ok: false, reason: "domain.chainId missing or malformed" };
  }

  const message = td.message;
  if (!message || typeof message !== "object" || !hasExactKeys(message, MESSAGE_KEYS)) {
    return {
      ok: false,
      reason: "message must have exactly Caller/Nonce/Execute After/Execute Before/Calls",
    };
  }
  if (!isFeltLike(message.Caller)) return { ok: false, reason: "invalid Caller" };
  if (!isFeltLike(message.Nonce)) return { ok: false, reason: "invalid Nonce" };
  if (!isFeltLike(message["Execute After"])) return { ok: false, reason: "invalid Execute After" };
  if (!isFeltLike(message["Execute Before"]))
    return { ok: false, reason: "invalid Execute Before" };

  const calls = message.Calls;
  if (!Array.isArray(calls)) return { ok: false, reason: "Calls must be an array" };
  // The shape checks the `exact` scheme requires are applied here rather than
  // after parsing, so an unauthenticated /verify cannot be made to validate an
  // arbitrarily large call array that it was always going to reject. A payment
  // is one transfer, so anything else is rejected before its contents are read.
  if (calls.length !== 1) {
    return { ok: false, reason: "OutsideExecution must contain exactly 1 call" };
  }
  for (const call of calls) {
    if (
      !call ||
      typeof call !== "object" ||
      !hasExactKeys(call as Record<string, unknown>, CALL_KEYS)
    ) {
      return { ok: false, reason: "each Call must have exactly To/Selector/Calldata" };
    }
    const c = call as Record<string, unknown>;
    if (!isFeltLike(c.To)) {
      return { ok: false, reason: "invalid Call target" };
    }
    // The selector must be hex specifically. A decimal encoding compares equal
    // numerically but is not what a conformant client signs, so accepting it
    // would admit a payload the payer's account hashes differently.
    if (typeof c.Selector !== "string" || !HEX_FELT_REGEX.test(c.Selector)) {
      return { ok: false, reason: "Call selector must be a 0x-prefixed felt" };
    }
    if (!Array.isArray(c.Calldata) || c.Calldata.length !== 3) {
      return {
        ok: false,
        reason: "transfer calldata must be exactly [recipient, amount_low, amount_high]",
      };
    }
    if (!(c.Calldata as unknown[]).every(isFeltLike)) {
      return { ok: false, reason: "invalid Call calldata" };
    }
  }

  return {
    ok: true,
    chainId: String(domain.chainId),
    message: message as unknown as OutsideExecutionMessage,
  };
}

/**
 * Normalize a felt-like value to its hex form.
 *
 * @param value - A felt as a number, decimal string, or hex string
 * @returns The 0x-prefixed hex representation
 */
function toFelt(value: string | number): string {
  return num.toHex(value);
}

/**
 * Reconstructs the canonical SNIP-9 v2 typed data from parsed values. The
 * signature hash is always computed from this reconstruction, never from the
 * client-supplied object.
 *
 * @param chainId - The chain id felt or short string
 * @param message - The parsed OutsideExecution message
 * @returns The canonical typed data ready for hashing
 */
export function buildCanonicalOutsideExecutionTypedData(
  chainId: string,
  message: OutsideExecutionMessage,
): OutsideExecutionTypedData {
  return {
    types: OUTSIDE_EXECUTION_TYPES,
    primaryType: "OutsideExecution",
    domain: {
      name: SNIP9_DOMAIN_NAME,
      version: SNIP9_DOMAIN_VERSION,
      // Normalized to the hex felt like every message field below: the hash is
      // identical for the short-string form, but the serialized document also
      // travels to the settlement executor, which parses felts as hex.
      chainId: num.toHex(chainIdToFelt(chainId)),
      revision: SNIP12_REVISION,
    },
    // Every felt is emitted in hex. The SNIP-12 hash is identical either way -
    // felts are encoded numerically - but the serialized message is also read by
    // whoever relays it, and a SNIP-29 paymaster parses these fields as hex when
    // rebuilding the onchain `execute_from_outside_v2` calldata. A decimal
    // string is misparsed there, so the account recomputes a different hash and
    // rejects the signature. Verified against a live paymaster.
    message: {
      Caller: toFelt(message.Caller),
      Nonce: toFelt(message.Nonce),
      "Execute After": toFelt(message["Execute After"]),
      "Execute Before": toFelt(message["Execute Before"]),
      Calls: message.Calls.map(c => ({
        To: toFelt(c.To),
        Selector: toFelt(c.Selector),
        Calldata: c.Calldata.map(toFelt),
      })),
    },
  };
}

/**
 * Resolves a chainId that may be hex ("0x534e...") or a short string
 * ("SN_SEPOLIA") to its felt value.
 *
 * @param chainId - The chain id as hex, decimal, or short string
 * @returns The chain id felt value
 */
export function chainIdToFelt(chainId: string): bigint {
  if (/^0x[0-9a-fA-F]+$/.test(chainId)) return BigInt(chainId);
  if (/^[0-9]+$/.test(chainId)) return BigInt(chainId);
  return BigInt(shortString.encodeShortString(chainId));
}

/**
 * Builds a SNIP-2 `transfer` Call for use in an OutsideExecution. Calldata is
 * the ABI serialization of `(recipient, amount: u256)` with the u256 split into
 * low and high 128-bit limbs.
 *
 * @param token - The token contract address
 * @param recipient - The transfer recipient address
 * @param amount - The transfer amount in atomic units, as a base-10 string
 * @returns A Call object with contractAddress, entrypoint, and calldata
 */
export function buildTransferCall(
  token: string,
  recipient: string,
  amount: string,
): { contractAddress: string; entrypoint: string; calldata: string[] } {
  const value = BigInt(amount);
  const low = value & U128_MAX;
  const high = value >> 128n;
  return {
    contractAddress: token,
    entrypoint: "transfer",
    calldata: [recipient, low.toString(), high.toString()],
  };
}
