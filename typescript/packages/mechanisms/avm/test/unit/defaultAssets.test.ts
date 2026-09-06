import { describe, it, expect } from "vitest";
import { ALGORAND_MAINNET_CAIP2, USDC_MAINNET_ASA_ID } from "../../src/constants";
import { DEFAULT_ASSETS, findDefaultAsset, getDefaultAsset } from "../../src/defaultAssets";

const MAINNET_USDC = DEFAULT_ASSETS[ALGORAND_MAINNET_CAIP2]![0]!;

describe("defaultAssets (AVM)", () => {
  describe("findDefaultAsset", () => {
    it("matches the configured ASA id exactly", () => {
      expect(findDefaultAsset(USDC_MAINNET_ASA_ID, ALGORAND_MAINNET_CAIP2)).toEqual(MAINNET_USDC);
    });

    it("returns undefined for an unknown asset on a known network", () => {
      expect(findDefaultAsset("99999999", ALGORAND_MAINNET_CAIP2)).toBeUndefined();
    });

    it("throws for an unsupported network identifier", () => {
      expect(() => findDefaultAsset(USDC_MAINNET_ASA_ID, "algorand:unknown" as never)).toThrow(
        /Unsupported Algorand network: algorand:unknown/,
      );
    });
  });

  describe("getDefaultAsset", () => {
    it("returns the first list entry as the network default", () => {
      expect(getDefaultAsset(ALGORAND_MAINNET_CAIP2)).toEqual(MAINNET_USDC);
    });

    it("throws for an unsupported network identifier", () => {
      expect(() => getDefaultAsset("algorand:unknown" as never)).toThrow(
        /Unsupported Algorand network: algorand:unknown/,
      );
    });
  });
});
