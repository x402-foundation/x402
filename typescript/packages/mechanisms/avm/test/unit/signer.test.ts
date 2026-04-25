import { describe, it, expect } from "vitest";
import {
  toClientAvmSigner,
  toFacilitatorAvmSigner,
  getAlgokitSigner,
  isAvmSignerWallet,
  ALGOKIT_SIGNER,
} from "../../src";
import type { ClientAvmSigner } from "../../src";

// Generate a valid test key: 32-byte seed + 32-byte public key = 64 bytes, base64 encoded
// This is a throwaway test key — not used on any network
const TEST_PRIVATE_KEY_BASE64 =
  "mZHHvLfOqJrIxIMTYPFdGWxfZy1MtaT3J6aJny+4yW1jkF6o6oKpKU7m5JfNdghc26oLTvRnEEBkDjY14WU3Cw==";

describe("AVM Signer", () => {
  describe("toClientAvmSigner", () => {
    it("should create a client signer from a valid Base64 private key", () => {
      const signer = toClientAvmSigner(TEST_PRIVATE_KEY_BASE64);

      expect(signer).toBeDefined();
      expect(signer.address).toBeDefined();
      expect(typeof signer.address).toBe("string");
      expect(signer.address.length).toBe(58); // Algorand address length
    });

    it("should derive a consistent address from the same key", () => {
      const signer1 = toClientAvmSigner(TEST_PRIVATE_KEY_BASE64);
      const signer2 = toClientAvmSigner(TEST_PRIVATE_KEY_BASE64);

      expect(signer1.address).toBe(signer2.address);
    });

    it("should have a working signTransactions method", () => {
      const signer = toClientAvmSigner(TEST_PRIVATE_KEY_BASE64);

      expect(signer.signTransactions).toBeDefined();
      expect(typeof signer.signTransactions).toBe("function");
    });

    it("should throw for invalid private key (wrong length)", () => {
      expect(() => toClientAvmSigner("dG9vc2hvcnQ=")).toThrow(
        "AVM private key must be a Base64-encoded 64-byte key",
      );
    });

    it("should throw for invalid private key (not base64)", () => {
      expect(() => toClientAvmSigner("not-valid-base64!!!")).toThrow();
    });

    it("should throw for empty string", () => {
      expect(() => toClientAvmSigner("")).toThrow();
    });

    it("should attach internal algokit signer via ALGOKIT_SIGNER symbol", () => {
      const signer = toClientAvmSigner(TEST_PRIVATE_KEY_BASE64);

      // The symbol property should exist but not be enumerable
      const symbolKeys = Object.getOwnPropertySymbols(signer);
      expect(symbolKeys).toContain(ALGOKIT_SIGNER);

      // Should not appear in regular enumeration
      expect(Object.keys(signer)).not.toContain(ALGOKIT_SIGNER.toString());
    });
  });

  describe("toFacilitatorAvmSigner", () => {
    it("should create a facilitator signer from a valid Base64 private key", () => {
      const signer = toFacilitatorAvmSigner(TEST_PRIVATE_KEY_BASE64);

      expect(signer).toBeDefined();
    });

    it("should return correct addresses", () => {
      const signer = toFacilitatorAvmSigner(TEST_PRIVATE_KEY_BASE64);
      const addresses = signer.getAddresses();

      expect(addresses).toHaveLength(1);
      expect(typeof addresses[0]).toBe("string");
      expect(addresses[0].length).toBe(58);
    });

    it("should derive the same address as toClientAvmSigner for the same key", () => {
      const clientSigner = toClientAvmSigner(TEST_PRIVATE_KEY_BASE64);
      const facilitatorSigner = toFacilitatorAvmSigner(TEST_PRIVATE_KEY_BASE64);

      expect(facilitatorSigner.getAddresses()[0]).toBe(clientSigner.address);
    });

    it("should implement all required interface methods", () => {
      const signer = toFacilitatorAvmSigner(TEST_PRIVATE_KEY_BASE64);

      expect(signer.getAddresses).toBeDefined();
      expect(signer.signTransaction).toBeDefined();
      expect(signer.getAlgodClient).toBeDefined();
      expect(signer.simulateTransactions).toBeDefined();
      expect(signer.sendTransactions).toBeDefined();
      expect(signer.waitForConfirmation).toBeDefined();
    });

    it("should accept custom URL configuration", () => {
      const signer = toFacilitatorAvmSigner(TEST_PRIVATE_KEY_BASE64, {
        testnetUrl: "https://custom-testnet.example.com",
        mainnetUrl: "https://custom-mainnet.example.com",
        algodToken: "custom-token",
      });

      expect(signer).toBeDefined();
      expect(signer.getAddresses()).toHaveLength(1);
    });

    it("should work with default config (no custom URLs)", () => {
      const signer = toFacilitatorAvmSigner(TEST_PRIVATE_KEY_BASE64);

      expect(signer).toBeDefined();
      // getAlgodClient should return an algod client using AlgorandClient defaults
      const algod = signer.getAlgodClient("algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=");
      expect(algod).toBeDefined();
    });

    it("should throw for invalid private key", () => {
      expect(() => toFacilitatorAvmSigner("dG9vc2hvcnQ=")).toThrow(
        "AVM private key must be a Base64-encoded 64-byte key",
      );
    });
  });

  describe("getAlgokitSigner", () => {
    it("should return AddressWithTransactionSigner for toClientAvmSigner-created signers", () => {
      const signer = toClientAvmSigner(TEST_PRIVATE_KEY_BASE64);
      const algokitSigner = getAlgokitSigner(signer);

      expect(algokitSigner).not.toBeNull();
      expect(algokitSigner!.addr).toBeDefined();
      expect(algokitSigner!.signer).toBeDefined();
      expect(typeof algokitSigner!.signer).toBe("function");
      expect(algokitSigner!.addr.toString()).toBe(signer.address);
    });

    it("should return null for manually created signers (e.g., wallet adapters)", () => {
      const manualSigner: ClientAvmSigner = {
        address: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
        signTransactions: async (txns, indexesToSign) => {
          return txns.map((_, i) => {
            if (indexesToSign && !indexesToSign.includes(i)) return null;
            return new Uint8Array([0]);
          });
        },
      };

      const algokitSigner = getAlgokitSigner(manualSigner);
      expect(algokitSigner).toBeNull();
    });

    it("should return null for objects without the ALGOKIT_SIGNER symbol", () => {
      const fakeSigner = {
        address: "SOME_ADDRESS",
        signTransactions: async () => [],
      } as ClientAvmSigner;

      expect(getAlgokitSigner(fakeSigner)).toBeNull();
    });
  });

  describe("isAvmSignerWallet", () => {
    it("should return true for valid ClientAvmSigner objects", () => {
      const signer = toClientAvmSigner(TEST_PRIVATE_KEY_BASE64);
      expect(isAvmSignerWallet(signer)).toBe(true);
    });

    it("should return true for manually created objects with correct shape", () => {
      const manual = {
        address: "SOME_ADDRESS",
        signTransactions: async () => [],
      };
      expect(isAvmSignerWallet(manual)).toBe(true);
    });

    it("should return false for null", () => {
      expect(isAvmSignerWallet(null)).toBe(false);
    });

    it("should return false for undefined", () => {
      expect(isAvmSignerWallet(undefined)).toBe(false);
    });

    it("should return false for objects missing address", () => {
      expect(isAvmSignerWallet({ signTransactions: async () => [] })).toBe(false);
    });

    it("should return false for objects missing signTransactions", () => {
      expect(isAvmSignerWallet({ address: "test" })).toBe(false);
    });

    it("should return false for objects with wrong types", () => {
      expect(isAvmSignerWallet({ address: 123, signTransactions: async () => [] })).toBe(false);
      expect(isAvmSignerWallet({ address: "test", signTransactions: "not-a-function" })).toBe(
        false,
      );
    });

    it("should return false for primitive values", () => {
      expect(isAvmSignerWallet("string")).toBe(false);
      expect(isAvmSignerWallet(42)).toBe(false);
      expect(isAvmSignerWallet(true)).toBe(false);
    });
  });
});
