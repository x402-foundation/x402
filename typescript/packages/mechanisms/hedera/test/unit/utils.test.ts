import { describe, expect, it } from "vitest";
import { HEDERA_TESTNET_CAIP2 } from "../../src/constants";
import { executorListAdmits, isStringArray } from "../../src/internal";
import {
  assertSupportedHederaNetwork,
  isSupportedHederaNetwork,
  isValidHexBytes,
} from "../../src/utils";

describe("Hedera utils", () => {
  it("detects supported Hedera networks", () => {
    expect(isSupportedHederaNetwork(HEDERA_TESTNET_CAIP2)).toBe(true);
    expect(isSupportedHederaNetwork("hedera:previewnet")).toBe(false);
  });

  it("asserts supported Hedera networks", () => {
    expect(() => assertSupportedHederaNetwork(HEDERA_TESTNET_CAIP2)).not.toThrow();
    expect(() => assertSupportedHederaNetwork("hedera:previewnet")).toThrow(
      "Unsupported Hedera network: hedera:previewnet",
    );
  });

  it.each(["0x", "0x0f", "0x0f2c9d1a", "0xABcdEF"])(
    "accepts the 0x-prefixed hex bytes %j",
    value => {
      expect(isValidHexBytes(value)).toBe(true);
    },
  );

  it.each([
    ["no 0x prefix", "0f2c"],
    ["not hex", "abc"],
    ["a non-hex digit", "0xzz"],
    ["odd length", "0x0f2"],
    ["a single nibble", "0x0"],
    ["an uppercase prefix", "0X0f"],
    ["empty", ""],
    ["a leading space", " 0x0f"],
    ["a trailing newline", "0x0f\n"],
    ["a number", 15],
    ["null", null],
    ["undefined", undefined],
    ["an array", ["0x0f"]],
  ])("rejects %s as hex bytes", (_label, value) => {
    expect(isValidHexBytes(value)).toBe(false);
  });
});

describe("isStringArray", () => {
  it.each([[[]], [["0.0.7000", "*"]]])("accepts %j", value => {
    expect(isStringArray(value)).toBe(true);
  });

  it.each([[undefined], ["0.0.7000"], [[7000]], [["0.0.7000", null]]])("rejects %j", value => {
    expect(isStringArray(value)).toBe(false);
  });
});

describe("executorListAdmits", () => {
  it("admits an exactly listed executor only", () => {
    expect(executorListAdmits(["0.0.7000"], "0.0.7000")).toBe(true);
    expect(executorListAdmits(["0.0.7000"], "0.0.7001")).toBe(false);
    expect(executorListAdmits(["0.0.7000"], "0.0.07000")).toBe(false);
  });

  it("admits any executor through a written-out wildcard", () => {
    expect(executorListAdmits(["0.0.1", "*"], "0.0.7001")).toBe(true);
  });

  it("admits nothing from an empty list", () => {
    expect(executorListAdmits([], "0.0.7000")).toBe(false);
  });
});
