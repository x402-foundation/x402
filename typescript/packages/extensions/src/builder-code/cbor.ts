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
 *   "m" — facilitator-authored settlement metadata (map of unsigned integers, strings, arrays, and maps)
 */

import { type Hex } from "viem";
import {
  ERC_8021_MARKER,
  SCHEMA_2_ID,
  type BuilderCodeExtensionData,
  type SettlementMetadata,
  type SettlementMetadataValue,
  type BuilderCodeSuffixData,
} from "./types";

const MAX_CBOR_LENGTH = 0xffff;
const MAX_UINT64 = (1n << 64n) - 1n;

/** CBOR additional-information values 24-27 and the byte width of the argument each introduces. */
const CBOR_ARGUMENT_WIDTHS = [
  { info: 24, bytes: 1 },
  { info: 25, bytes: 2 },
  { info: 26, bytes: 4 },
  { info: 27, bytes: 8 },
];

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
 * - "m" key (major type 3, length 1) → map of settlement metadata
 *
 * Uses hand-rolled CBOR to avoid adding a dependency.
 *
 * @param data - Builder code suffix fields to encode
 * @returns CBOR-encoded map bytes
 */
function encodeCborMap(data: BuilderCodeSuffixData): Uint8Array {
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

  if (data.m) {
    mapSize++;
    entries.push(encodeCborString("m"));
    entries.push(encodeCborValue(data.m));
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
 * - 65536-2^32-1: five bytes (major type << 5 | 26, 4-byte big-endian value)
 * - 2^32-2^64-1: nine bytes (major type << 5 | 27, 8-byte big-endian value)
 *
 * @param majorType - CBOR major type (0–7)
 * @param value - Argument length or inline value for the header
 * @returns CBOR header bytes
 */
function encodeCborMajorType(majorType: number, value: number | bigint): Uint8Array {
  const mt = majorType << 5;
  const argument = BigInt(value);

  if (argument < 0n || argument > MAX_UINT64) {
    throw new Error(`CBOR value out of range: ${value}`);
  }
  if (argument <= 23n) {
    return new Uint8Array([mt | Number(argument)]);
  }

  const width = CBOR_ARGUMENT_WIDTHS.find(({ bytes }) => argument < 1n << BigInt(bytes * 8));
  if (!width) {
    throw new Error(`CBOR value out of range: ${value}`);
  }

  const header = new Uint8Array(1 + width.bytes);
  header[0] = mt | width.info;
  for (let i = 0; i < width.bytes; i++) {
    header[width.bytes - i] = Number((argument >> BigInt(i * 8)) & 0xffn);
  }
  return header;
}

/**
 * Concatenates byte arrays in order.
 *
 * @param parts - Byte arrays to join
 * @returns Single byte array holding all parts
 */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Compares byte arrays lexicographically, as required for deterministic CBOR map key order.
 *
 * @param a - First byte array
 * @param b - Second byte array
 * @returns Negative when a sorts first, positive when b sorts first, zero when equal
 */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const common = Math.min(a.length, b.length);
  for (let i = 0; i < common; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Encodes a settlement metadata value: unsigned integer, text string, array, or map.
 *
 * @param value - Metadata value to encode
 * @returns CBOR-encoded value bytes
 */
function encodeCborValue(value: SettlementMetadataValue): Uint8Array {
  if (typeof value === "string") {
    return encodeCborString(value);
  }
  if (typeof value === "number" || typeof value === "bigint") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error(`CBOR metadata number must be a safe integer, use bigint instead: ${value}`);
    }
    return encodeCborMajorType(0, value); // major type 0 = unsigned integer
  }
  if (isMetadataArray(value)) {
    return concatBytes([encodeCborMajorType(4, value.length), ...value.map(encodeCborValue)]);
  }

  // Runtime guard: the type system is not enforced for JS callers, and Object.entries would
  // silently turn booleans, dates, functions and typed arrays into empty or index-keyed maps.
  if (!isPlainObject(value)) {
    throw new Error(`Unsupported CBOR metadata value: ${describeValue(value)}`);
  }

  // Deterministic encoding: keys sorted bytewise by their encoded form (RFC 8949 section 4.2.1)
  const entries = Object.entries(value)
    .map(([key, entry]) => ({ key: encodeCborString(key), value: encodeCborValue(entry) }))
    .sort((a, b) => compareBytes(a.key, b.key));
  return concatBytes([
    encodeCborMajorType(5, entries.length),
    ...entries.flatMap(entry => [entry.key, entry.value]),
  ]);
}

/**
 * Checks that a value is a plain object (prototype is `Object.prototype` or `null`).
 *
 * @param value - Value to check
 * @returns True when the value is a plain object
 */
function isPlainObject(value: unknown): value is Record<string, SettlementMetadataValue> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Describes an unsupported value for error messages without serializing its contents.
 *
 * @param value - Unsupported value
 * @returns Short type description
 */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") return value.constructor?.name ?? "object";
  return typeof value;
}

/**
 * Narrows a metadata value to an array. `Array.isArray` does not narrow readonly arrays.
 *
 * @param value - Non-scalar metadata value
 * @returns True when the value is an array
 */
