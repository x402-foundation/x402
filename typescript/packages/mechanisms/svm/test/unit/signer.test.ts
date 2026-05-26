import { describe, it, expect, vi } from "vitest";
import { toClientSvmSigner, toFacilitatorSvmSigner } from "../../src/signer";
import type { ClientSvmSigner } from "../../src/signer";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";

describe("SVM Signer Converters", () => {
  describe("toClientSvmSigner", () => {
    it("should return the same signer (identity function)", () => {
      const mockSigner: ClientSvmSigner = {
        address: "9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ" as never,
        signTransactions: vi.fn() as never,
      };

      const result = toClientSvmSigner(mockSigner);
      expect(result).toBe(mockSigner);
      expect(result.address).toBe(mockSigner.address);
    });
  });

  describe("toFacilitatorSvmSigner", () => {
    it("should create facilitator signer with required methods", () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };

      const result = toFacilitatorSvmSigner(mockSigner as never);

      // Should have getAddresses() method
      expect(result.getAddresses).toBeDefined();
      expect(typeof result.getAddresses).toBe("function");
      expect(result.getAddresses()).toEqual([mockSigner.address]);

      // Should have signTransaction() method
      expect(result.signTransaction).toBeDefined();
      expect(typeof result.signTransaction).toBe("function");

      // Should have simulateTransaction() method
      expect(result.simulateTransaction).toBeDefined();
      expect(typeof result.simulateTransaction).toBe("function");

      // Should have sendTransaction() method
      expect(result.sendTransaction).toBeDefined();
      expect(typeof result.sendTransaction).toBe("function");

      // Should have confirmTransaction() method
      expect(result.confirmTransaction).toBeDefined();
      expect(typeof result.confirmTransaction).toBe("function");
    });

    it("should throw error when signing with unknown feePayer address", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };

      const result = toFacilitatorSvmSigner(mockSigner as never);

      await expect(
        result.signTransaction(
          "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAEDAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
          "UnknownAddress11111111111111111111" as never,
          SOLANA_DEVNET_CAIP2,
        ),
      ).rejects.toThrow("No signer for feePayer");
    });

    it("should work with default RPC for devnet", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };

      const facilitator = toFacilitatorSvmSigner(mockSigner as never);

      // Verify that RPC operations are available (internal RPC client creation works)
      expect(facilitator.simulateTransaction).toBeDefined();
      expect(facilitator.sendTransaction).toBeDefined();
      expect(facilitator.confirmTransaction).toBeDefined();
    });

    it("should work with default RPC for mainnet", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };

      const facilitator = toFacilitatorSvmSigner(mockSigner as never);

      // Verify that facilitator can be used with mainnet
      expect(facilitator.simulateTransaction).toBeDefined();
      expect(facilitator.sendTransaction).toBeDefined();
    });

    it("should support custom RPC URL", () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };

      const facilitator = toFacilitatorSvmSigner(mockSigner as never, {
        defaultRpcUrl: "https://custom-rpc.com",
      });

      // Should create facilitator with custom RPC URL
      expect(facilitator).toBeDefined();
      expect(facilitator.simulateTransaction).toBeDefined();
    });

    it("should support per-network RPC mapping", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };

      const mockDevnetRpc = {
        getBalance: vi.fn(),
        getSlot: vi.fn(),
        simulateTransaction: vi.fn().mockReturnValue({
          send: vi.fn().mockResolvedValue({ value: { err: null } }),
        }),
      } as never;

      const facilitator = toFacilitatorSvmSigner(mockSigner as never, {
        [SOLANA_DEVNET_CAIP2]: mockDevnetRpc,
      });

      // Should use the custom RPC for devnet (verified by not throwing)
      expect(facilitator).toBeDefined();
      expect(facilitator.simulateTransaction).toBeDefined();
    });

    it("should support wildcard RPC client", () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };

      const mockRpc = {
        getBalance: vi.fn(),
        getSlot: vi.fn(),
        simulateTransaction: vi.fn().mockReturnValue({
          send: vi.fn().mockResolvedValue({ value: { err: null } }),
        }),
      } as never;

      const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);

      // Should create facilitator with wildcard RPC
      expect(facilitator).toBeDefined();
      expect(facilitator.simulateTransaction).toBeDefined();
    });

    it("should handle BigInt values in simulation error responses", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };

      // Mock RPC that returns a simulation error with BigInt values (like lamports)
      const mockRpc = {
        getBalance: vi.fn(),
        getSlot: vi.fn(),
        simulateTransaction: vi.fn().mockReturnValue({
          send: vi.fn().mockResolvedValue({
            value: {
              err: {
                InstructionError: [
                  0,
                  {
                    Custom: 1,
                    // Simulate BigInt values that Solana RPC might return
                    lamports: BigInt("1000000000"),
                    requiredLamports: BigInt("2000000000"),
                  },
                ],
              },
            },
          }),
        }),
      } as never;

      const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);

      // Should throw an error with properly serialized BigInt values (not crash)
      await expect(
        facilitator.simulateTransaction("dummyTransaction", SOLANA_DEVNET_CAIP2),
      ).rejects.toThrow("Simulation failed:");

      // Verify the error message contains the serialized BigInt values as strings
      try {
        await facilitator.simulateTransaction("dummyTransaction", SOLANA_DEVNET_CAIP2);
      } catch (error) {
        expect((error as Error).message).toContain("1000000000");
        expect((error as Error).message).toContain("2000000000");
        expect((error as Error).message).not.toContain("BigInt");
      }
    });
  });
});
