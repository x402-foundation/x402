import { describe, it, expect } from "vitest";
import { ExactStarknetScheme } from "../../src/exact/server/scheme";
import {
  STARKNET_MAINNET_CAIP2,
  STARKNET_SEPOLIA_CAIP2,
  USDC_MAINNET,
  USDC_SEPOLIA,
} from "../../src/constants";
import { DEFAULT_ASSETS, findDefaultAsset, getDefaultAsset } from "../../src/defaultAssets";

const MAINNET_USDC = DEFAULT_ASSETS[STARKNET_MAINNET_CAIP2]![0]!;
const SEPOLIA_USDC = DEFAULT_ASSETS[STARKNET_SEPOLIA_CAIP2]![0]!;

describe("defaultAssets (Starknet)", () => {
  describe("findDefaultAsset", () => {
    it("matches the configured USDC address on each network", () => {
      expect(findDefaultAsset(USDC_MAINNET, STARKNET_MAINNET_CAIP2)).toEqual(MAINNET_USDC);
      expect(findDefaultAsset(USDC_SEPOLIA, STARKNET_SEPOLIA_CAIP2)).toEqual(SEPOLIA_USDC);
    });

    // A Starknet address has no canonical form: the same felt can be written
    // with or without zero padding and in either hex case, and a resource
    // server may advertise any of them.
    it("matches the address as a felt, regardless of padding and case", () => {
      const unpadded = "0x" + USDC_SEPOLIA.slice(2).replace(/^0+/, "");
      expect(findDefaultAsset(unpadded, STARKNET_SEPOLIA_CAIP2)).toEqual(SEPOLIA_USDC);
      expect(findDefaultAsset(USDC_SEPOLIA.toLowerCase(), STARKNET_SEPOLIA_CAIP2)).toEqual(
        SEPOLIA_USDC,
      );
      expect(
        findDefaultAsset(USDC_SEPOLIA.toUpperCase().replace("0X", "0x"), STARKNET_SEPOLIA_CAIP2),
      ).toEqual(SEPOLIA_USDC);
    });

    it("does not match the other network's USDC", () => {
      expect(findDefaultAsset(USDC_MAINNET, STARKNET_SEPOLIA_CAIP2)).toBeUndefined();
      expect(findDefaultAsset(USDC_SEPOLIA, STARKNET_MAINNET_CAIP2)).toBeUndefined();
    });

    it("returns undefined for a non-felt asset string rather than throwing", () => {
      expect(findDefaultAsset("USDC", STARKNET_SEPOLIA_CAIP2)).toBeUndefined();
      expect(findDefaultAsset("not-an-address", STARKNET_SEPOLIA_CAIP2)).toBeUndefined();
    });

    it("returns undefined for an unknown network", () => {
      expect(findDefaultAsset(USDC_MAINNET, "starknet:SN_DEVNET" as never)).toBeUndefined();
    });
  });

  describe("getDefaultAsset", () => {
    it("returns the first list entry as the network default", () => {
      expect(getDefaultAsset(STARKNET_MAINNET_CAIP2)).toEqual(MAINNET_USDC);
      expect(getDefaultAsset(STARKNET_SEPOLIA_CAIP2)).toEqual(SEPOLIA_USDC);
    });

    it("resolves a ticker case-insensitively", () => {
      expect(getDefaultAsset(STARKNET_SEPOLIA_CAIP2, "usdc")).toEqual(SEPOLIA_USDC);
    });

    it("throws for an unknown ticker", () => {
      expect(() => getDefaultAsset(STARKNET_SEPOLIA_CAIP2, "USDT")).toThrow(
        /No USDT default asset configured for network starknet:SN_SEPOLIA/,
      );
    });

    it("throws for an unknown network", () => {
      expect(() => getDefaultAsset("starknet:SN_DEVNET" as never)).toThrow(
        /No default asset configured for network starknet:SN_DEVNET/,
      );
    });
  });

  describe("ExactStarknetScheme.parsePrice regression", () => {
    const server = new ExactStarknetScheme();

    // Silently pricing an unknown network in another network's token would
    // produce a 402 nobody can settle; the caller must be explicit instead.
    it("throws for dollar-string pricing on an unsupported network (no mainnet fallback)", async () => {
      await expect(server.parsePrice("$0.10", "starknet:SN_DEVNET" as never)).rejects.toThrow(
        /No default asset configured for network starknet:SN_DEVNET/,
      );
    });
  });
});
