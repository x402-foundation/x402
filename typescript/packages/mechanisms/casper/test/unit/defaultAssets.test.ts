import { describe, it, expect } from "vitest";
import { CASPER_MAINNET_CAIP2, CSPR_USDC_MAINNET_ASSET } from "../../src/constants";
import { DEFAULT_ASSETS, findDefaultAsset, getDefaultAsset } from "../../src/defaultAssets";

const MAINNET_CSPR_USDC = DEFAULT_ASSETS[CASPER_MAINNET_CAIP2]![0]!;
const CASPER_UNKNOWN_CAIP2 = "casper:casper-unknown";

describe("defaultAssets (Casper)", () => {
  describe("findDefaultAsset", () => {
    it("matches the configured fungible asset address (case-insensitive)", () => {
      expect(findDefaultAsset(CSPR_USDC_MAINNET_ASSET, CASPER_MAINNET_CAIP2)).toEqual(
        MAINNET_CSPR_USDC,
      );
      expect(findDefaultAsset(CSPR_USDC_MAINNET_ASSET.toUpperCase(), CASPER_MAINNET_CAIP2)).toEqual(
        MAINNET_CSPR_USDC,
      );
    });

    it("returns undefined for an unknown network", () => {
      expect(
        findDefaultAsset(CSPR_USDC_MAINNET_ASSET, CASPER_UNKNOWN_CAIP2 as never),
      ).toBeUndefined();
    });
  });

  describe("getDefaultAsset", () => {
    it("returns the first list entry as the network default", () => {
      expect(getDefaultAsset(CASPER_MAINNET_CAIP2)).toEqual(MAINNET_CSPR_USDC);
    });

    it("throws for an unknown network", () => {
      expect(() => getDefaultAsset(CASPER_UNKNOWN_CAIP2 as never)).toThrow(
        /No default asset configured for network casper:casper-unknown/,
      );
    });
  });
});
