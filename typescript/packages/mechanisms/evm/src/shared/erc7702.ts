/**
 * Detection utilities for the ERC-7702 delegation designation (`0xef0100 + 20-byte address`).
 *
 * NOTE: These helpers are diagnostic only. The signature-verification path does
 * not branch on 7702 detection — it routes by `code.length` (matching on-chain
 * SignatureChecker) and the delegate decides via `isValidSignature`. See
 * {@link ./verifySignature.ts} for the verification primitive.
 *
 * Use these helpers for telemetry, logging, or surfacing wallet types in UIs.
 */

const ERC7702_PREFIX = "0xef0100";
const ERC7702_BYTECODE_LENGTH = 48; // "0x" + 6 hex chars (prefix) + 40 hex chars (address)

/**
 * Returns `true` if `bytecode` is a valid ERC-7702 delegation designation.
 *
 * The check is case-insensitive — `eth_getCode` casing is not normalized at the
 * JSON-RPC layer, so callers using ethers, custom signers, or post-processed
 * hex can pass uppercase variants.
 *
 * @param bytecode - Raw hex bytecode returned by `eth_getCode`.
 * @returns `true` if the bytecode is an ERC-7702 delegation designation.
 */
export function isERC7702Delegation(bytecode: `0x${string}` | undefined | null): boolean {
  if (!bytecode || bytecode === "0x") return false;
  if (bytecode.length !== ERC7702_BYTECODE_LENGTH) return false;
  return bytecode.toLowerCase().startsWith(ERC7702_PREFIX);
}

/**
 * Extracts the 20-byte delegate address from a 7702 delegation designation.
 * Returns the address in **lowercase** hex with a `0x` prefix.
 * The Go equivalent ({@link GetERC7702DelegateAddress}) returns a checksummed EIP-55 address.
 * The Python equivalent returns lowercase hex. Normalise with `getAddress()` when comparing
 * cross-SDK outputs or storing in a case-sensitive index.
 * Returns `null` for non-7702 bytecode.
 *
 * @param bytecode - Raw hex bytecode returned by `eth_getCode`.
 * @returns The lowercase `0x`-prefixed delegate address, or `null` if `bytecode` is not a 7702 designation.
 */
export function getERC7702DelegateAddress(
  bytecode: `0x${string}` | undefined | null,
): `0x${string}` | null {
  if (!isERC7702Delegation(bytecode)) return null;
  return ("0x" + bytecode!.slice(8).toLowerCase()) as `0x${string}`;
}
