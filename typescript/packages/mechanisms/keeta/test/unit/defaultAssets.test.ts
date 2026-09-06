import { describe, it, expect } from "vitest";
import { KEETA_MAINNET_CAIP2, KEETA_TESTNET_CAIP2 } from "../../src/constants";
import {
  DEFAULT_ASSETS,
  findDefaultAsset,
  getDefaultAsset,
  USDC_MAINNET_ADDRESS,
  USDC_TESTNET_ADDRESS,
} from "../../src/defaultAssets";

const MAINNET_USDC = DEFAULT_ASSETS[KEETA_MAINNET_CAIP2]![0]!;
const TESTNET_USDC = DEFAULT_ASSETS[KEETA_TESTNET_CAIP2]![0]!;

describe("defaultAssets (Keeta)", () => {
  describe("findDefaultAsset", () => {
    it("matches the documented USDC address", () => {
      expect(findDefaultAsset(USDC_MAINNET_ADDRESS, KEETA_MAINNET_CAIP2)).toEqual(MAINNET_USDC);
      expect(findDefaultAsset(USDC_TESTNET_ADDRESS, KEETA_TESTNET_CAIP2)).toEqual(TESTNET_USDC);
    });

    it("returns undefined for an unknown token or network", () => {
      expect(findDefaultAsset("keeta_unknown", KEETA_MAINNET_CAIP2)).toBeUndefined();
      expect(findDefaultAsset(USDC_MAINNET_ADDRESS, "keeta:unknown" as never)).toBeUndefined();
    });
  });

  describe("getDefaultAsset", () => {
    it("returns the first list entry as the network default", () => {
      expect(getDefaultAsset(KEETA_MAINNET_CAIP2)).toEqual(MAINNET_USDC);
      expect(getDefaultAsset(KEETA_TESTNET_CAIP2, "USDC")).toEqual(TESTNET_USDC);
    });

    it("throws for an unknown network", () => {
      expect(() => getDefaultAsset("keeta:unknown" as never)).toThrow(
        /No default asset configured for network keeta:unknown/,
      );
    });
  });
});
