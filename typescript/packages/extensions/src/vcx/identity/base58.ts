/**
 * Copyright 2026 PayPal Holdings, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const BASE58_BTC_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const BASE58_BTC_LOOKUP = new Map(
  [...BASE58_BTC_ALPHABET].map((character, index) => [character, index]),
);

/**
 * Encode bytes as a base58btc multibase string, prefixing the result
 * with the `z` multibase code point per the multibase specification.
 *
 * @param bytes - The raw bytes to encode.
 * @returns The `z`-prefixed base58btc multibase string.
 */
export function base58btcEncode(bytes: Uint8Array): string {
  return `z${base58Encode(bytes)}`;
}

/**
 * Decode a base58btc multibase string back to its raw bytes, requiring
 * and stripping the leading `z` multibase code point.
 *
 * @param value - The `z`-prefixed base58btc multibase string.
 * @returns The decoded raw bytes.
 */
export function base58btcDecode(value: string): Uint8Array {
  if (!value.startsWith("z")) {
    throw new Error("Expected base58btc multibase value");
  }
  return base58Decode(value.slice(1));
}

/**
 * Encode bytes as a base58 string using the Bitcoin alphabet, preserving
 * leading zero bytes as leading `1` characters.
 *
 * @param bytes - The raw bytes to encode.
 * @returns The base58-encoded string.
 */
export function base58Encode(bytes: Uint8Array): string {
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes += 1;
  if (zeroes === bytes.length) return "1".repeat(zeroes);

  const digits = [0];
  for (let byteIndex = zeroes; byteIndex < bytes.length; byteIndex += 1) {
    const byte = bytes[byteIndex];
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      const value = digits[i] * 256 + carry;
      digits[i] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let encoded = "1".repeat(zeroes);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    encoded += BASE58_BTC_ALPHABET[digits[i]];
  }
  return encoded;
}

/**
 * Decode a base58 string (Bitcoin alphabet) back to its raw bytes,
 * restoring leading `1` characters as leading zero bytes. Throws on any
 * character outside the base58 alphabet.
 *
 * @param value - The base58-encoded string.
 * @returns The decoded raw bytes.
 */
function base58Decode(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array();

  let zeroes = 0;
  while (zeroes < value.length && value[zeroes] === "1") zeroes += 1;

  const bytes = [0];
  for (let valueIndex = zeroes; valueIndex < value.length; valueIndex += 1) {
    const digit = BASE58_BTC_LOOKUP.get(value[valueIndex]);
    if (digit === undefined) {
      throw new Error("Invalid base58btc character");
    }

    let carry = digit;
    for (let i = 0; i < bytes.length; i += 1) {
      const next = bytes[i] * 58 + carry;
      bytes[i] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (let i = 0; i < zeroes; i += 1) {
    bytes.push(0);
  }

  return Uint8Array.from(bytes.reverse());
}
