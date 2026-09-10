import LZString from "lz-string";

import {
  MAX_MASUMI_IDENTIFIER_COMPRESSED_BYTES,
  MAX_MASUMI_IDENTIFIER_TEXT_CHARS,
} from "../../limits";
import { decompressLzStringBounded } from "./boundedLz";

/**
 * The Masumi compatibility identifier — a lookup key that lets Masumi tooling
 * locate an x402 payment.
 *
 * ```text
 * identifierText =
 *   (sellerNonceHex + agentIdentifierHex) + "." +
 *   buyerNonceHex + "." + referenceSignatureHex + "." +
 *   referenceKeyHex + "." + contractAddressBech32
 *
 * blockchainIdentifier = hex(LZString.compressToUint8Array(identifierText))
 * ```
 *
 * The encoded *text* values are joined before compression; the first four
 * segments are never hex-decoded first. Segment two may be empty and the empty
 * segment is preserved.
 */

/** `sellerNonce` occupies the first 64 characters of segment one. */
const SELLER_NONCE_HEX_LENGTH = 64;

/** The five period-delimited segments of a decoded identifier. */
export interface MasumiIdentifierParts {
  sellerNonce: string;
  /** Empty when the seller is unregistered. */
  agentIdentifier: string;
  buyerNonce: string;
  referenceSignature: string;
  referenceKey: string;
  contractAddress: string;
}

/**
 * Builds the exact `identifierText` for a payment.
 *
 * @param parts - The identifier segments.
 * @returns The period-delimited ASCII text.
 */
export function buildIdentifierText(parts: MasumiIdentifierParts): string {
  return [
    parts.sellerNonce + parts.agentIdentifier,
    parts.buyerNonce,
    parts.referenceSignature,
    parts.referenceKey,
    parts.contractAddress,
  ].join(".");
}

/**
 * Encodes an identifier as the wire `blockchainIdentifier`.
 *
 * @param parts - The identifier segments.
 * @returns Lowercase hex of the LZString-compressed identifier text.
 */
export function encodeBlockchainIdentifier(parts: MasumiIdentifierParts): string {
  const text = buildIdentifierText(parts);
  if (text.length > MAX_MASUMI_IDENTIFIER_TEXT_CHARS) {
    throw new Error("Masumi identifier text exceeds the character limit");
  }
  const compressed = LZString.compressToUint8Array(text);
  if (compressed.length > MAX_MASUMI_IDENTIFIER_COMPRESSED_BYTES) {
    throw new Error("Masumi identifier exceeds the compressed byte limit");
  }
  return Buffer.from(compressed).toString("hex").toLowerCase();
}

/**
 * Decodes a wire `blockchainIdentifier` back into its five segments.
 *
 * Total: returns `null` when the value is not hex, does not decompress, or does
 * not carry exactly five segments with a 64-character seller nonce.
 *
 * @param blockchainIdentifier - Lowercase hex of the compressed identifier.
 * @returns The decoded segments, or `null`.
 */
export function decodeBlockchainIdentifier(
  blockchainIdentifier: string,
): MasumiIdentifierParts | null {
  if (
    blockchainIdentifier.length === 0 ||
    blockchainIdentifier.length % 2 !== 0 ||
    blockchainIdentifier.length / 2 > MAX_MASUMI_IDENTIFIER_COMPRESSED_BYTES
  ) {
    return null;
  }
  if (!/^[0-9a-f]+$/.test(blockchainIdentifier)) return null;
  const text = decompressLzStringBounded(
    Uint8Array.from(Buffer.from(blockchainIdentifier, "hex")),
    MAX_MASUMI_IDENTIFIER_TEXT_CHARS,
  );
  if (!text || text.length > MAX_MASUMI_IDENTIFIER_TEXT_CHARS) return null;
  const segments = text.split(".");
  if (segments.length !== 5) return null;
  const [sellerIdentifier, buyerNonce, referenceSignature, referenceKey, contractAddress] =
    segments;
  if (sellerIdentifier.length < SELLER_NONCE_HEX_LENGTH) return null;
  return {
    sellerNonce: sellerIdentifier.slice(0, SELLER_NONCE_HEX_LENGTH),
    agentIdentifier: sellerIdentifier.slice(SELLER_NONCE_HEX_LENGTH),
    buyerNonce,
    referenceSignature,
    referenceKey,
    contractAddress,
  };
}
