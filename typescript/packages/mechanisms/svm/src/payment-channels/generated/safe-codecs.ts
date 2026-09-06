/**
 * Vendored from
 * https://github.com/solana-foundation/payment-channel/blob/main/clients/typescript/src/safe-codecs.ts
 *
 * Drop-in replacement for @solana/kit's number codecs. Re-exports everything
 * unchanged except the u64/u128/i64/i128 encoders, which reject unsafe-integer
 * JS numbers at runtime and narrow the input type to plain `bigint`.
 */

import {
  type FixedSizeEncoder,
  getI64Encoder as kitI64Encoder,
  getI128Encoder as kitI128Encoder,
  getU64Encoder as kitU64Encoder,
  getU128Encoder as kitU128Encoder,
} from "@solana/kit";

export * from "@solana/kit";

const U64_MAX = 0xffffffffffffffffn;
const U128_MAX = 0xffffffffffffffffffffffffffffffffn;
const I64_MIN = -0x8000000000000000n;
const I64_MAX = 0x7fffffffffffffffn;
const I128_MIN = -0x80000000000000000000000000000000n;
const I128_MAX = 0x7fffffffffffffffffffffffffffffffn;

/**
 *
 * @param label
 * @param value
 * @param min
 * @param max
 */
function coerce(label: string, value: bigint | number, min: bigint, max: bigint): bigint {
  if (typeof value === "bigint") {
    if (value < min || value > max) {
      throw new RangeError(`${label}: value ${value} out of range [${min}, ${max}]`);
    }
    return value;
  }

  if (typeof value !== "number") {
    throw new TypeError(`${label}: expected bigint, got ${typeof value}`);
  }

  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `${label}: expected bigint; got number ${value}. ` +
        "JS numbers above 2^53-1 round silently, pass BigInt(...) instead.",
    );
  }

  const bn = BigInt(value);
  if (bn < min || bn > max) {
    throw new RangeError(`${label}: value ${bn} out of range [${min}, ${max}]`);
  }
  return bn;
}

/**
 *
 * @param label
 * @param inner
 * @param min
 * @param max
 */
function guardEncoder<Size extends number>(
  label: string,
  inner: FixedSizeEncoder<bigint | number, Size>,
  min: bigint,
  max: bigint,
): FixedSizeEncoder<bigint, Size> {
  return {
    encode(value) {
      return inner.encode(coerce(label, value as bigint | number, min, max));
    },
    fixedSize: inner.fixedSize,
    write(value, bytes, offset) {
      return inner.write(coerce(label, value as bigint | number, min, max), bytes, offset);
    },
  };
}

/**
 *
 */
export function getU64Encoder(): FixedSizeEncoder<bigint, 8> {
  return guardEncoder("u64", kitU64Encoder(), 0n, U64_MAX);
}

/**
 *
 */
export function getU128Encoder(): FixedSizeEncoder<bigint, 16> {
  return guardEncoder("u128", kitU128Encoder(), 0n, U128_MAX);
}

/**
 *
 */
export function getI64Encoder(): FixedSizeEncoder<bigint, 8> {
  return guardEncoder("i64", kitI64Encoder(), I64_MIN, I64_MAX);
}

/**
 *
 */
export function getI128Encoder(): FixedSizeEncoder<bigint, 16> {
  return guardEncoder("i128", kitI128Encoder(), I128_MIN, I128_MAX);
}
