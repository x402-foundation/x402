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

      // Should have getSigner() method
      expect(result.getSigner).toBeDefined();
      expect(typeof result.getSigner).toBe("function");
      expect(result.getSigner(mockSigner.address)).toBe(mockSigner);

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

      expect(() => result.getSigner("UnknownAddress11111111111111111111" as never)).toThrow(
        "No signer for feePayer",
      );

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

    it("should reject confirmed transactions that failed onchain", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };

      const mockRpc = {
        getBalance: vi.fn(),
        getSlot: vi.fn(),
        getSignatureStatuses: vi.fn().mockReturnValue({
          send: vi.fn().mockResolvedValue({
            value: [
              {
                confirmationStatus: "confirmed",
                err: { InstructionError: [0, { Custom: 1 }] },
              },
            ],
          }),
        }),
      } as never;

      const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);

      await expect(
        facilitator.confirmTransaction("failedSignature", SOLANA_DEVNET_CAIP2),
      ).rejects.toThrow("Transaction failed onchain:");
    });

    it("should resolve when a transaction is confirmed without error", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };

      const mockRpc = {
        getBalance: vi.fn(),
        getSlot: vi.fn(),
        getSignatureStatuses: vi.fn().mockReturnValue({
          send: vi.fn().mockResolvedValue({
            value: [
              {
                confirmationStatus: "finalized",
                err: null,
              },
            ],
          }),
        }),
      } as never;

      const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);

      await expect(
        facilitator.confirmTransaction("okSignature", SOLANA_DEVNET_CAIP2),
      ).resolves.toBeUndefined();
    });

    it("should simulate with sigVerify disabled", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };

      const simulateTransaction = vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue({ value: { err: null } }),
      });
      const mockRpc = {
        getBalance: vi.fn(),
        getSlot: vi.fn(),
        simulateTransaction,
      } as never;

      const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);
      await facilitator.simulateTransaction("tx", SOLANA_DEVNET_CAIP2);

      expect(simulateTransaction).toHaveBeenCalledWith(
        "tx",
        expect.objectContaining({
          sigVerify: false,
          commitment: "confirmed",
          encoding: "base64",
        }),
      );
    });

    it("should honor simulateTransaction options", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };

      const simulateTransaction = vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue({ value: { err: null } }),
      });
      const mockRpc = {
        getBalance: vi.fn(),
        getSlot: vi.fn(),
        simulateTransaction,
      } as never;

      const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);
      await facilitator.simulateTransaction("tx", SOLANA_DEVNET_CAIP2, {
        sigVerify: true,
        commitment: "finalized",
        encoding: "base64",
        replaceRecentBlockhash: true,
      });

      expect(simulateTransaction).toHaveBeenCalledWith("tx", {
        sigVerify: true,
        replaceRecentBlockhash: true,
        commitment: "finalized",
        encoding: "base64",
      });
    });

    it("should honor replaceRecentBlockhash on simulate", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };

      const simulateTransaction = vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue({ value: { err: null } }),
      });
      const mockRpc = {
        getBalance: vi.fn(),
        getSlot: vi.fn(),
        simulateTransaction,
      } as never;

      const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);
      await facilitator.simulateTransaction("tx", SOLANA_DEVNET_CAIP2, {
        replaceRecentBlockhash: true,
      });

      expect(simulateTransaction).toHaveBeenCalledWith(
        "tx",
        expect.objectContaining({ replaceRecentBlockhash: true }),
      );
    });

    it("should expose upto read RPC helpers from the factory", () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };

      const facilitator = toFacilitatorSvmSigner(mockSigner as never);
      expect(facilitator.getAccountInfo).toBeDefined();
      expect(facilitator.getLatestBlockhash).toBeDefined();
      expect(facilitator.getSlot).toBeDefined();
      expect(facilitator.getProgramAccounts).toBeDefined();
    });

    it("should return the kit getProgramAccounts array without a context unwrap", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };

      const rows = [
        {
          pubkey: "ChannelPda11111111111111111111111111111111",
          account: {
            data: ["AQID", "base64"] as [string, string],
            owner: "Program1111111111111111111111111111111111",
          },
        },
      ];
      const getProgramAccounts = vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue(rows),
      });
      const mockRpc = {
        getBalance: vi.fn(),
        getSlot: vi.fn(),
        getProgramAccounts,
      } as never;

      const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);
      const result = await facilitator.getProgramAccounts!(SOLANA_DEVNET_CAIP2, "program", {
        commitment: "confirmed",
        encoding: "base64",
      });

      expect(result).toEqual(rows);
      expect(getProgramAccounts).toHaveBeenCalledWith(
        "program",
        expect.objectContaining({ commitment: "confirmed", encoding: "base64" }),
      );
    });

    it("should send with skipPreflight enabled", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };

      const sendTransaction = vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue("sig"),
      });
      const mockRpc = {
        getBalance: vi.fn(),
        getSlot: vi.fn(),
        sendTransaction,
      } as never;

      const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);
      await facilitator.sendTransaction("tx", SOLANA_DEVNET_CAIP2);

      expect(sendTransaction).toHaveBeenCalledWith(
        "tx",
        expect.objectContaining({
          skipPreflight: true,
          preflightCommitment: "confirmed",
          encoding: "base64",
        }),
      );
    });
  });
});
