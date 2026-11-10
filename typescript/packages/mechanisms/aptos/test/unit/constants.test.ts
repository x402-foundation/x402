import { describe, it, expect } from "vitest";
import { Network } from "@aptos-labs/ts-sdk";
import {
  APTOS_ADDRESS_REGEX,
  MAX_GAS_AMOUNT,
  MAX_GAS_UNIT_PRICE,
  getAptosNetwork,
  getAptosRpcUrl,
  getAptosChainId,
} from "../../src/constants";

describe("Aptos Constants", () => {
  describe("APTOS_ADDRESS_REGEX", () => {
    it("should match valid Aptos addresses", () => {
      const validAddress = "0x0000000000000000000000000000000000000000000000000000000000000001";
      expect(APTOS_ADDRESS_REGEX.test(validAddress)).toBe(true);
    });

    it("should match addresses with mixed case hex", () => {
      const validAddress = "0xABCDef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      expect(APTOS_ADDRESS_REGEX.test(validAddress)).toBe(true);
    });

    it("should reject addresses without 0x prefix", () => {
      const invalidAddress = "0000000000000000000000000000000000000000000000000000000000000001";
      expect(APTOS_ADDRESS_REGEX.test(invalidAddress)).toBe(false);
    });

    it("should reject addresses with wrong length", () => {
      expect(APTOS_ADDRESS_REGEX.test("0x1234")).toBe(false);
      expect(APTOS_ADDRESS_REGEX.test("0x" + "a".repeat(65))).toBe(false);
    });

    it("should reject addresses with invalid characters", () => {
      const invalidAddress = "0xGGGG000000000000000000000000000000000000000000000000000000000001";
      expect(APTOS_ADDRESS_REGEX.test(invalidAddress)).toBe(false);
    });
  });

  describe("getAptosNetwork", () => {
    it("should throw for unsupported networks", () => {
      expect(() => getAptosNetwork("aptos:99")).toThrow("Unsupported Aptos network");
      expect(() => getAptosNetwork("ethereum:1")).toThrow("Unsupported Aptos network");
      expect(() => getAptosNetwork("invalid")).toThrow("Unsupported Aptos network");
    });
  });

  describe("getAptosRpcUrl", () => {
    it("should return a valid URL for mainnet", () => {
      const url = getAptosRpcUrl(Network.MAINNET);
      expect(url).toContain("aptos");
      expect(url.startsWith("https://")).toBe(true);
    });

    it("should return a valid URL for testnet", () => {
      const url = getAptosRpcUrl(Network.TESTNET);
      expect(url).toContain("aptos");
      expect(url.startsWith("https://")).toBe(true);
    });

    it("should return different URLs for different networks", () => {
      const mainnetUrl = getAptosRpcUrl(Network.MAINNET);
      const testnetUrl = getAptosRpcUrl(Network.TESTNET);
      expect(mainnetUrl).not.toBe(testnetUrl);
    });
  });

  describe("MAX_GAS_UNIT_PRICE", () => {
    it("should be a bigint", () => {
      expect(typeof MAX_GAS_UNIT_PRICE).toBe("bigint");
    });

    it("should be well above typical mainnet gas price of ~100 Octas", () => {
      expect(MAX_GAS_UNIT_PRICE).toBeGreaterThan(100n);
    });

    it("should cap the maximum fee-payer gas cost per transaction", () => {
      // Worst-case gas cost in Octas: MAX_GAS_AMOUNT × MAX_GAS_UNIT_PRICE
      const maxGasCostOctas = MAX_GAS_AMOUNT * MAX_GAS_UNIT_PRICE;
      // 50 APT ceiling (5_000_000_000 Octas) — generous but finite
      expect(maxGasCostOctas).toBeLessThanOrEqual(5_000_000_000n);
    });
  });

  describe("getAptosChainId", () => {
    it("should throw for unsupported networks", () => {
      expect(() => getAptosChainId("aptos:99")).toThrow("Unsupported Aptos network");
      expect(() => getAptosChainId("ethereum:1")).toThrow("Unsupported Aptos network");
      expect(() => getAptosChainId("invalid")).toThrow("Unsupported Aptos network");
    });
  });
});
