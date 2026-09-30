/**
 * ERC-8021 Schema 2 CBOR encoding for builder code suffixes.
 *
 * Schema 2 suffix format:
 *   [cbor_data (variable)] [suffix_data_length (2 bytes)] [schema_id = 0x02 (1 byte)] [ERC-8021 marker (16 bytes)]
 *
 * CBOR payload uses single-letter keys:
 *   "a" — app builder code (string)
 *   "w" — wallet/facilitator builder code (string)
 *   "s" — service codes (string array)
 */

import { type Hex } from "viem";
import { ERC_8021_MARKER, SCHEMA_2_ID, type BuilderCodeExtensionData } from "./types";

/**
 * Normalizes the `s` field (string or array of strings) into an array of strings.
 *
 * @param s - Service code value as a string, array of strings, or undefined
 * @returns Array of service code strings (empty when absent)
 */
function normalizeServiceCodes(s: BuilderCodeExtensionData["s"]): string[] {
  if (typeof s === "string") return [s];
  if (Array.isArray(s)) return s;
  return [];
}

/**
 * Encodes a CBOR map from builder code extension data.
 *
 * Produces a minimal CBOR map with:
 * - "a" key (major type 3, length 1) → string value (app/service code)
 * - "w" key (major type 3, length 1) → string value (facilitator code)
 * - "s" key (major type 3, length 1) → array of strings (related services)
 *
 * Uses hand-rolled CBOR to avoid adding a dependency.
 *
 * @param data - Builder code extension fields to encode
 * @returns CBOR-encoded map bytes
 */
function encodeCborMap(data: BuilderCodeExtensionData): Uint8Array {
  const entries: Uint8Array[] = [];
  let mapSize = 0;

  if (data.a) {
    mapSize++;
    entries.push(encodeCborString("a"));
    entries.push(encodeCborString(data.a));
  }

  if (data.w) {
    mapSize++;
    entries.push(encodeCborString("w"));
    entries.push(encodeCborString(data.w));
  }

  const serviceCodes = normalizeServiceCodes(data.s);
  if (serviceCodes.length > 0) {
    mapSize++;
    entries.push(encodeCborString("s"));
    entries.push(encodeCborArray(serviceCodes));
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
 *
 * @param value - UTF-8 text to encode
 * @returns CBOR-encoded text string bytes
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
 *
 * @param values - UTF-8 strings to encode as array elements
 * @returns CBOR-encoded array bytes
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
 *
 * @param majorType - CBOR major type (0–7)
 * @param value - Argument length or inline value for the header
 * @returns CBOR header bytes
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

/**
 * Converts a hex string (without 0x prefix) to bytes.
 *
 * @param hex - Hex-encoded string (two characters per byte)
 * @returns Decoded byte array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Converts bytes to a lowercase hex string (without 0x prefix).
 *
 * @param bytes - Raw bytes to encode
 * @returns Lowercase hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Parses ERC-8021 Schema 2 builder code attribution from settlement calldata.
 *
 * @param calldata - Full transaction input data
 * @returns Decoded builder code fields, or undefined if no valid suffix is present
 */
export function parseBuilderCodeSuffixFromCalldata(
  calldata: Hex,
): BuilderCodeExtensionData | undefined {
  const hex = calldata.startsWith("0x") ? calldata.slice(2) : calldata;
  const markerPos = hex.lastIndexOf(ERC_8021_MARKER.toLowerCase());
  if (markerPos < 6) {
    return undefined;
  }

  if (parseInt(hex.slice(markerPos - 2, markerPos), 16) !== SCHEMA_2_ID) {
    return undefined;
  }

  const cborLength = parseInt(hex.slice(markerPos - 6, markerPos - 2), 16);
  const suffixStart = markerPos - 6 - cborLength * 2;
  if (suffixStart < 0 || suffixStart + (cborLength + 19) * 2 !== hex.length) {
    return undefined;
  }

  const bytes = hexToBytes(hex.slice(suffixStart, markerPos - 6));
  let o = 0;

  if (bytes[o] >> 5 !== 5) {
    return undefined;
  }

  const mapInfo = bytes[o++] & 0x1f;
  const mapSize = mapInfo <= 23 ? mapInfo : mapInfo === 24 ? bytes[o++] : undefined;
  if (mapSize === undefined) {
    return undefined;
  }

  const result: BuilderCodeExtensionData = {};
  for (let entry = 0; entry < mapSize; entry++) {
    if (bytes[o] >> 5 !== 3) {
      return undefined;
    }

    const keyInfo = bytes[o++] & 0x1f;
    const keyLen = keyInfo <= 23 ? keyInfo : keyInfo === 24 ? bytes[o++] : undefined;
    if (keyLen === undefined) {
      return undefined;
    }

    const key = new TextDecoder().decode(bytes.subarray(o, o + keyLen));
    o += keyLen;

    if (key === "a" || key === "w") {
      if (bytes[o] >> 5 !== 3) {
        return undefined;
      }

      const valueInfo = bytes[o++] & 0x1f;
      const valueLen = valueInfo <= 23 ? valueInfo : valueInfo === 24 ? bytes[o++] : undefined;
      if (valueLen === undefined) {
        return undefined;
      }

      result[key] = new TextDecoder().decode(bytes.subarray(o, o + valueLen));
      o += valueLen;
      continue;
    }

    if (key === "s") {
      if (bytes[o] >> 5 !== 4) {
        return undefined;
      }

      const arrayInfo = bytes[o++] & 0x1f;
      const arraySize = arrayInfo <= 23 ? arrayInfo : arrayInfo === 24 ? bytes[o++] : undefined;
      if (arraySize === undefined) {
        return undefined;
      }

      const codes: string[] = [];
      for (let i = 0; i < arraySize; i++) {
        if (bytes[o] >> 5 !== 3) {
          return undefined;
        }

        const itemInfo = bytes[o++] & 0x1f;
        const itemLen = itemInfo <= 23 ? itemInfo : itemInfo === 24 ? bytes[o++] : undefined;
        if (itemLen === undefined) {
          return undefined;
        }

        codes.push(new TextDecoder().decode(bytes.subarray(o, o + itemLen)));
        o += itemLen;
      }

      if (codes.length > 0) {
        result.s = codes;
      }
      continue;
    }

    return undefined;
  }

  return result;
}
