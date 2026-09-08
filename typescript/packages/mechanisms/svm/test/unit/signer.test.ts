import { describe, it, expect, vi } from "vitest";

vi.mock("@solana/kit", async importOriginal => {
  const actual = await importOriginal<typeof import("@solana/kit")>();
  return {
    ...actual,
    fetchAddressesForLookupTables: vi.fn(
      (...args: Parameters<typeof actual.fetchAddressesForLookupTables>) =>
        actual.fetchAddressesForLookupTables(...args),
    ),
  };
});

import {
  fetchAddressesForLookupTables,
  generateKeyPairSigner,
  getCompiledTransactionMessageEncoder,
  type Address,
} from "@solana/kit";
import {
  createRpcCapabilitiesFromRpc,
  toClientSvmSigner,
  toFacilitatorSvmSigner,
} from "../../src/signer";
import type { ClientSvmSigner } from "../../src/signer";
import { SOLANA_DEVNET_CAIP2, SOLANA_MAINNET_CAIP2 } from "../../src/constants";
import { encodeSignedTransaction, placeholderFeePayerSignature } from "./helpers/signedTransaction";

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

    it("signs a transaction with the matching fee-payer key", async () => {
      const feePayer = await generateKeyPairSigner();
      const computeBudget = "ComputeBudget111111111111111111111111111111" as Address;
      const compiled = {
        version: 0 as const,
        header: {
          numSignerAccounts: 1,
          numReadonlySignerAccounts: 0,
          numReadonlyNonSignerAccounts: 1,
        },
        staticAccounts: [feePayer.address, computeBudget],
        lifetimeToken: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
        instructions: [
          {
            programAddressIndex: 1,
            accountIndices: [],
            data: new Uint8Array([2, 160, 134, 1, 0]),
          },
        ],
      };
      const messageBytes = getCompiledTransactionMessageEncoder().encode(compiled);
      const transaction = await encodeSignedTransaction(
        messageBytes,
        [],
        placeholderFeePayerSignature(feePayer.address),
      );

      const facilitator = toFacilitatorSvmSigner(feePayer);
      const signed = await facilitator.signTransaction(
        transaction,
        feePayer.address,
        SOLANA_DEVNET_CAIP2,
      );
      expect(signed).toBeTruthy();
      expect(signed).not.toBe(transaction);
    });

    it("uses an exact network RPC mapping before the wildcard", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };
      const simulateDevnet = vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue({ value: { err: null } }),
      });
      const simulateMainnet = vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue({ value: { err: null } }),
      });
      const facilitator = toFacilitatorSvmSigner(mockSigner as never, {
        [SOLANA_DEVNET_CAIP2]: {
          getBalance: vi.fn(),
          getSlot: vi.fn(),
          simulateTransaction: simulateDevnet,
        } as never,
        [SOLANA_MAINNET_CAIP2]: {
          getBalance: vi.fn(),
          getSlot: vi.fn(),
          simulateTransaction: simulateMainnet,
        } as never,
      });

      await facilitator.simulateTransaction("tx", SOLANA_DEVNET_CAIP2);
      expect(simulateDevnet).toHaveBeenCalled();
      expect(simulateMainnet).not.toHaveBeenCalled();
    });

    it("returns inner instructions from a successful smart-wallet simulation", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };
      const innerInstructions = [
        { index: 0, instructions: [{ programIdIndex: 1, accounts: [2, 3], data: "AQID" }] },
      ];
      const mockRpc = {
        getBalance: vi.fn(),
        getSlot: vi.fn(),
        simulateTransaction: vi.fn().mockReturnValue({
          send: vi.fn().mockResolvedValue({ value: { err: null, innerInstructions } }),
        }),
      } as never;
      const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);
      const result = await facilitator.simulateTransactionWithInnerInstructions!(
        "tx",
        SOLANA_DEVNET_CAIP2,
      );
      expect(result.innerInstructions).toEqual(innerInstructions);
    });

    it("returns null inner instructions when the RPC omits them", async () => {
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
      const result = await facilitator.simulateTransactionWithInnerInstructions!(
        "tx",
        SOLANA_DEVNET_CAIP2,
      );
      expect(result.innerInstructions).toBeNull();
    });

    it("serializes BigInt values when smart-wallet simulation fails", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };
      const mockRpc = {
        getBalance: vi.fn(),
        getSlot: vi.fn(),
        simulateTransaction: vi.fn().mockReturnValue({
          send: vi.fn().mockResolvedValue({
            value: { err: { Custom: 1, lamports: BigInt("9001") } },
          }),
        }),
      } as never;
      const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);
      await expect(
        facilitator.simulateTransactionWithInnerInstructions!("tx", SOLANA_DEVNET_CAIP2),
      ).rejects.toThrow("Smart wallet simulation failed:");
      await expect(
        facilitator.simulateTransactionWithInnerInstructions!("tx", SOLANA_DEVNET_CAIP2),
      ).rejects.toThrow("9001");
    });

    it("returns null when a confirmed transaction is not yet indexed", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };
      const mockRpc = {
        getBalance: vi.fn(),
        getSlot: vi.fn(),
        getTransaction: vi.fn().mockReturnValue({ send: vi.fn().mockResolvedValue(null) }),
      } as never;
      const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);
      await expect(
        facilitator.getConfirmedTransactionInnerInstructions!("sig", SOLANA_DEVNET_CAIP2),
      ).resolves.toBeNull();
    });

    it("returns null inner instructions when confirmed meta omits them", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };
      const mockRpc = {
        getBalance: vi.fn(),
        getSlot: vi.fn(),
        getTransaction: vi.fn().mockReturnValue({ send: vi.fn().mockResolvedValue({}) }),
      } as never;
      const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);
      await expect(
        facilitator.getConfirmedTransactionInnerInstructions!("sig", SOLANA_DEVNET_CAIP2),
      ).resolves.toEqual({ innerInstructions: null });
    });

    it("returns confirmed inner instructions when meta includes them", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };
      const innerInstructions = [{ index: 0, instructions: [] }];
      const mockRpc = {
        getBalance: vi.fn(),
        getSlot: vi.fn(),
        getTransaction: vi.fn().mockReturnValue({
          send: vi.fn().mockResolvedValue({ meta: { innerInstructions } }),
        }),
      } as never;
      const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);
      await expect(
        facilitator.getConfirmedTransactionInnerInstructions!("sig", SOLANA_DEVNET_CAIP2),
      ).resolves.toEqual({ innerInstructions });
    });

    it("returns a token account balance or null when the RPC omits amount", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };
      const getTokenAccountBalance = vi
        .fn()
        .mockReturnValueOnce({
          send: vi.fn().mockResolvedValue({ value: { amount: "42" } }),
        })
        .mockReturnValueOnce({
          send: vi.fn().mockResolvedValue({ value: {} }),
        })
        .mockReturnValueOnce({
          send: vi.fn().mockRejectedValue(new Error("account missing")),
        });
      const mockRpc = {
        getBalance: vi.fn(),
        getSlot: vi.fn(),
        getTokenAccountBalance,
      } as never;
      const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);
      await expect(facilitator.getTokenAccountBalance!("ata", SOLANA_DEVNET_CAIP2)).resolves.toBe(
        42n,
      );
      await expect(
        facilitator.getTokenAccountBalance!("ata", SOLANA_DEVNET_CAIP2),
      ).resolves.toBeNull();
      await expect(
        facilitator.getTokenAccountBalance!("ata", SOLANA_DEVNET_CAIP2),
      ).resolves.toBeNull();
    });

    it("surfaces ALT resolution failures instead of returning an empty map", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };
      const mockRpc = {
        getBalance: vi.fn(),
        getSlot: vi.fn(),
      } as never;
      const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);
      await expect(
        facilitator.fetchAddressLookupTables!(
          ["Alt111111111111111111111111111111111"],
          SOLANA_DEVNET_CAIP2,
        ),
      ).rejects.toThrow("invalid_exact_svm_smart_wallet_alt_resolution_failed");
    });

    it("maps resolved ALT addresses onto the lookup-table keys", async () => {
      vi.mocked(fetchAddressesForLookupTables).mockResolvedValueOnce({
        Alt111111111111111111111111111111111: ["Resolved11111111111111111111111111" as Address],
      } as never);
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };
      const facilitator = toFacilitatorSvmSigner(
        mockSigner as never,
        {
          getBalance: vi.fn(),
          getSlot: vi.fn(),
        } as never,
      );
      await expect(
        facilitator.fetchAddressLookupTables!(
          ["Alt111111111111111111111111111111111"],
          SOLANA_DEVNET_CAIP2,
        ),
      ).resolves.toEqual({
        Alt111111111111111111111111111111111: ["Resolved11111111111111111111111111"],
      });
    });

    it("fetches account info, a recent blockhash, and the current slot", async () => {
      const mockSigner = {
        address: "FacilitatorAddress1111111111111111111" as never,
        signTransactions: vi.fn() as never,
        signMessages: vi.fn().mockResolvedValue([{}]) as never,
      };
      const account = {
        data: ["AQID", "base64"],
        owner: "11111111111111111111111111111111",
        lamports: 1n,
      };
      const getAccountInfo = vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue({ value: account }),
      });
      const getLatestBlockhash = vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue({
          value: { blockhash: "hash", lastValidBlockHeight: 9n },
        }),
      });
      const getSlot = vi.fn().mockReturnValue({ send: vi.fn().mockResolvedValue(77n) });
      const mockRpc = {
        getBalance: vi.fn(),
        getSlot,
        getAccountInfo,
        getLatestBlockhash,
      } as never;
      const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);

      await expect(
        facilitator.getAccountInfo!("acct", SOLANA_DEVNET_CAIP2, {
          commitment: "finalized",
          encoding: "base64",
        }),
      ).resolves.toEqual(account);
      await expect(facilitator.getLatestBlockhash!(SOLANA_DEVNET_CAIP2)).resolves.toEqual({
        blockhash: "hash",
        lastValidBlockHeight: 9n,
      });
      await expect(facilitator.getSlot!(SOLANA_DEVNET_CAIP2)).resolves.toBe(77n);
    });

    it("times out confirmation after the polling budget", async () => {
      vi.useFakeTimers();
      try {
        const mockSigner = {
          address: "FacilitatorAddress1111111111111111111" as never,
          signTransactions: vi.fn() as never,
          signMessages: vi.fn().mockResolvedValue([{}]) as never,
        };
        const mockRpc = {
          getBalance: vi.fn(),
          getSlot: vi.fn(),
          getSignatureStatuses: vi.fn().mockReturnValue({
            send: vi.fn().mockResolvedValue({ value: [null] }),
          }),
        } as never;
        const facilitator = toFacilitatorSvmSigner(mockSigner as never, mockRpc);
        const pending = expect(
          facilitator.confirmTransaction("sig", SOLANA_DEVNET_CAIP2),
        ).rejects.toThrow("Transaction confirmation timeout");
        await vi.advanceTimersByTimeAsync(31_000);
        await pending;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("createRpcCapabilitiesFromRpc", () => {
    it("reads SOL and token balances and throws when the token account is missing", async () => {
      const getBalance = vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue({ value: 5n }),
      });
      const getAccountInfo = vi
        .fn()
        .mockReturnValueOnce({
          send: vi.fn().mockResolvedValue({
            value: { data: { parsed: { info: { tokenAmount: { amount: "99" } } } } },
          }),
        })
        .mockReturnValueOnce({ send: vi.fn().mockResolvedValue({ value: null }) });
      const rpc = { getBalance, getAccountInfo } as never;
      const caps = createRpcCapabilitiesFromRpc(rpc);

      await expect(caps.getBalance("11111111111111111111111111111111")).resolves.toBe(5n);
      await expect(caps.getTokenAccountBalance("ata")).resolves.toBe(99n);
      await expect(caps.getTokenAccountBalance("ata")).rejects.toThrow("Token account not found");
    });

    it("fetchMint delegates to the Token-2022 helper", async () => {
      const caps = createRpcCapabilitiesFromRpc({} as never);
      await expect(caps.fetchMint("Mint11111111111111111111111111111111")).rejects.toThrow();
    });

    it("forwards simulate/send and returns the latest blockhash", async () => {
      const getLatestBlockhash = vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue({
          value: { blockhash: "bh", lastValidBlockHeight: 3n },
        }),
      });
      const simulateTransaction = vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue({ value: { err: null } }),
      });
      const sendTransaction = vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue("sig"),
      });
      const caps = createRpcCapabilitiesFromRpc({
        getLatestBlockhash,
        simulateTransaction,
        sendTransaction,
      } as never);

      await expect(caps.getLatestBlockhash()).resolves.toEqual({
        blockhash: "bh",
        lastValidBlockHeight: 3n,
      });
      await expect(caps.simulateTransaction("tx", { encoding: "base64" })).resolves.toEqual({
        value: { err: null },
      });
      await expect(caps.sendTransaction("tx")).resolves.toBe("sig");
      expect(sendTransaction).toHaveBeenCalledWith("tx", {
        encoding: "base64",
        skipPreflight: true,
        preflightCommitment: "confirmed",
      });
    });

    it("rejects a confirmed onchain failure and serializes BigInt error fields", async () => {
      const getSignatureStatuses = vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue({
          value: [
            {
              confirmationStatus: "confirmed",
              err: { Custom: 1, lamports: BigInt("7") },
            },
          ],
        }),
      });
      const caps = createRpcCapabilitiesFromRpc({ getSignatureStatuses } as never);
      await expect(caps.confirmTransaction("sig")).rejects.toThrow("Transaction failed onchain:");
      await expect(caps.confirmTransaction("sig")).rejects.toThrow("7");
    });
  });
});
