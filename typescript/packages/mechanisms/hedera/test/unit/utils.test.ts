import { describe, expect, it } from "vitest";
import { HEDERA_TESTNET_CAIP2 } from "../../src/constants";
import { assertSupportedHederaNetwork, isSupportedHederaNetwork } from "../../src/utils";

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
});
