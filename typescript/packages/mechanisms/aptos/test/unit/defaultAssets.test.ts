import { describe, it, expect } from "vitest";
import { ExactAptosScheme } from "../../src/exact/server/scheme";
import { APTOS_MAINNET_CAIP2, USDC_MAINNET_FA } from "../../src/constants";
import { DEFAULT_ASSETS, findDefaultAsset, getDefaultAsset } from "../../src/defaultAssets";

const MAINNET_USDC = DEFAULT_ASSETS[APTOS_MAINNET_CAIP2]![0]!;

describe("defaultAssets (Aptos)", () => {
  describe("findDefaultAsset", () => {
    it("matches the configured fungible asset address (case-insensitive)", () => {
      expect(findDefaultAsset(USDC_MAINNET_FA, APTOS_MAINNET_CAIP2)).toEqual(MAINNET_USDC);
      expect(findDefaultAsset(USDC_MAINNET_FA.toUpperCase(), APTOS_MAINNET_CAIP2)).toEqual(
        MAINNET_USDC,
      );
    });

    it("returns undefined for an unknown network", () => {
      expect(findDefaultAsset(USDC_MAINNET_FA, "aptos:999" as never)).toBeUndefined();
    });
  });

  describe("getDefaultAsset", () => {
    it("returns the first list entry as the network default", () => {
      expect(getDefaultAsset(APTOS_MAINNET_CAIP2)).toEqual(MAINNET_USDC);
    });

    it("throws for an unknown network", () => {
      expect(() => getDefaultAsset("aptos:999" as never)).toThrow(
        /No default asset configured for network aptos:999/,
      );
    });
  });

  describe("ExactAptosScheme.parsePrice regression", () => {
    const server = new ExactAptosScheme();

    it("throws for dollar-string pricing on an unsupported network (no mainnet fallback)", async () => {
      await expect(server.parsePrice("$0.10", "aptos:999" as never)).rejects.toThrow(
        /No default asset configured for network aptos:999/,
      );
    });
  });
});
