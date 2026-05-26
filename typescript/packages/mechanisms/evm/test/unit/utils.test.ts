import { describe, it, expect } from "vitest";
import { getEvmChainId, createNonce } from "../../src/utils";
import { getEvmChainIdV1 } from "../../src/v1";

describe("EVM Utils", () => {
  describe("getEvmChainId (CAIP-2 only)", () => {
    it("should return correct chain ID for CAIP-2 Base", () => {
      expect(getEvmChainId("eip155:8453")).toBe(8453);
    });

    it("should return correct chain ID for CAIP-2 Base Sepolia", () => {
      expect(getEvmChainId("eip155:84532")).toBe(84532);
    });

    it("should return correct chain ID for CAIP-2 Ethereum", () => {
      expect(getEvmChainId("eip155:1")).toBe(1);
    });

    it("should return correct chain ID for CAIP-2 Polygon", () => {
      expect(getEvmChainId("eip155:137")).toBe(137);
    });

    it("should return correct chain ID for arbitrary CAIP-2 chain", () => {
      expect(getEvmChainId("eip155:999999")).toBe(999999);
    });

    it("should throw for legacy network names", () => {
      expect(() => getEvmChainId("base")).toThrow();
    });

    it("should throw for unsupported format", () => {
      expect(() => getEvmChainId("unknown-network")).toThrow();
    });

    it("should throw for invalid CAIP-2 chain ID", () => {
      expect(() => getEvmChainId("eip155:abc")).toThrow("Invalid CAIP-2 chain ID");
    });
  });

  describe("getEvmChainIdV1 (legacy names)", () => {
    it("should return correct chain ID for Base", () => {
      expect(getEvmChainIdV1("base")).toBe(8453);
    });

    it("should return correct chain ID for Base Sepolia", () => {
      expect(getEvmChainIdV1("base-sepolia")).toBe(84532);
    });

    it("should return correct chain ID for Ethereum", () => {
      expect(getEvmChainIdV1("ethereum")).toBe(1);
    });

    it("should return correct chain ID for Polygon", () => {
      expect(getEvmChainIdV1("polygon")).toBe(137);
    });

    it("should return correct chain ID for Polygon Amoy", () => {
      expect(getEvmChainIdV1("polygon-amoy")).toBe(80002);
    });

    it("should return correct chain ID for Abstract", () => {
      expect(getEvmChainIdV1("abstract")).toBe(2741);
    });

    it("should return correct chain ID for Avalanche", () => {
      expect(getEvmChainIdV1("avalanche")).toBe(43114);
    });

    it("should return correct chain ID for MegaETH", () => {
      expect(getEvmChainIdV1("megaeth")).toBe(4326);
    });

    it("should return correct chain ID for Monad", () => {
      expect(getEvmChainIdV1("monad")).toBe(143);
    });

    it("should throw for CAIP-2 format", () => {
      expect(() => getEvmChainIdV1("eip155:8453")).toThrow("Unsupported v1 network");
    });

    it("should throw for unknown network", () => {
      expect(() => getEvmChainIdV1("unknown-network")).toThrow("Unsupported v1 network");
    });
  });

  describe("createNonce", () => {
    it("should create a 32-byte hex nonce", () => {
      const nonce = createNonce();
      expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("should create different nonces on each call", () => {
      const nonce1 = createNonce();
      const nonce2 = createNonce();
      expect(nonce1).not.toBe(nonce2);
    });

    it("should create valid hex strings", () => {
      for (let i = 0; i < 10; i++) {
        const nonce = createNonce();
        expect(nonce.startsWith("0x")).toBe(true);
        expect(nonce.length).toBe(66); // "0x" + 64 hex characters
      }
    });
  });
});
