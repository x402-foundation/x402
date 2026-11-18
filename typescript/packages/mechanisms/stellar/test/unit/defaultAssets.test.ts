import { describe, it, expect } from "vitest";
import { STELLAR_PUBNET_CAIP2, USDC_PUBNET_ADDRESS } from "../../src/constants";
import { DEFAULT_ASSETS, findDefaultAsset, getDefaultAsset } from "../../src/defaultAssets";

const PUBNET_USDC = DEFAULT_ASSETS[STELLAR_PUBNET_CAIP2]![0]!;

describe("defaultAssets (Stellar)", () => {
  describe("findDefaultAsset", () => {
    it("matches the configured token contract exactly", () => {
      expect(findDefaultAsset(USDC_PUBNET_ADDRESS, STELLAR_PUBNET_CAIP2)).toEqual(PUBNET_USDC);
    });

    it("returns undefined for an unknown network", () => {
      expect(findDefaultAsset(USDC_PUBNET_ADDRESS, "stellar:unknown" as never)).toBeUndefined();
    });
  });

  describe("getDefaultAsset", () => {
    it("returns the first list entry as the network default", () => {
      expect(getDefaultAsset(STELLAR_PUBNET_CAIP2)).toEqual(PUBNET_USDC);
    });

    it("throws for an unknown network", () => {
      expect(() => getDefaultAsset("stellar:unknown" as never)).toThrow(
        /No default asset configured for network stellar:unknown/,
      );
    });
  });
});
