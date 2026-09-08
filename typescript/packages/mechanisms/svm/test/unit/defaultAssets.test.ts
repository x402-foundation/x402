import { describe, it, expect } from "vitest";
import {
  DEFAULT_ASSETS,
  findDefaultAsset,
  getDefaultAsset,
  USDC_DEVNET_ADDRESS,
  USDC_MAINNET_ADDRESS,
} from "../../src/defaultAssets";
import { SOLANA_DEVNET_CAIP2, SOLANA_MAINNET_CAIP2 } from "../../src/constants";

const MAINNET_USDC = DEFAULT_ASSETS[SOLANA_MAINNET_CAIP2]![0]!;

describe("defaultAssets (SVM)", () => {
  describe("findDefaultAsset", () => {
    it("resolves v1 legacy network name solana", () => {
      expect(findDefaultAsset(USDC_MAINNET_ADDRESS, "solana")).toEqual(MAINNET_USDC);
    });

    it("returns undefined for an unknown asset", () => {
      expect(
        findDefaultAsset("UnknownMint1111111111111111111111111111111", "solana"),
      ).toBeUndefined();
    });
  });

  describe("getDefaultAsset", () => {
    it("returns the first list entry as the network default", () => {
      expect(getDefaultAsset(SOLANA_MAINNET_CAIP2)).toEqual(MAINNET_USDC);
      expect(getDefaultAsset("solana")).toEqual(MAINNET_USDC);
    });

    it("resolves a suffixed ticker to a non-default entry", () => {
      expect(getDefaultAsset(SOLANA_MAINNET_CAIP2, "USDT").symbol).toBe("USDT");
    });

    it("throws when requesting a symbol that is not configured on the network", () => {
      expect(() => getDefaultAsset(SOLANA_DEVNET_CAIP2, "USDT")).toThrow(
        /No USDT default asset configured for network/,
      );
    });

    it("throws when a supported network has an empty asset list", () => {
      const original = DEFAULT_ASSETS[SOLANA_DEVNET_CAIP2];
      DEFAULT_ASSETS[SOLANA_DEVNET_CAIP2] = [];
      try {
        expect(() => getDefaultAsset(SOLANA_DEVNET_CAIP2)).toThrow(
          /No default asset configured for network/,
        );
      } finally {
        DEFAULT_ASSETS[SOLANA_DEVNET_CAIP2] = original;
      }
    });
  });

  describe("findDefaultAsset empty table", () => {
    it("returns undefined when the network has no asset list", () => {
      const original = DEFAULT_ASSETS[SOLANA_DEVNET_CAIP2];
      delete DEFAULT_ASSETS[SOLANA_DEVNET_CAIP2];
      try {
        expect(findDefaultAsset(USDC_DEVNET_ADDRESS, SOLANA_DEVNET_CAIP2)).toBeUndefined();
      } finally {
        DEFAULT_ASSETS[SOLANA_DEVNET_CAIP2] = original;
      }
    });
  });
});
