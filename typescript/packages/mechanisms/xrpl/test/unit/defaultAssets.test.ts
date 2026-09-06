import { describe, it, expect } from "vitest";
import { XRPL_MAINNET, XRPL_TESTNET, XRPL_DEVNET } from "../../src/constants";
import {
  DEFAULT_ASSETS,
  findDefaultAsset,
  getDefaultAsset,
  RLUSD_CURRENCY,
} from "../../src/defaultAssets";

const MAINNET_RLUSD = DEFAULT_ASSETS[XRPL_MAINNET]![0]!;
const TESTNET_RLUSD = DEFAULT_ASSETS[XRPL_TESTNET]![0]!;

describe("defaultAssets (XRPL)", () => {
  describe("findDefaultAsset", () => {
    it("matches RLUSD by currency hex", () => {
      expect(findDefaultAsset(RLUSD_CURRENCY, XRPL_MAINNET)).toEqual(MAINNET_RLUSD);
      expect(findDefaultAsset(RLUSD_CURRENCY.toLowerCase(), XRPL_TESTNET)).toEqual(TESTNET_RLUSD);
    });

    it("returns undefined for native XRP and unknown networks", () => {
      expect(findDefaultAsset("XRP", XRPL_MAINNET)).toBeUndefined();
      expect(findDefaultAsset(RLUSD_CURRENCY, XRPL_DEVNET)).toBeUndefined();
    });
  });

  describe("getDefaultAsset", () => {
    it("returns RLUSD as the network default", () => {
      expect(getDefaultAsset(XRPL_MAINNET)).toEqual(MAINNET_RLUSD);
      expect(getDefaultAsset(XRPL_TESTNET, "RLUSD")).toEqual(TESTNET_RLUSD);
    });

    it("throws for an unknown network", () => {
      expect(() => getDefaultAsset(XRPL_DEVNET)).toThrow(
        /No default asset configured for network xrpl:2/,
      );
    });
  });
});