function isMetadataArray(
  value: Exclude<SettlementMetadataValue, string | number | bigint>,
): value is readonly SettlementMetadataValue[] {
  return Array.isArray(value);
}

/**
 * Builds a complete ERC-8021 Schema 2 data suffix from builder code data.
 *
 * Format: [cbor_data][suffix_data_length (2 bytes)][schema_id (1 byte)][marker (16 bytes)]
 *
 * The suffix_data_length covers the cbor_data only (not itself, schema_id, or marker).
 *
 * @param data - Builder code suffix data with "a", "w", "s", and/or "m" fields
 * @returns Hex-encoded suffix bytes (without 0x prefix) ready to append to calldata
 * @throws When the CBOR data exceeds the 2-byte suffix_data_length
 */
export function encodeBuilderCodeSuffix(data: BuilderCodeSuffixData): Hex {
  const cborBytes = encodeCborMap(data);
  const cborLength = cborBytes.length;
  if (cborLength > MAX_CBOR_LENGTH) {
    throw new Error(`Builder code CBOR data is ${cborLength} bytes, maximum is ${MAX_CBOR_LENGTH}`);
  }

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
): BuilderCodeSuffixData | undefined {
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

  const result: BuilderCodeSuffixData = {};
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

    if (key === "m") {
      const cursor = { bytes, offset: o };
      try {
        result.m = readCborMap(cursor);
      } catch {
        return undefined;
      }
      o = cursor.offset;
      continue;
    }

    return undefined;
  }

  return result;
}

interface CborCursor {
  bytes: Uint8Array;
  offset: number;
}

/**
 * Reads the major type of the next CBOR item without consuming it.
 *
 * @param cursor - Read position
 * @returns CBOR major type (0–7)
 */
function peekMajorType(cursor: CborCursor): number {
  if (cursor.offset >= cursor.bytes.length) {
    throw new Error("Unexpected end of CBOR data");
  }
  return cursor.bytes[cursor.offset] >> 5;
}

/**
 * Reads a CBOR item header argument (inline value or 1, 2, 4, or 8 extra bytes).
 *
 * @param cursor - Read position, advanced past the argument
 * @returns Argument value
 */
function readCborArgument(cursor: CborCursor): bigint {
  peekMajorType(cursor);
  const info = cursor.bytes[cursor.offset++] & 0x1f;
  if (info <= 23) {
    return BigInt(info);
  }

  const width = CBOR_ARGUMENT_WIDTHS.find(w => w.info === info);
  if (!width || cursor.offset + width.bytes > cursor.bytes.length) {
    throw new Error("Unsupported CBOR argument");
  }

  let argument = 0n;
  for (let i = 0; i < width.bytes; i++) {
    argument = (argument << 8n) | BigInt(cursor.bytes[cursor.offset++]);
  }
  return argument;
}

/**
 * Reads a CBOR length (string byte length, array size, or map size).
 *
 * @param cursor - Read position, advanced past the length argument
 * @returns Length, bounded by the remaining bytes since every element takes at least one byte
 */
function readCborLength(cursor: CborCursor): number {
  const length = readCborArgument(cursor);
  if (length > BigInt(cursor.bytes.length - cursor.offset)) {
    throw new Error("CBOR length exceeds available data");
  }
  return Number(length);
}

/**
 * Reads a CBOR text string (major type 3).
 *
 * @param cursor - Read position, advanced past the string
 * @returns Decoded text
 */
function readCborText(cursor: CborCursor): string {
  if (peekMajorType(cursor) !== 3) {
    throw new Error("Expected CBOR text string");
  }
  const length = readCborLength(cursor);
  const text = new TextDecoder().decode(
    cursor.bytes.subarray(cursor.offset, cursor.offset + length),
  );
  cursor.offset += length;
  return text;
}

/**
 * Reads a settlement metadata value. Unsigned integers are returned as bigint.
 *
 * @param cursor - Read position, advanced past the value
 * @returns Decoded metadata value
 */
function readCborValue(cursor: CborCursor): SettlementMetadataValue {
  switch (peekMajorType(cursor)) {
    case 0:
      return readCborArgument(cursor);
    case 3:
      return readCborText(cursor);
    case 4: {
      const items: SettlementMetadataValue[] = [];
      for (let remaining = readCborLength(cursor); remaining > 0; remaining--) {
        items.push(readCborValue(cursor));
      }
      return items;
    }
    case 5:
      return readCborMap(cursor);
    default:
      throw new Error("Unsupported CBOR type in metadata");
  }
}

/**
 * Reads a CBOR map with text keys (major type 5).
 *
 * @param cursor - Read position, advanced past the map
 * @returns Decoded metadata map
 */
function readCborMap(cursor: CborCursor): SettlementMetadata {
  if (peekMajorType(cursor) !== 5) {
    throw new Error("Expected CBOR map");
  }

  const entries: [string, SettlementMetadataValue][] = [];
  for (let remaining = readCborLength(cursor); remaining > 0; remaining--) {
    entries.push([readCborText(cursor), readCborValue(cursor)]);
  }
  return Object.fromEntries(entries);
}
