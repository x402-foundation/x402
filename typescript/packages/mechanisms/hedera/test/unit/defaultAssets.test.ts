import { describe, it, expect } from "vitest";
import { HEDERA_MAINNET_CAIP2, HEDERA_MAINNET_USDC } from "../../src/constants";
import { DEFAULT_ASSETS, findDefaultAsset, getDefaultAsset } from "../../src/defaultAssets";

const MAINNET_USDC = DEFAULT_ASSETS[HEDERA_MAINNET_CAIP2]![0]!;

describe("defaultAssets (Hedera)", () => {
  describe("findDefaultAsset", () => {
    it("matches the configured HTS token id exactly", () => {
      expect(findDefaultAsset(HEDERA_MAINNET_USDC, HEDERA_MAINNET_CAIP2)).toEqual(MAINNET_USDC);
    });

    it("returns undefined for an unknown network", () => {
      expect(findDefaultAsset(HEDERA_MAINNET_USDC, "hedera:unknown" as never)).toBeUndefined();
    });
  });

  describe("getDefaultAsset", () => {
    it("returns the first list entry as the network default", () => {
      expect(getDefaultAsset(HEDERA_MAINNET_CAIP2)).toEqual(MAINNET_USDC);
    });

    it("throws for an unknown network", () => {
      expect(() => getDefaultAsset("hedera:unknown" as never)).toThrow(
        /No default asset configured for network hedera:unknown/,
      );
    });
  });
});
