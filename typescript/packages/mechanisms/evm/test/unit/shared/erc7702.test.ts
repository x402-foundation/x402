import { describe, expect, it } from "vitest";
import { isERC7702Delegation, getERC7702DelegateAddress } from "../../../src/shared/erc7702";

const ADDR_LOWER = "1234567890abcdef1234567890abcdef12345678";
const ADDR_MIXED = "1234567890abCDEF1234567890ABcdef12345678";

describe("isERC7702Delegation", () => {
  it("returns true for canonical lowercase delegation", () => {
    expect(isERC7702Delegation(`0xef0100${ADDR_LOWER}` as `0x${string}`)).toBe(true);
  });

  it("returns true for uppercase prefix (case-insensitive — JSON-RPC casing not normalized)", () => {
    expect(isERC7702Delegation(`0xEF0100${ADDR_LOWER}` as `0x${string}`)).toBe(true);
    expect(isERC7702Delegation(`0xEf0100${ADDR_LOWER}` as `0x${string}`)).toBe(true);
  });

  it("returns true for mixed-case address suffix", () => {
    expect(isERC7702Delegation(`0xef0100${ADDR_MIXED}` as `0x${string}`)).toBe(true);
  });

  it("returns false for undefined / null / empty", () => {
    expect(isERC7702Delegation(undefined)).toBe(false);
    expect(isERC7702Delegation(null)).toBe(false);
    expect(isERC7702Delegation("0x")).toBe(false);
  });

  it("returns false for wrong prefix bytes", () => {
    expect(isERC7702Delegation(`0xef0200${ADDR_LOWER}` as `0x${string}`)).toBe(false);
    expect(isERC7702Delegation(`0xef0000${ADDR_LOWER}` as `0x${string}`)).toBe(false);
  });

  it("returns false for too-short bytecode", () => {
    expect(isERC7702Delegation("0xef01001234" as `0x${string}`)).toBe(false);
  });

  it("returns false for too-long bytecode", () => {
    expect(isERC7702Delegation(`0xef0100${ADDR_LOWER}00` as `0x${string}`)).toBe(false);
  });

  it("returns false for regular contract bytecode", () => {
    expect(isERC7702Delegation("0x6080604052" as `0x${string}`)).toBe(false);
  });
});

describe("getERC7702DelegateAddress", () => {
  it("extracts address from valid lowercase delegation", () => {
    expect(getERC7702DelegateAddress(`0xef0100${ADDR_LOWER}` as `0x${string}`)).toBe(
      `0x${ADDR_LOWER}`,
    );
  });

  it("normalizes uppercase prefix and mixed-case address to lowercase", () => {
    expect(getERC7702DelegateAddress(`0xEF0100${ADDR_MIXED}` as `0x${string}`)).toBe(
      `0x${ADDR_LOWER}`,
    );
  });

  it("returns null for non-7702 bytecode", () => {
    expect(getERC7702DelegateAddress("0x6080" as `0x${string}`)).toBeNull();
    expect(getERC7702DelegateAddress(undefined)).toBeNull();
    expect(getERC7702DelegateAddress(null)).toBeNull();
  });
});
