/**
 * ERC-8021 Schema 2 CBOR encoding for builder code suffixes.
 *
 * Schema 2 suffix format:
 *   [cbor_data (variable)] [suffix_data_length (2 bytes)] [schema_id = 0x02 (1 byte)] [ERC-8021 marker (16 bytes)]
 *
 * CBOR payload uses single-letter keys:
 *   "a" — app builder code (string)
 *   "s" — service codes (string array)
 */

import { type Hex } from "viem";
import { ERC_8021_MARKER, SCHEMA_2_ID, type BuilderCodeExtensionData } from "./types";

/**
 * Encodes a CBOR map from builder code extension data.
 *
 * Produces a minimal CBOR map with:
 * - "a" key (major type 3, length 1) → string value
 * - "s" key (major type 3, length 1) → array of strings
 *
 * Uses hand-rolled CBOR to avoid adding a dependency.
 */
function encodeCborMap(data: BuilderCodeExtensionData): Uint8Array {
  const entries: Uint8Array[] = [];
  let mapSize = 0;

  if (data.a) {
    mapSize++;
    entries.push(encodeCborString("a"));
    entries.push(encodeCborString(data.a));
  }

  if (data.s && data.s.length > 0) {
    mapSize++;
    entries.push(encodeCborString("s"));
    entries.push(encodeCborArray(data.s));
  }

  // CBOR map header
  const header = encodeCborMajorType(5, mapSize); // major type 5 = map

  const totalLength = header.length + entries.reduce((sum, e) => sum + e.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  result.set(header, offset);
  offset += header.length;

  for (const entry of entries) {
    result.set(entry, offset);
    offset += entry.length;
  }

  return result;
}

/**
 * Encodes a CBOR text string (major type 3).
 */
function encodeCborString(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const header = encodeCborMajorType(3, encoded.length); // major type 3 = text string
  const result = new Uint8Array(header.length + encoded.length);
  result.set(header, 0);
  result.set(encoded, header.length);
  return result;
}

/**
 * Encodes a CBOR array of strings (major type 4).
 */
function encodeCborArray(values: string[]): Uint8Array {
  const header = encodeCborMajorType(4, values.length); // major type 4 = array
  const encodedValues = values.map(encodeCborString);

  const totalLength = header.length + encodedValues.reduce((sum, e) => sum + e.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  result.set(header, offset);
  offset += header.length;

  for (const encoded of encodedValues) {
    result.set(encoded, offset);
    offset += encoded.length;
  }

  return result;
}

/**
 * Encodes a CBOR major type with an argument value.
 *
 * CBOR encoding rules:
 * - 0-23: single byte (major type << 5 | value)
 * - 24-255: two bytes (major type << 5 | 24, value)
 * - 256-65535: three bytes (major type << 5 | 25, value high, value low)
 */
function encodeCborMajorType(majorType: number, value: number): Uint8Array {
  const mt = majorType << 5;

  if (value <= 23) {
    return new Uint8Array([mt | value]);
  }
  if (value <= 0xff) {
    return new Uint8Array([mt | 24, value]);
  }
  if (value <= 0xffff) {
    return new Uint8Array([mt | 25, (value >> 8) & 0xff, value & 0xff]);
  }

  throw new Error(`CBOR value too large: ${value}`);
}

/**
 * Builds a complete ERC-8021 Schema 2 data suffix from builder code data.
 *
 * Format: [cbor_data][suffix_data_length (2 bytes)][schema_id (1 byte)][marker (16 bytes)]
 *
 * The suffix_data_length covers the cbor_data only (not itself, schema_id, or marker).
 *
 * @param data - Builder code extension data with "a" and/or "s" fields
 * @returns Hex-encoded suffix bytes (without 0x prefix) ready to append to calldata
 */
export function encodeBuilderCodeSuffix(data: BuilderCodeExtensionData): Hex {
  const cborBytes = encodeCborMap(data);
  const cborLength = cborBytes.length;

  // suffix_data_length is 2 bytes, big-endian
  const lengthHigh = (cborLength >> 8) & 0xff;
  const lengthLow = cborLength & 0xff;

  // Build the full suffix: [cbor][length 2B][schema_id 1B][marker 16B]
  const suffixBytes = new Uint8Array(cborLength + 2 + 1 + 16);
  let offset = 0;

  // CBOR data
  suffixBytes.set(cborBytes, offset);
  offset += cborLength;

  // Suffix data length (2 bytes, big-endian)
  suffixBytes[offset++] = lengthHigh;
  suffixBytes[offset++] = lengthLow;

  // Schema ID
  suffixBytes[offset++] = SCHEMA_2_ID;

  // ERC-8021 marker (16 bytes)
  const markerBytes = hexToBytes(ERC_8021_MARKER);
  suffixBytes.set(markerBytes, offset);

  return `0x${bytesToHex(suffixBytes)}`;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
