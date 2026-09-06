import { describe, it, expect } from "vitest";
import { Account } from "@aptos-labs/ts-sdk";
import { createClientSigner, toFacilitatorAptosSigner } from "../../src/signer";

describe("Aptos Signer", () => {
  describe("createClientSigner", () => {
    it("should create a client signer from a valid private key", async () => {
      // Generate a test account to get a valid private key
      const testAccount = Account.generate();
      const privateKey = testAccount.privateKey.toString();

      const signer = await createClientSigner(privateKey);

      expect(signer).toBeDefined();
      expect(signer.accountAddress).toBeDefined();
      expect(signer.accountAddress.toString()).toBe(testAccount.accountAddress.toString());
    });

    it("should handle AIP-80 formatted private keys", async () => {
      // Generate a test account
      const testAccount = Account.generate();
      // AIP-80 format includes the key type prefix
      const privateKey = testAccount.privateKey.toString();

      const signer = await createClientSigner(privateKey);

      expect(signer).toBeDefined();
      expect(signer.signTransactionWithAuthenticator).toBeDefined();
    });

    it("should throw for invalid private keys", async () => {
      await expect(createClientSigner("invalid-key")).rejects.toThrow();
    });
  });

  describe("toFacilitatorAptosSigner", () => {
    it("should return signer addresses", () => {
      const testAccount = Account.generate();
      const facilitatorSigner = toFacilitatorAptosSigner(testAccount);

      const addresses = facilitatorSigner.getAddresses();

      expect(addresses).toHaveLength(1);
      expect(addresses[0]).toBe(testAccount.accountAddress.toStringLong());
    });

    it("should implement all required methods", () => {
      const testAccount = Account.generate();
      const facilitatorSigner = toFacilitatorAptosSigner(testAccount);

      expect(facilitatorSigner.getAddresses).toBeDefined();
      expect(facilitatorSigner.signAndSubmitAsFeePayer).toBeDefined();
      expect(facilitatorSigner.submitTransaction).toBeDefined();
      expect(facilitatorSigner.simulateTransaction).toBeDefined();
      expect(facilitatorSigner.waitForTransaction).toBeDefined();
    });

    it("should use custom RPC URL when provided", () => {
      const testAccount = Account.generate();
      const customRpcUrl = "https://custom-rpc.example.com";
      const facilitatorSigner = toFacilitatorAptosSigner(testAccount, {
        defaultRpcUrl: customRpcUrl,
      });

      // The signer should be created successfully with custom config
      expect(facilitatorSigner).toBeDefined();
      expect(facilitatorSigner.getAddresses()).toHaveLength(1);
    });

    it("should support network-specific RPC URLs", () => {
      const testAccount = Account.generate();
      const rpcConfig = {
        "aptos:1": "https://mainnet-rpc.example.com",
        "aptos:2": "https://testnet-rpc.example.com",
      };
      const facilitatorSigner = toFacilitatorAptosSigner(testAccount, rpcConfig);

      expect(facilitatorSigner).toBeDefined();
      expect(facilitatorSigner.getAddresses()).toHaveLength(1);
    });
  });
});
