import { describe, it, expect } from "vitest";
import { toClientEvmSigner, toFacilitatorEvmSigner } from "../../src/signer";
import type { ClientEvmSigner } from "../../src/signer";

describe("EVM Signer Converters", () => {
  describe("toClientEvmSigner", () => {
    it("should return a composed signer when signer already has readContract", () => {
      const mockSigner: ClientEvmSigner = {
        address: "0x1234567890123456789012345678901234567890",
        signTypedData: async () => "0xsignature" as `0x${string}`,
        readContract: async () => BigInt(0),
      };

      const result = toClientEvmSigner(mockSigner);
      expect(result.address).toBe(mockSigner.address);
      expect(result.readContract).toBeDefined();
    });

    it("should compose a signer with readContract from publicClient", () => {
      const mockAccount = {
        address: "0x1234567890123456789012345678901234567890" as `0x${string}`,
        signTypedData: async () => "0xsignature" as `0x${string}`,
      };

      const mockPublicClient = {
        readContract: async () => BigInt(42),
      };

      const result = toClientEvmSigner(mockAccount, mockPublicClient);
      expect(result.address).toBe(mockAccount.address);
      expect(result.readContract).toBeDefined();
    });

    it("should return minimal signer when no readContract exists", () => {
      const mockAccount = {
        address: "0x1234567890123456789012345678901234567890" as `0x${string}`,
        signTypedData: async () => "0xsignature" as `0x${string}`,
      };

      const result = toClientEvmSigner(mockAccount);
      expect(result.address).toBe(mockAccount.address);
      expect(result.readContract).toBeUndefined();
    });
  });

  describe("toFacilitatorEvmSigner", () => {
    it("should wrap client with getAddresses() method", () => {
      const mockClient = {
        address: "0x1234567890123456789012345678901234567890" as `0x${string}`,
        readContract: async () => BigInt(0),
        verifyTypedData: async () => true,
        writeContract: async () => "0xtxhash" as `0x${string}`,
        waitForTransactionReceipt: async () => ({ status: "success" }),
        getCode: async () => "0x" as `0x${string}`,
      };

      const result = toFacilitatorEvmSigner(mockClient);

      // Should add getAddresses() method
      expect(result.getAddresses).toBeDefined();
      expect(result.getAddresses()).toEqual([mockClient.address]);

      // Should preserve all other methods
      expect(result.readContract).toBe(mockClient.readContract);
      expect(result.verifyTypedData).toBe(mockClient.verifyTypedData);
      expect(result.writeContract).toBe(mockClient.writeContract);
      expect(result.waitForTransactionReceipt).toBe(mockClient.waitForTransactionReceipt);
      expect(result.getCode).toBe(mockClient.getCode);
    });
  });
});
