import { describe, expect, it } from "vitest";
import {
  CARDANO_MAINNET_CAIP2,
  CARDANO_MAINNET_CIP34,
  CARDANO_PREPROD_CAIP2,
  CARDANO_PREPROD_CIP34,
  CARDANO_PREVIEW_CAIP2,
  LOVELACE_ASSET,
  USDM_MAINNET_ASSET,
  USDM_PREPROD_ASSET,
} from "../../src/constants";
import { DEFAULT_ASSETS, findDefaultAsset, getDefaultAsset } from "../../src/defaultAssets";

const MAINNET_USDM = DEFAULT_ASSETS[CARDANO_MAINNET_CAIP2]![0]!;
const PREPROD_USDM = DEFAULT_ASSETS[CARDANO_PREPROD_CAIP2]![0]!;

describe("defaultAssets (Cardano)", () => {
  describe("findDefaultAsset", () => {
    it("matches the configured USDM unit (case-insensitive)", () => {
      expect(findDefaultAsset(USDM_MAINNET_ASSET, CARDANO_MAINNET_CAIP2)).toEqual(MAINNET_USDM);
      expect(findDefaultAsset(USDM_MAINNET_ASSET.toUpperCase(), CARDANO_MAINNET_CAIP2)).toEqual(
        MAINNET_USDM,
      );
      expect(findDefaultAsset(USDM_PREPROD_ASSET, CARDANO_PREPROD_CAIP2)).toEqual(PREPROD_USDM);
    });

    it("accepts CIP-34 network aliases", () => {
      expect(findDefaultAsset(USDM_MAINNET_ASSET, CARDANO_MAINNET_CIP34 as never)).toEqual(
        MAINNET_USDM,
      );
    });

    it("returns undefined for lovelace and for networks without a default", () => {
      expect(findDefaultAsset(LOVELACE_ASSET, CARDANO_MAINNET_CAIP2)).toBeUndefined();
      expect(findDefaultAsset(USDM_PREPROD_ASSET, CARDANO_MAINNET_CAIP2)).toBeUndefined();
      expect(findDefaultAsset(USDM_MAINNET_ASSET, CARDANO_PREVIEW_CAIP2)).toBeUndefined();
    });
  });

  describe("getDefaultAsset", () => {
    it("returns USDM as the network default, including via CIP-34 aliases", () => {
      expect(getDefaultAsset(CARDANO_MAINNET_CAIP2)).toEqual(MAINNET_USDM);
      expect(getDefaultAsset(CARDANO_PREPROD_CAIP2)).toEqual(PREPROD_USDM);
      expect(getDefaultAsset(CARDANO_MAINNET_CIP34 as never)).toEqual(MAINNET_USDM);
      expect(getDefaultAsset(CARDANO_PREPROD_CIP34 as never)).toEqual(PREPROD_USDM);
    });

    it("resolves a ticker case-insensitively", () => {
      expect(getDefaultAsset(CARDANO_MAINNET_CAIP2, "usdm")).toEqual(MAINNET_USDM);
    });

    it("throws for Preview and for an unknown ticker", () => {
      expect(() => getDefaultAsset(CARDANO_PREVIEW_CAIP2)).toThrow(
        /No default asset configured for network cardano:preview/,
      );
      expect(() => getDefaultAsset(CARDANO_MAINNET_CAIP2, "USDC")).toThrow(
        /No USDC default asset configured for network cardano:mainnet/,
      );
    });
  });
});
