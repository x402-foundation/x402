import { describe, it, expect } from "vitest";
import { getUsdcAddress, networkToKeetaNetwork, validateTokenAsset } from "../../src/utils";
import { KEETA_MAINNET_CAIP2, KEETA_TESTNET_CAIP2 } from "../../src/constants";
import { getNewKeetaAccount, USDC_TESTNET_ADDRESS } from "./utils";

const KEETA_ACCOUNT = getNewKeetaAccount().publicKeyString.toString();

describe("Keeta utilities", () => {
  describe("getUsdcAddress", () => {
    it("throws for unknown network", async () => {
      await expect(getUsdcAddress("keeta:99999")).rejects.toThrow(
        "No USDC address configured for network",
      );
    });

    it("throws for non-keeta network", async () => {
      await expect(getUsdcAddress("ethereum:1")).rejects.toThrow(
        "No USDC address configured for network",
      );
    });
  });

  describe("networkToKeetaNetwork", () => {
    it("returns main for Keeta mainnet", () => {
      expect(networkToKeetaNetwork(KEETA_MAINNET_CAIP2)).toBe("main");
    });

    it("returns test for Keeta Testnet", () => {
      expect(networkToKeetaNetwork(KEETA_TESTNET_CAIP2)).toBe("test");
    });

    it("throws for unknown network", () => {
      expect(() => networkToKeetaNetwork("keeta:99999")).toThrow("Unsupported network");
    });

    it("throws for non-keeta network", () => {
      expect(() => networkToKeetaNetwork("ethereum:1")).toThrow("Unsupported network");
    });
  });

  describe("validateTokenAsset", () => {
    it("returns true for valid token address", () => {
      expect(validateTokenAsset(USDC_TESTNET_ADDRESS)).toBe(true);
    });

    it("returns false when address is not a token type", () => {
      expect(validateTokenAsset(KEETA_ACCOUNT)).toBe(false);
    });

    it("returns false when address is invalid", () => {
      expect(validateTokenAsset("keeta_invalidaddress")).toBe(false);
      expect(validateTokenAsset("invalid-address")).toBe(false);
    });
  });
});
