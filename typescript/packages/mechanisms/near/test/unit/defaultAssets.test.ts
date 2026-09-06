import { describe, it, expect } from "vitest";
import { NEAR_MAINNET_CAIP2 } from "../../src/constants";
import { DEFAULT_ASSETS, findDefaultAsset, getDefaultAsset } from "../../src/defaultAssets";

const MAINNET_USDC = DEFAULT_ASSETS[NEAR_MAINNET_CAIP2]![0]!;

describe("defaultAssets (NEAR)", () => {
  describe("findDefaultAsset", () => {
    it("matches the configured contract id (case-insensitive)", () => {
      expect(findDefaultAsset(MAINNET_USDC.asset, NEAR_MAINNET_CAIP2)).toEqual(MAINNET_USDC);
      expect(findDefaultAsset(MAINNET_USDC.asset.toUpperCase(), NEAR_MAINNET_CAIP2)).toEqual(
        MAINNET_USDC,
      );
    });

    it("returns undefined for an unknown network", () => {
      expect(findDefaultAsset(MAINNET_USDC.asset, "near:unknown" as never)).toBeUndefined();
    });
  });

  describe("getDefaultAsset", () => {
    it("returns the first list entry as the network default", () => {
      expect(getDefaultAsset(NEAR_MAINNET_CAIP2)).toEqual(MAINNET_USDC);
    });

    it("throws for an unknown network", () => {
      expect(() => getDefaultAsset("near:unknown" as never)).toThrow(
        /No default asset configured for network near:unknown/,
      );
    });
  });
});
