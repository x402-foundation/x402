import { describe, it, expect } from "vitest";
import { getAddress } from "viem";
import { ExactEvmScheme } from "../../src/exact/server/scheme";
import { DEFAULT_ASSETS, findDefaultAsset, getDefaultAsset } from "../../src/defaultAssets";

const BASE_USDC = DEFAULT_ASSETS["eip155:8453"]![0]!;
const MEZO_TESTNET_MUSD = DEFAULT_ASSETS["eip155:31611"]![0]!;

describe("defaultAssets (EVM)", () => {
  describe("findDefaultAsset", () => {
    it("matches checksummed and lowercase addresses on the same network", () => {
      const checksummed = getAddress(BASE_USDC.asset);
      const lowercase = BASE_USDC.asset.toLowerCase();

      expect(findDefaultAsset(checksummed, "eip155:8453")).toEqual(BASE_USDC);
      expect(findDefaultAsset(lowercase, "eip155:8453")).toEqual(BASE_USDC);
    });

    it("resolves v1 legacy network name base to eip155:8453", () => {
      expect(findDefaultAsset(BASE_USDC.asset, "base")).toEqual(BASE_USDC);
    });

    it("finds 18-decimal mUSD on Mezo testnet", () => {
      expect(findDefaultAsset(MEZO_TESTNET_MUSD.asset, "eip155:31611")).toEqual(MEZO_TESTNET_MUSD);
      expect(MEZO_TESTNET_MUSD.decimals).toBe(18);
    });

    it("returns undefined for an unknown asset", () => {
      expect(
        findDefaultAsset("0x0000000000000000000000000000000000000001", "eip155:8453"),
      ).toBeUndefined();
    });
  });

  describe("getDefaultAsset", () => {
    it("returns the first list entry as the network default", () => {
      expect(getDefaultAsset("eip155:8453")).toEqual(BASE_USDC);
      expect(getDefaultAsset("base")).toEqual(BASE_USDC);
    });

    it("throws when requesting a symbol that is not configured on the network", () => {
      expect(() => getDefaultAsset("eip155:8453", "USDT")).toThrow(
        /No USDT default asset configured for network eip155:8453/,
      );
    });
  });

  describe("ExactEvmScheme.getAssetDecimals regression", () => {
    const server = new ExactEvmScheme();

    it("returns undefined for an unrecognized asset on an 18-decimal-default network", () => {
      const otherAsset = "0x0000000000000000000000000000000000000001";
      expect(server.getAssetDecimals(otherAsset, "eip155:31611")).toBeUndefined();
      expect(server.getAssetDecimals(MEZO_TESTNET_MUSD.asset, "eip155:31611")).toBe(18);
    });
  });
});
