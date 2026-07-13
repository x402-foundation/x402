/**
 * Canonical encodings for the Swap Settlement Extension.
 *
 * Two 32-byte values bind signatures to a specific quote and specific payment
 * requirements:
 *
 * ```
 * quoteIdHash      = keccak256(utf8(quoteId))
 * requirementsHash = keccak256(jcs(paymentRequirements))
 * ```
 *
 * where `jcs` is RFC 8785 (JSON Canonicalization Scheme) serialization of the
 * selected `accepts[]` entry. These functions are pure and shared by clients
 * and facilitators; both sides MUST derive identical bytes.
 */

import { encodeAbiParameters, keccak256, stringToBytes, type Hex } from "viem";

const BYTES32_PATTERN = /^0x[a-fA-F0-9]{64}$/;

/**
 * Serializes a JSON value according to the RFC 8785 (JCS) subset used by
 * this extension.
 *
 * - Object keys are sorted by UTF-16 code units (default `Array.prototype.sort`).
 * - Strings and keys are serialized via `JSON.stringify`.
 * - Booleans and `null` are emitted as literals.
 * - Numbers MUST be finite safe integers; `-0` is normalized to `"0"`.
 * - Arrays are serialized recursively.
 * - `undefined`, functions, symbols, and bigints are rejected.
 *
 * @param value - The JSON value to canonicalize
 * @returns The canonical JSON string
 * @throws {TypeError} If the value contains an unsupported type or a
 *   non-integer / unsafe-integer number
 */
export function jcsSerialize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
        throw new TypeError(
          `jcsSerialize: numbers must be finite safe integers, got ${String(value)}`,
        );
      }
      if (Object.is(value, -0)) {
        return "0";
      }
      return String(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map(item => jcsSerialize(item)).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const members = keys.map(key => `${JSON.stringify(key)}:${jcsSerialize(record[key])}`);
      return `{${members.join(",")}}`;
    }
    default:
      // undefined, function, symbol, bigint
      throw new TypeError(`jcsSerialize: unsupported value of type ${typeof value}`);
  }
}

/**
 * Computes `requirementsHash = keccak256(utf8(jcs(paymentRequirements)))` for
 * the selected `accepts[]` entry.
 *
 * @param requirements - The exact `accepts[]` entry (as received on the wire)
 * @returns The 32-byte requirements hash as a 0x-prefixed hex string
 */
export function computeRequirementsHash(requirements: unknown): Hex {
  return keccak256(stringToBytes(jcsSerialize(requirements)));
}

/**
 * Computes `quoteIdHash = keccak256(utf8(quoteId))` for an opaque quote
 * identifier.
 *
 * @param quoteId - The opaque quote identifier from the quote response
 * @returns The 32-byte quote-id hash as a 0x-prefixed hex string
 */
export function computeQuoteIdHash(quoteId: string): Hex {
  return keccak256(stringToBytes(quoteId));
}

/**
 * Derives the EIP-3009 nonce that binds a `ReceiveWithAuthorization`
 * signature to one quote and one set of payment requirements:
 * `keccak256(abi.encode(quoteIdHash, requirementsHash))`.
 *
 * @param quoteIdHash - The 32-byte quote-id hash (0x-hex)
 * @param requirementsHash - The 32-byte requirements hash (0x-hex)
 * @returns The 32-byte EIP-3009 nonce as a 0x-prefixed hex string
 * @throws {TypeError} If either input is not a 32-byte 0x-prefixed hex string
 */
export function deriveEip3009Nonce(quoteIdHash: string, requirementsHash: string): Hex {
  if (!BYTES32_PATTERN.test(quoteIdHash)) {
    throw new TypeError(`deriveEip3009Nonce: quoteIdHash must be 32-byte 0x-hex`);
  }
  if (!BYTES32_PATTERN.test(requirementsHash)) {
    throw new TypeError(`deriveEip3009Nonce: requirementsHash must be 32-byte 0x-hex`);
  }
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [quoteIdHash as Hex, requirementsHash as Hex],
    ),
  );
}
