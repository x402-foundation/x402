import { Address } from "@ton/core";
import { describe, it, expect } from "vitest";
import { USDT_MAINNET_MINTER, TVM_MAINNET } from "../../src/constants";
import { DEFAULT_ASSETS, findDefaultAsset, getDefaultAsset } from "../../src/defaultAssets";

const MAINNET_USDT = DEFAULT_ASSETS[TVM_MAINNET]![0]!;

describe("defaultAssets (TVM)", () => {
  describe("findDefaultAsset", () => {
    it("matches user-friendly and raw TON address formats via normalizeTonAddress", () => {
      const friendly = Address.parse(USDT_MAINNET_MINTER).toString();

      expect(findDefaultAsset(USDT_MAINNET_MINTER, TVM_MAINNET)).toEqual(MAINNET_USDT);
      expect(findDefaultAsset(friendly, TVM_MAINNET)).toEqual(MAINNET_USDT);
    });

    it("returns undefined for an unknown asset", () => {
      expect(
        findDefaultAsset(
          "0:0000000000000000000000000000000000000000000000000000000000000001",
          TVM_MAINNET,
        ),
      ).toBeUndefined();
    });
  });

  describe("getDefaultAsset", () => {
    it("returns the first list entry as the network default", () => {
      expect(getDefaultAsset(TVM_MAINNET)).toEqual(MAINNET_USDT);
    });

    it("throws when requesting a symbol that is not configured on the network", () => {
      expect(() => getDefaultAsset(TVM_MAINNET, "USDC")).toThrow(
        /No USDC default asset configured for network/,
      );
    });

    it("throws for an unknown network", () => {
      expect(() => getDefaultAsset("tvm:999" as never)).toThrow(
        /No default asset configured for network tvm:999/,
      );
    });
  });
});
