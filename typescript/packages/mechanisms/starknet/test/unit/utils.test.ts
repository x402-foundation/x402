import { describe, it, expect } from "vitest";
import { num } from "starknet";
import {
  feltEquals,
  parseU256,
  isValidStarknetAddress,
  parseAmount,
  amountStringEquals,
  chainIdSafeToFelt,
} from "../../src/utils";
import { STARK_PRIME, USDC_SEPOLIA } from "../../src/constants";

// These three cases cast past the declared types on purpose. Each function is
// fed values that arrive over the wire or from an RPC response, where the type
// is asserted rather than validated, so the runtime guards are real protection
// and not redundant with the compiler.

describe("feltEquals", () => {
  it("compares numerically across hex, decimal, number, and bigint forms", () => {
    expect(feltEquals("0x1", "1")).toBe(true);
    expect(feltEquals("0x10", 16)).toBe(true);
    expect(feltEquals(255n, "0xff")).toBe(true);
    expect(feltEquals("0xFF", "255")).toBe(true);
  });

  it("is padding- and case-insensitive for addresses", () => {
    // Leading zero + mixed case vs. the numerically-equal lowercased, unpadded form.
    const padded = USDC_SEPOLIA; // "0x0512feAc6339Ff78..."
    const stripped = "0x" + USDC_SEPOLIA.slice(2).replace(/^0+/, "").toLowerCase();
    expect(feltEquals(padded, stripped)).toBe(true);
    expect(feltEquals("0x01", "0x1")).toBe(true);
  });

  it("returns false for numerically distinct values", () => {
    expect(feltEquals("0x1", "0x2")).toBe(false);
    expect(feltEquals(1, 2)).toBe(false);
  });

  it("returns false (never throws) on unparsable input", () => {
    expect(feltEquals("not-a-felt", "0x1")).toBe(false);
    expect(feltEquals("0x1", "")).toBe(false);
    expect(feltEquals("0xZZ", "0x1")).toBe(false);
  });
});

describe("parseU256", () => {
  it("combines [low, high] limbs into a bigint", () => {
    expect(parseU256(["0x2710", "0x0"])).toBe(10000n);
    expect(parseU256(["0", "0"])).toBe(0n);
  });

  it("shifts the high limb by 128 bits", () => {
    expect(parseU256(["0x0", "0x1"])).toBe(1n << 128n);
    expect(parseU256(["0x5", "0x2"])).toBe(5n + (2n << 128n));
  });

  // An unreadable response is a fact about the RESPONSE, not about the account
  // it describes. Reporting it as a real zero would surface downstream as
  // insufficient_funds about a payer whose balance was never actually read.
  it("returns null for malformed or short input", () => {
    expect(parseU256(["0x1"])).toBeNull();
    expect(parseU256([])).toBeNull();
    expect(parseU256(undefined as unknown as string[])).toBeNull();
  });

  // A limb past u128 is not a u256 this can reconstruct. Combining it anyway
  // would overstate the balance the caller is about to check against.
  it("fails closed when a limb is out of u128 range", () => {
    const overLimb = (1n << 128n).toString();
    expect(parseU256([overLimb, "0x0"])).toBeNull();
    expect(parseU256(["0x0", overLimb])).toBeNull();
  });

  it("accepts limbs at the u128 maximum", () => {
    const max = ((1n << 128n) - 1n).toString();
    expect(parseU256([max, "0x0"])).toBe((1n << 128n) - 1n);
  });

  it("returns null rather than throwing on unparsable limbs", () => {
    expect(parseU256(["not-a-felt", "0x0"])).toBeNull();
  });

  it("still reports a genuine zero balance as zero", () => {
    expect(parseU256(["0x0", "0x0"])).toBe(0n);
  });
});

describe("isValidStarknetAddress", () => {
  it("accepts 0x-prefixed felts of 1 to 64 hex digits", () => {
    expect(isValidStarknetAddress("0x1")).toBe(true);
    expect(isValidStarknetAddress("0xABCdef0123456789")).toBe(true);
    expect(isValidStarknetAddress(num.toHex(STARK_PRIME - 1n))).toBe(true);
  });

  it("rejects empty, non-string, and over-long values", () => {
    expect(isValidStarknetAddress("")).toBe(false);
    expect(isValidStarknetAddress(undefined as unknown as string)).toBe(false);
    expect(isValidStarknetAddress("0x")).toBe(false);
    expect(isValidStarknetAddress("0x" + "a".repeat(65))).toBe(false);
  });

  // The 64-hex-digit grammar spans 2^256, far past the felt field. Values above
  // the prime are not addresses: left in, they reach starknet.js's own range
  // assertion deep inside hashing, where a bad server-supplied address is
  // reported as a malformed client payload.
  it("rejects values at or above the field prime", () => {
    expect(isValidStarknetAddress("0x" + "f".repeat(64))).toBe(false);
    expect(isValidStarknetAddress(num.toHex(STARK_PRIME))).toBe(false);
  });

  it("rejects the zero address", () => {
    expect(isValidStarknetAddress("0x0")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidStarknetAddress("0xGG")).toBe(false);
    expect(isValidStarknetAddress("0x12 34")).toBe(false);
  });
});

describe("parseAmount", () => {
  it("parses base-10 integer strings", () => {
    expect(parseAmount("1000")).toBe(1000n);
    expect(parseAmount("0")).toBe(0n);
  });

  it("rejects hex, empty, whitespace, and signed strings", () => {
    expect(() => parseAmount("0x10")).toThrow("base-10");
    expect(() => parseAmount("")).toThrow("base-10");
    expect(() => parseAmount(" 10")).toThrow("base-10");
    expect(() => parseAmount("-5")).toThrow("base-10");
    expect(() => parseAmount("1.5")).toThrow("base-10");
  });

  it("rejects non-string input", () => {
    expect(() => parseAmount(1000 as unknown as string)).toThrow("base-10");
  });
});

describe("amountStringEquals", () => {
  it("compares base-10 amounts numerically", () => {
    expect(amountStringEquals("1000", "1000")).toBe(true);
    expect(amountStringEquals("01000", "1000")).toBe(true);
    expect(amountStringEquals("1000", "1001")).toBe(false);
  });

  it("returns false when either operand is malformed", () => {
    expect(amountStringEquals("0x10", "16")).toBe(false);
    expect(amountStringEquals("1000", "")).toBe(false);
    expect(amountStringEquals("", "")).toBe(false);
  });
});

describe("chainIdSafeToFelt", () => {
  it("resolves hex chain ids", () => {
    expect(chainIdSafeToFelt("0x534e5f5345504f4c4941")).toBe(BigInt("0x534e5f5345504f4c4941"));
  });

  it("resolves short-string chain ids", () => {
    expect(chainIdSafeToFelt("SN_MAIN")).toBe(BigInt("0x534e5f4d41494e"));
    expect(chainIdSafeToFelt("SN_SEPOLIA")).toBe(BigInt("0x534e5f5345504f4c4941"));
  });

  it("resolves decimal chain ids", () => {
    expect(chainIdSafeToFelt("42")).toBe(42n);
  });

  it("returns -1 on unparsable garbage instead of throwing", () => {
    // A string too long to encode as a felt short string throws internally.
    expect(chainIdSafeToFelt("this is way too long to fit in a single starknet felt")).toBe(-1n);
  });
});
