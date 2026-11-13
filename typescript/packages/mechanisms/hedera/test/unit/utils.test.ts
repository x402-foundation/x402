import { describe, expect, it } from "vitest";
import { HEDERA_TESTNET_CAIP2 } from "../../src/constants";
import { executorListAdmits, isStringArray } from "../../src/internal";
import {
  assertSupportedHederaNetwork,
  isEncodableHederaEntityId,
  isSupportedHederaNetwork,
  isValidHederaEntityId,
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

describe("isEncodableHederaEntityId", () => {
  it.each([
    ["the smallest id", "0.0.0"],
    ["num 2^64 - 1", "0.0.18446744073709551615"],
    ["realm 2^64 - 1", "0.18446744073709551615.0"],
    ["shard 2^32 - 1", "4294967295.0.0"],
    ["every part at its largest", "4294967295.18446744073709551615.18446744073709551615"],
  ])("accepts %s", (_, entityId) => {
    expect(isEncodableHederaEntityId(entityId)).toBe(true);
  });

  // Each still passes the regex-only check, so only the bound rejects it.
  it.each([
    ["num 2^64", "0.0.18446744073709551616"],
    ["realm 2^64", "0.18446744073709551616.0"],
    ["shard 2^32", "4294967296.0.0"],
    ["a 20-digit num", "0.0.99999999999999999999"],
  ])("rejects %s, which is a valid entity id", (_, entityId) => {
    expect(isValidHederaEntityId(entityId)).toBe(true);
    expect(isEncodableHederaEntityId(entityId)).toBe(false);
  });

  it.each(["0.0", "0.0.-1", "0.0.1.2", "0x0000000000000000000000000000000000001b58", ""])(
    "rejects %j, which is not an entity id",
    entityId => {
      expect(isEncodableHederaEntityId(entityId)).toBe(false);
    },
  );
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
