import { describe, it, expect } from "vitest";
import { CONCORDIUM_MAINNET_CAIP2, CONCORDIUM_TESTNET_CAIP2 } from "../../src/constants";
import {
  DEFAULT_ASSETS,
  findDefaultAsset,
  getDefaultAsset,
  USDR_TOKEN_ID,
} from "../../src/defaultAssets";

const MAINNET_USDR = DEFAULT_ASSETS[CONCORDIUM_MAINNET_CAIP2]![0]!;
const TESTNET_USDR = DEFAULT_ASSETS[CONCORDIUM_TESTNET_CAIP2]![0]!;

describe("defaultAssets (Concordium)", () => {
  describe("findDefaultAsset", () => {
    it("matches USDR on mainnet and testnet", () => {
      expect(findDefaultAsset(USDR_TOKEN_ID, CONCORDIUM_MAINNET_CAIP2)).toEqual(MAINNET_USDR);
      expect(findDefaultAsset("usdr", CONCORDIUM_TESTNET_CAIP2)).toEqual(TESTNET_USDR);
    });

    it("returns undefined for CCD, EURR, and unknown networks", () => {
      expect(findDefaultAsset("CCD", CONCORDIUM_MAINNET_CAIP2)).toBeUndefined();
      expect(findDefaultAsset("EURR", CONCORDIUM_TESTNET_CAIP2)).toBeUndefined();
      expect(findDefaultAsset(USDR_TOKEN_ID, "ccd:unknown" as never)).toBeUndefined();
    });
  });

  describe("getDefaultAsset", () => {
    it("returns USDR as the network default", () => {
      expect(getDefaultAsset(CONCORDIUM_MAINNET_CAIP2)).toEqual(MAINNET_USDR);
      expect(getDefaultAsset(CONCORDIUM_TESTNET_CAIP2, "USDR")).toEqual(TESTNET_USDR);
    });

    it("throws for an unknown network or ticker", () => {
      expect(() => getDefaultAsset("ccd:unknown" as never)).toThrow(
        /No default asset configured for network ccd:unknown/,
      );
      expect(() => getDefaultAsset(CONCORDIUM_TESTNET_CAIP2, "EURR")).toThrow(
        /No EURR default asset configured/,
      );
    });
  });
});
