import {
  DECIMAL_FELT_REGEX,
  HEX_FELT_REGEX,
  STARK_PRIME,
  STARKNET_ADDRESS_REGEX,
  U128_MAX,
} from "./constants";
import { chainIdToFelt } from "./typed-data";

/**
 * Compares two felt values numerically. Starknet addresses have no canonical
 * padding or case, so string comparison is unsafe.
 *
 * @param a - First felt value
 * @param b - Second felt value
 * @returns True when the two values are numerically equal
 */
export function feltEquals(a: string | number | bigint, b: string | number | bigint): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

/**
 * Parses a Cairo u256 returned as `[low, high]` felts into a bigint.
 *
 * Returns null when the response cannot be read as a u256 at all - a short
 * array, a non-numeric limb, or a limb outside u128 range. That is a fact about
 * the RESPONSE, not about the account it describes, so it is kept distinct from
 * a real zero: reporting an unreadable balance as `0` would surface as
 * `insufficient_funds` about the payer for something the facilitator never read.
 *
 * @param result - The `[low, high]` felt array
 * @returns The combined u256 value, or null when the response is unreadable
 */
export function parseU256(result: string[]): bigint | null {
  if (!Array.isArray(result) || result.length < 2) return null;
  try {
    const low = BigInt(result[0]);
    const high = BigInt(result[1]);
    if (low < 0n || high < 0n || low > U128_MAX || high > U128_MAX) return null;
    return low + (high << 128n);
  } catch {
    return null;
  }
}

/**
 * Validates a Starknet address: a 0x-prefixed felt of 1 to 64 hex digits whose
 * value is a non-zero field element.
 *
 * The grammar alone admits values up to 2^256, so it accepts strings no account
 * can ever live at. Those are caught later by starknet.js's own range assertion,
 * deep inside hashing, where the failure reads as a malformed client payload
 * even when the offending address came from the server's own requirements.
 * Bounding the value here keeps the blame where it belongs.
 *
 * @param address - The address to validate
 * @returns True when the address is well-formed and in range
 */
export function isValidStarknetAddress(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  // Single source of truth, shared with the client scheme: an un-prefixed hex
  // string is not an address, and accepting one here let the two layers
  // disagree about the same value.
  if (!STARKNET_ADDRESS_REGEX.test(address)) return false;
  return isFieldElement(address);
}

/**
 * Whether a felt string's value is a non-zero element of the Cairo field.
 * Assumes the caller has already checked the grammar.
 *
 * @param felt - The felt string to bound
 * @returns True when the value is in `(0, STARK_PRIME)`
 */
export function isFieldElement(felt: string): boolean {
  try {
    const value = BigInt(felt);
    return value > 0n && value < STARK_PRIME;
  } catch {
    return false;
  }
}

/**
 * Checks whether a value is a felt in hex or decimal form.
 *
 * Length-bounded: a felt is at most 252 bits, so 64 hex digits (or 78 decimal)
 * covers every legal value. Without the bound, a felt-count cap would limit the
 * number of elements while each stayed arbitrarily long, and the oversized
 * payload would still be compiled and shipped to the node.
 *
 * @param value - The candidate felt string
 * @returns True when the string parses as a felt
 */
export function isFeltString(value: string): boolean {
  return HEX_FELT_REGEX.test(value) || DECIMAL_FELT_REGEX.test(value);
}

/**
 * Parses a base-10 atomic-unit amount string. Rejects hex, octal, binary, and
 * whitespace.
 *
 * @param amount - The amount string
 * @returns The amount as a bigint
 */
export function parseAmount(amount: string): bigint {
  if (typeof amount !== "string" || !/^[0-9]+$/.test(amount)) {
    throw new Error("amount must be a base-10 integer string");
  }
  return BigInt(amount);
}

/**
 * Compares two base-10 amount strings numerically. Returns false if either is
 * malformed.
 *
 * @param a - First amount string
 * @param b - Second amount string
 * @returns True when the two amounts are numerically equal
 */
export function amountStringEquals(a: string, b: string): boolean {
  if (!/^[0-9]+$/.test(a) || !/^[0-9]+$/.test(b)) return false;
  return BigInt(a) === BigInt(b);
}

/**
 * Resolves a chainId to its felt value, returning -1 on any parse failure so
 * callers can compare without throwing.
 *
 * @param chainId - The chain id as hex, decimal, or short string
 * @returns The chain id felt value, or -1 when unparseable
 */
export function chainIdSafeToFelt(chainId: string): bigint {
  try {
    return chainIdToFelt(chainId);
  } catch {
    return -1n;
  }
}
