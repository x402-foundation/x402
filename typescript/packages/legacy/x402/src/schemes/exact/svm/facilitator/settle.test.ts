/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type TransactionSigner, generateKeyPairSigner } from "@solana/kit";
import * as solanaKit from "@solana/kit";
import * as transactionConfirmation from "@solana/transaction-confirmation";
import { PaymentPayload, PaymentRequirements, ExactSvmPayload } from "../../../../types/verify";
import {
  decodeTransactionFromPayload,
  getTokenPayerFromTransaction,
  signTransactionWithSigner,
} from "../../../../shared/svm";
import { getRpcClient, getRpcSubscriptions } from "../../../../shared/svm/rpc";
import { verify } from "./verify";
import * as settleModule from "./settle";
import { SettlementCache } from "./settlement-cache";

// Mocking dependencies
vi.mock("../../../../shared/svm");
vi.mock("../../../../shared/svm/rpc");
vi.mock("./verify");
vi.mock("@solana/kit", async importOriginal => {
  const actual = await importOriginal<typeof solanaKit>();
  return {
    ...actual,
    signTransaction: vi.fn().mockResolvedValue({
      messageBytes: new Uint8Array([1, 2, 3, 4]),
      signatures: [new Uint8Array([5, 6, 7, 8])],
    }),
    getBase64EncodedWireTransaction: vi.fn().mockReturnValue("base64_encoded_transaction"),
    getSignatureFromTransaction: vi.fn().mockReturnValue("mock_signature_123"),
    getCompiledTransactionMessageDecoder: vi.fn().mockReturnValue({
      decode: vi.fn().mockReturnValue({}),
      read: vi.fn(),
    }),
    assertIsTransactionMessageWithBlockhashLifetime: vi.fn(),
    decompileTransactionMessageFetchingLookupTables: vi.fn(),
    isSolanaError: vi.fn(),
  };
});
vi.mock("@solana/transaction-confirmation", async importOriginal => {
  const actual = await importOriginal<typeof transactionConfirmation>();
  return {
    ...actual,
    createBlockHeightExceedencePromiseFactory: vi.fn().mockReturnValue(vi.fn()),
    waitForRecentTransactionConfirmation: vi.fn(),
    createRecentSignatureConfirmationPromiseFactory: vi.fn().mockReturnValue(vi.fn()),
  };
});

describe("SVM Settle", () => {
  let signer: TransactionSigner;
  let payerAddress: string;
  let paymentPayload: PaymentPayload;
  let paymentRequirements: PaymentRequirements;
  let mockRpcClient: any;
  let mockRpcSubscriptions: any;
  let mockSignedTransaction: any;

  beforeAll(async () => {
    signer = await generateKeyPairSigner();
    payerAddress = (await generateKeyPairSigner()).address;
    const payToAddress = (await generateKeyPairSigner()).address;
    const assetAddress = (await generateKeyPairSigner()).address;

    paymentRequirements = {
      scheme: "exact",
      network: "solana-devnet",
      payTo: payToAddress,
      asset: assetAddress,
      maxAmountRequired: "1000",
      resource: "http://example.com/resource",
      description: "Test description",
      mimeType: "text/plain",
      maxTimeoutSeconds: 60,
      extra: {
        feePayer: signer.address,
      },
    };

    paymentPayload = {
      scheme: "exact",
      network: "solana-devnet",
      x402Version: 1,
      payload: {
        transaction: "base64_encoded_transaction",
      } as ExactSvmPayload,
    };

    mockSignedTransaction = {
      messageBytes: new Uint8Array([1, 2, 3, 4]),
      signatures: [new Uint8Array([5, 6, 7, 8])],
      lifetimeConstraint: {
        blockhash: "mock_blockhash",
        lastValidBlockHeight: 1234,
      },
    };

    mockRpcClient = {
      sendTransaction: vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue("mock_signature_123"),
      }),
    };

    mockRpcSubscriptions = {
      subscribe: vi.fn(),
    };
  });

  let txCounter = 0;
  /**
   * Returns a unique payment payload for each call (increments tx counter).
   *
   * @returns A PaymentPayload with a unique transaction identifier
   */
  function uniquePayload(): PaymentPayload {
    return {
      ...paymentPayload,
      payload: { transaction: `tx_${txCounter++}` } as ExactSvmPayload,
    };
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("settle", () => {
    it("should successfully settle a payment when verification passes", async () => {
      // Arrange
      const payload = uniquePayload();
      const mockVerifyResponse = {
        isValid: true,
        invalidReason: undefined,
      };
      vi.mocked(verify).mockResolvedValue(mockVerifyResponse);
      vi.mocked(decodeTransactionFromPayload).mockReturnValue(mockSignedTransaction);
      vi.mocked(getRpcClient).mockReturnValue(mockRpcClient);
      vi.mocked(getRpcSubscriptions).mockReturnValue(mockRpcSubscriptions);
      vi.mocked(mockRpcClient.sendTransaction).mockReturnValue({
        send: vi.fn().mockResolvedValue("mock_signature_123"),
      });
      vi.mocked(solanaKit.getCompiledTransactionMessageDecoder).mockReturnValue({
        decode: vi.fn().mockReturnValue({}),
        read: vi.fn(),
      } as any);
      vi.mocked(solanaKit.decompileTransactionMessageFetchingLookupTables).mockResolvedValue({
        lifetimeConstraint: {
          blockhash: "mock_blockhash" as any,
          lastValidBlockHeight: BigInt(1234),
        },
        instructions: [],
        version: 0,
      } as any);
      vi.mocked(getTokenPayerFromTransaction).mockReturnValue(payerAddress);
      vi.mocked(signTransactionWithSigner).mockResolvedValue(mockSignedTransaction);
      vi.mocked(transactionConfirmation.waitForRecentTransactionConfirmation).mockResolvedValue(
        undefined,
      );

      // Act
      const result = await settleModule.settle(signer, payload, paymentRequirements);

      // Assert
      expect(verify).toHaveBeenCalledWith(signer, payload, paymentRequirements, undefined);
      expect(decodeTransactionFromPayload).toHaveBeenCalledWith(payload.payload);
      expect(signTransactionWithSigner).toHaveBeenCalledWith(signer, mockSignedTransaction);
      expect(transactionConfirmation.waitForRecentTransactionConfirmation).toHaveBeenCalledOnce();
      expect(mockRpcClient.sendTransaction).toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        errorReason: undefined,
        payer: payerAddress,
        transaction: "mock_signature_123",
        network: "solana-devnet",
      });
    });

    it("should return verification failure when verification fails", async () => {
      // Arrange
      const mockVerifyResponse = {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_transaction_simulation_failed" as const,
      };
      vi.mocked(verify).mockResolvedValue(mockVerifyResponse);

      // Act
      const result = await settleModule.settle(signer, paymentPayload, paymentRequirements);

      // Assert
      expect(verify).toHaveBeenCalledWith(signer, paymentPayload, paymentRequirements, undefined);
      expect(result).toEqual({
        success: false,
        errorReason: "invalid_exact_svm_payload_transaction_simulation_failed",
        network: "solana-devnet",
        transaction: "",
      });
    });

    it("should return unexpected errors during settlement", async () => {
      // Arrange
      const payload = uniquePayload();
      const mockVerifyResponse = {
        isValid: true,
        invalidReason: undefined,
      };
      vi.mocked(verify).mockResolvedValue(mockVerifyResponse);
      vi.mocked(decodeTransactionFromPayload).mockReturnValue(mockSignedTransaction);
      vi.mocked(getTokenPayerFromTransaction).mockReturnValue(payerAddress);
      vi.mocked(getRpcClient).mockReturnValue(mockRpcClient);
      vi.mocked(getRpcSubscriptions).mockReturnValue(mockRpcSubscriptions);
      vi.mocked(signTransactionWithSigner).mockResolvedValue(mockSignedTransaction);
      // Mock the sendAndConfirmSignedTransaction to throw an error
      vi.mocked(mockRpcClient.sendTransaction).mockReturnValue({
        send: vi.fn().mockRejectedValue(new Error("Unexpected error")),
      });

      // Act
      const result = await settleModule.settle(signer, payload, paymentRequirements);

      // Assert
      expect(result).toEqual({
        success: false,
        errorReason: "unexpected_settle_error",
        network: "solana-devnet",
        transaction: "mock_signature_123",
        payer: payerAddress,
      });
    });
  });

  describe("sendSignedTransaction", () => {
    it("should successfully send a signed transaction", async () => {
      // Arrange
      const sendTxConfig = {
        skipPreflight: true,
        encoding: "base64" as const,
      };
      // Reset mock to ensure clean state
      vi.mocked(mockRpcClient.sendTransaction).mockReturnValue({
        send: vi.fn().mockResolvedValue("mock_signature_123"),
      });

      // Act
      const result = await settleModule.sendSignedTransaction(
        mockSignedTransaction,
        mockRpcClient,
        sendTxConfig,
      );

      // Assert
      expect(solanaKit.getBase64EncodedWireTransaction).toHaveBeenCalledWith(mockSignedTransaction);
      expect(mockRpcClient.sendTransaction).toHaveBeenCalledWith(
        "base64_encoded_transaction",
        sendTxConfig,
      );
      expect(result).toBe("mock_signature_123");
    });

    it("should use default config when no config is provided", async () => {
      // Arrange
      const expectedConfig = {
        skipPreflight: true,
        encoding: "base64" as const,
      };
      // Reset mock to ensure clean state
      vi.mocked(mockRpcClient.sendTransaction).mockReturnValue({
        send: vi.fn().mockResolvedValue("mock_signature_123"),
      });

      // Act
      await settleModule.sendSignedTransaction(mockSignedTransaction, mockRpcClient);

      // Assert
      expect(mockRpcClient.sendTransaction).toHaveBeenCalledWith(
        "base64_encoded_transaction",
        expectedConfig,
      );
    });

    it("should throw unexpected RPC errors", async () => {
      // Arrange
      const rpcError = new Error("RPC Error");
      vi.mocked(mockRpcClient.sendTransaction).mockReturnValue({
        send: vi.fn().mockRejectedValue(rpcError),
      });

      // Act & Assert
      await expect(
        settleModule.sendSignedTransaction(mockSignedTransaction, mockRpcClient),
      ).rejects.toThrow("RPC Error");
    });
  });

  describe("confirmSignedTransaction", () => {
    it("should successfully confirm a signed transaction", async () => {
      // Arrange
      const mockDecompiledMessage = {
        lifetimeConstraint: {
          blockhash: "mock_blockhash" as any,
          lastValidBlockHeight: BigInt(1234),
        },
        instructions: [],
        version: 0,
      } as any;
      vi.mocked(solanaKit.getCompiledTransactionMessageDecoder).mockReturnValue({
        decode: vi.fn().mockReturnValue({}),
        read: vi.fn(),
      } as any);
      vi.mocked(solanaKit.decompileTransactionMessageFetchingLookupTables).mockResolvedValue(
        mockDecompiledMessage,
      );
      vi.mocked(transactionConfirmation.waitForRecentTransactionConfirmation).mockResolvedValue(
        undefined,
      );

      // Act
      const result = await settleModule.confirmSignedTransaction(
        mockSignedTransaction,
        mockRpcClient,
        mockRpcSubscriptions,
      );

      // Assert
      expect(solanaKit.getSignatureFromTransaction).toHaveBeenCalledWith(mockSignedTransaction);
      expect(solanaKit.assertIsTransactionMessageWithBlockhashLifetime).toHaveBeenCalledWith(
        mockDecompiledMessage,
      );
      expect(transactionConfirmation.waitForRecentTransactionConfirmation).toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        signature: "mock_signature_123",
      });
    });

    it("should handle block height exceeded errors", async () => {
      // Arrange
      const blockHeightError = new Error("Block height exceeded");
      blockHeightError.name = "SolanaError";
      vi.mocked(solanaKit.getCompiledTransactionMessageDecoder).mockReturnValue({
        decode: vi.fn().mockReturnValue({}),
        read: vi.fn(),
      } as any);
      vi.mocked(solanaKit.decompileTransactionMessageFetchingLookupTables).mockResolvedValue({
        lifetimeConstraint: {
          blockhash: "mock_blockhash" as any,
          lastValidBlockHeight: BigInt(1234),
        },
        instructions: [],
        version: 0,
      } as any);
      vi.mocked(transactionConfirmation.waitForRecentTransactionConfirmation).mockRejectedValue(
        blockHeightError,
      );
      vi.mocked(solanaKit.isSolanaError).mockReturnValue(true);

      // Act
      const result = await settleModule.confirmSignedTransaction(
        mockSignedTransaction,
        mockRpcClient,
        mockRpcSubscriptions,
      );

      // Assert
      expect(result).toEqual({
        success: false,
        errorReason: "settle_exact_svm_block_height_exceeded",
        signature: "mock_signature_123",
      });
    });

    it("should handle transaction confirmation timeout", async () => {
      // Arrange
      const abortError = new DOMException(
        "Transaction confirmation timed out after 60 seconds",
        "AbortError",
      );
      vi.mocked(solanaKit.getCompiledTransactionMessageDecoder).mockReturnValue({
        decode: vi.fn().mockReturnValue({}),
        read: vi.fn(),
      } as any);
      vi.mocked(solanaKit.decompileTransactionMessageFetchingLookupTables).mockResolvedValue({
        lifetimeConstraint: {
          blockhash: "mock_blockhash" as any,
          lastValidBlockHeight: BigInt(1234),
        },
        instructions: [],
        version: 0,
      } as any);
      vi.mocked(transactionConfirmation.waitForRecentTransactionConfirmation).mockRejectedValue(
        abortError,
      );
      // Ensure isSolanaError returns false for this error
      vi.mocked(solanaKit.isSolanaError).mockReturnValue(false);

      // Act
      const result = await settleModule.confirmSignedTransaction(
        mockSignedTransaction,
        mockRpcClient,
        mockRpcSubscriptions,
      );

      // Assert
      expect(result).toEqual({
        success: false,
        errorReason: "settle_exact_svm_transaction_confirmation_timed_out",
        signature: "mock_signature_123",
      });
    });

    it("should throw unexpected errors", async () => {
      // Arrange
      const unexpectedError = new Error("Unexpected error");
      vi.mocked(solanaKit.getCompiledTransactionMessageDecoder).mockReturnValue({
        decode: vi.fn().mockReturnValue({}),
        read: vi.fn(),
      } as any);
      vi.mocked(solanaKit.decompileTransactionMessageFetchingLookupTables).mockResolvedValue({
        lifetimeConstraint: {
          blockhash: "mock_blockhash" as any,
          lastValidBlockHeight: BigInt(1234),
        },
        instructions: [],
        version: 0,
      } as any);
      vi.mocked(transactionConfirmation.waitForRecentTransactionConfirmation).mockRejectedValue(
        unexpectedError,
      );
      // Ensure isSolanaError returns false for this error
      vi.mocked(solanaKit.isSolanaError).mockReturnValue(false);

      // Act & Assert
      await expect(
        settleModule.confirmSignedTransaction(
          mockSignedTransaction,
          mockRpcClient,
          mockRpcSubscriptions,
        ),
      ).rejects.toThrow("Unexpected error");
    });
  });

  describe("Custom RPC Configuration", () => {
    it("should use custom RPC URL from config for both client and subscriptions", async () => {
      // Arrange
      const payload = uniquePayload();
      const customRpcUrl = "http://localhost:8899";
      const config = { svmConfig: { rpcUrl: customRpcUrl } };
      const mockVerifyResponse = {
        isValid: true,
        invalidReason: undefined,
      };
      vi.mocked(verify).mockResolvedValue(mockVerifyResponse);
      vi.mocked(decodeTransactionFromPayload).mockReturnValue(mockSignedTransaction);
      vi.mocked(getRpcClient).mockReturnValue(mockRpcClient);
      vi.mocked(getRpcSubscriptions).mockReturnValue(mockRpcSubscriptions);
      vi.mocked(mockRpcClient.sendTransaction).mockReturnValue({
        send: vi.fn().mockResolvedValue("mock_signature_123"),
      });
      vi.mocked(solanaKit.getCompiledTransactionMessageDecoder).mockReturnValue({
        decode: vi.fn().mockReturnValue({}),
        read: vi.fn(),
      } as any);
      vi.mocked(solanaKit.decompileTransactionMessageFetchingLookupTables).mockResolvedValue({
        lifetimeConstraint: {
          blockhash: "mock_blockhash" as any,
          lastValidBlockHeight: BigInt(1234),
        },
        instructions: [],
        version: 0,
      } as any);
      vi.mocked(getTokenPayerFromTransaction).mockReturnValue(payerAddress);
      vi.mocked(signTransactionWithSigner).mockResolvedValue(mockSignedTransaction);
      vi.mocked(transactionConfirmation.waitForRecentTransactionConfirmation).mockResolvedValue(
        undefined,
      );

      // Act
      await settleModule.settle(signer, payload, paymentRequirements, config);

      // Assert
      expect(getRpcClient).toHaveBeenCalledWith("solana-devnet", customRpcUrl);
      expect(getRpcSubscriptions).toHaveBeenCalledWith("solana-devnet", customRpcUrl);
    });

    it("should propagate config to verify() call", async () => {
      // Arrange
      const payload = uniquePayload();
      const customRpcUrl = "https://api.mainnet-beta.solana.com";
      const config = { svmConfig: { rpcUrl: customRpcUrl } };
      const mockVerifyResponse = {
        isValid: true,
        invalidReason: undefined,
      };
      vi.mocked(verify).mockResolvedValue(mockVerifyResponse);
      vi.mocked(decodeTransactionFromPayload).mockReturnValue(mockSignedTransaction);
      vi.mocked(getRpcClient).mockReturnValue(mockRpcClient);
      vi.mocked(getRpcSubscriptions).mockReturnValue(mockRpcSubscriptions);
      vi.mocked(mockRpcClient.sendTransaction).mockReturnValue({
        send: vi.fn().mockResolvedValue("mock_signature_123"),
      });
      vi.mocked(solanaKit.getCompiledTransactionMessageDecoder).mockReturnValue({
        decode: vi.fn().mockReturnValue({}),
        read: vi.fn(),
      } as any);
      vi.mocked(solanaKit.decompileTransactionMessageFetchingLookupTables).mockResolvedValue({
        lifetimeConstraint: {
          blockhash: "mock_blockhash" as any,
          lastValidBlockHeight: BigInt(1234),
        },
        instructions: [],
        version: 0,
      } as any);
      vi.mocked(getTokenPayerFromTransaction).mockReturnValue(payerAddress);
      vi.mocked(signTransactionWithSigner).mockResolvedValue(mockSignedTransaction);
      vi.mocked(transactionConfirmation.waitForRecentTransactionConfirmation).mockResolvedValue(
        undefined,
      );

      // Act
      await settleModule.settle(signer, payload, paymentRequirements, config);

      // Assert
      expect(verify).toHaveBeenCalledWith(signer, payload, paymentRequirements, config);
    });

    it("should work without config (backward compatibility)", async () => {
      // Arrange
      const payload = uniquePayload();
      const mockVerifyResponse = {
        isValid: true,
        invalidReason: undefined,
      };
      vi.mocked(verify).mockResolvedValue(mockVerifyResponse);
      vi.mocked(decodeTransactionFromPayload).mockReturnValue(mockSignedTransaction);
      vi.mocked(getRpcClient).mockReturnValue(mockRpcClient);
      vi.mocked(getRpcSubscriptions).mockReturnValue(mockRpcSubscriptions);
      vi.mocked(mockRpcClient.sendTransaction).mockReturnValue({
        send: vi.fn().mockResolvedValue("mock_signature_123"),
      });
      vi.mocked(solanaKit.getCompiledTransactionMessageDecoder).mockReturnValue({
        decode: vi.fn().mockReturnValue({}),
        read: vi.fn(),
      } as any);
      vi.mocked(solanaKit.decompileTransactionMessageFetchingLookupTables).mockResolvedValue({
        lifetimeConstraint: {
          blockhash: "mock_blockhash" as any,
          lastValidBlockHeight: BigInt(1234),
        },
        instructions: [],
        version: 0,
      } as any);
      vi.mocked(getTokenPayerFromTransaction).mockReturnValue(payerAddress);
      vi.mocked(signTransactionWithSigner).mockResolvedValue(mockSignedTransaction);
      vi.mocked(transactionConfirmation.waitForRecentTransactionConfirmation).mockResolvedValue(
        undefined,
      );

      // Act
      await settleModule.settle(signer, payload, paymentRequirements);

      // Assert
      expect(verify).toHaveBeenCalledWith(signer, payload, paymentRequirements, undefined);
      expect(getRpcClient).toHaveBeenCalledWith("solana-devnet", undefined);
      expect(getRpcSubscriptions).toHaveBeenCalledWith("solana-devnet", undefined);
    });
  });

  describe("sendAndConfirmSignedTransaction", () => {
    it("should successfully send and confirm a transaction", async () => {
      // Arrange
      vi.mocked(mockRpcClient.sendTransaction).mockReturnValue({
        send: vi.fn().mockResolvedValue("mock_signature_123"),
      });
      vi.mocked(solanaKit.getCompiledTransactionMessageDecoder).mockReturnValue({
        decode: vi.fn().mockReturnValue({}),
        read: vi.fn(),
      } as any);
      vi.mocked(solanaKit.decompileTransactionMessageFetchingLookupTables).mockResolvedValue({
        lifetimeConstraint: {
          blockhash: "mock_blockhash" as any,
          lastValidBlockHeight: BigInt(1234),
        },
        instructions: [],
        version: 0,
      } as any);
      vi.mocked(transactionConfirmation.waitForRecentTransactionConfirmation).mockResolvedValue(
        undefined,
      );

      // Act
      const result = await settleModule.sendAndConfirmSignedTransaction(
        mockSignedTransaction,
        mockRpcClient,
        mockRpcSubscriptions,
      );

      // Assert
      expect(mockRpcClient.sendTransaction).toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        signature: "mock_signature_123",
      });
    });

    it("should propagate errors from sendSignedTransaction", async () => {
      // Arrange
      const sendError = new Error("Send error");
      vi.mocked(mockRpcClient.sendTransaction).mockReturnValue({
        send: vi.fn().mockRejectedValue(sendError),
      });

      // Act & Assert
      await expect(
        settleModule.sendAndConfirmSignedTransaction(
          mockSignedTransaction,
          mockRpcClient,
          mockRpcSubscriptions,
        ),
      ).rejects.toThrow("Send error");
    });

    it("should propagate errors from confirmSignedTransaction", async () => {
      // Arrange
      vi.mocked(mockRpcClient.sendTransaction).mockReturnValue({
        send: vi.fn().mockResolvedValue("mock_signature_123"),
      });
      const confirmError = new Error("Confirm error");
      vi.mocked(solanaKit.getCompiledTransactionMessageDecoder).mockReturnValue({
        decode: vi.fn().mockReturnValue({}),
        read: vi.fn(),
      } as any);
      vi.mocked(solanaKit.decompileTransactionMessageFetchingLookupTables).mockResolvedValue({
        lifetimeConstraint: {
          blockhash: "mock_blockhash" as any,
          lastValidBlockHeight: BigInt(1234),
        },
        instructions: [],
        version: 0,
      } as any);
      vi.mocked(transactionConfirmation.waitForRecentTransactionConfirmation).mockRejectedValue(
        confirmError,
      );
      // Ensure isSolanaError returns false for this error
      vi.mocked(solanaKit.isSolanaError).mockReturnValue(false);

      // Act & Assert
      await expect(
        settleModule.sendAndConfirmSignedTransaction(
          mockSignedTransaction,
          mockRpcClient,
          mockRpcSubscriptions,
        ),
      ).rejects.toThrow("Confirm error");
    });

    it("should return confirmation failure result", async () => {
      // Arrange
      vi.mocked(mockRpcClient.sendTransaction).mockReturnValue({
        send: vi.fn().mockResolvedValue("mock_signature_123"),
      });
      const blockHeightError = new Error("Block height exceeded");
      blockHeightError.name = "SolanaError";
      vi.mocked(solanaKit.getCompiledTransactionMessageDecoder).mockReturnValue({
        decode: vi.fn().mockReturnValue({}),
        read: vi.fn(),
      } as any);
      vi.mocked(solanaKit.decompileTransactionMessageFetchingLookupTables).mockResolvedValue({
        lifetimeConstraint: {
          blockhash: "mock_blockhash" as any,
          lastValidBlockHeight: BigInt(1234),
        },
        instructions: [],
        version: 0,
      } as any);
      vi.mocked(transactionConfirmation.waitForRecentTransactionConfirmation).mockRejectedValue(
        blockHeightError,
      );
      vi.mocked(solanaKit.isSolanaError).mockReturnValue(true);

      // Act
      const result = await settleModule.sendAndConfirmSignedTransaction(
        mockSignedTransaction,
        mockRpcClient,
        mockRpcSubscriptions,
      );

      // Assert
      expect(result).toEqual({
        success: false,
        errorReason: "settle_exact_svm_block_height_exceeded",
        signature: "mock_signature_123",
      });
    });
  });

  describe("duplicate settlement cache", () => {
    /**
     * Builds a payment payload for the given transaction signature.
     *
     * @param transaction - The transaction signature to embed in the payload
     * @returns A PaymentPayload for Solana devnet with the given transaction
     */
    function makePayload(transaction: string): PaymentPayload {
      return {
        scheme: "exact",
        network: "solana-devnet",
        x402Version: 1,
        payload: { transaction } as ExactSvmPayload,
      };
    }

    /**
     * Configures mocks so that settle() succeeds (verify passes, RPC and decode mocks in place).
     *
     * @returns void
     */
    function setupMocksForSettle() {
      const mockVerifyResponse = { isValid: true, invalidReason: undefined };
      vi.mocked(verify).mockResolvedValue(mockVerifyResponse);
      vi.mocked(decodeTransactionFromPayload).mockReturnValue(mockSignedTransaction);
      vi.mocked(getRpcClient).mockReturnValue(mockRpcClient);
      vi.mocked(getRpcSubscriptions).mockReturnValue(mockRpcSubscriptions);
      vi.mocked(mockRpcClient.sendTransaction).mockReturnValue({
        send: vi.fn().mockResolvedValue("mock_signature_123"),
      });
      vi.mocked(solanaKit.getCompiledTransactionMessageDecoder).mockReturnValue({
        decode: vi.fn().mockReturnValue({}),
        read: vi.fn(),
      } as any);
      vi.mocked(solanaKit.decompileTransactionMessageFetchingLookupTables).mockResolvedValue({
        lifetimeConstraint: {
          blockhash: "mock_blockhash" as any,
          lastValidBlockHeight: BigInt(1234),
        },
        instructions: [],
        version: 0,
      } as any);
      vi.mocked(getTokenPayerFromTransaction).mockReturnValue(payerAddress);
      vi.mocked(signTransactionWithSigner).mockResolvedValue(mockSignedTransaction);
      vi.mocked(transactionConfirmation.waitForRecentTransactionConfirmation).mockResolvedValue(
        undefined,
      );
    }

    it("should reject duplicate settlement of the same transaction", async () => {
      setupMocksForSettle();

      const payload = makePayload("sameTransactionBase64==");

      const result1 = await settleModule.settle(signer, payload, paymentRequirements);
      expect(result1.success).toBe(true);

      const result2 = await settleModule.settle(signer, payload, paymentRequirements);
      expect(result2.success).toBe(false);
      expect(result2.errorReason).toBe("duplicate_settlement");
    });

    it("should allow settlement of distinct transactions", async () => {
      setupMocksForSettle();

      const result1 = await settleModule.settle(
        signer,
        makePayload("transactionA=="),
        paymentRequirements,
      );
      expect(result1.success).toBe(true);

      const result2 = await settleModule.settle(
        signer,
        makePayload("transactionB=="),
        paymentRequirements,
      );
      expect(result2.success).toBe(true);
    });

    it("should evict cache entries after TTL", async () => {
      vi.useFakeTimers();
      try {
        setupMocksForSettle();

        const payload = makePayload("expiringTransaction==");

        const result1 = await settleModule.settle(signer, payload, paymentRequirements);
        expect(result1.success).toBe(true);

        // Advance past the 120s TTL
        vi.advanceTimersByTime(121_000);

        const result2 = await settleModule.settle(signer, payload, paymentRequirements);
        expect(result2.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("SettlementCache prune optimization", () => {
  it("should prune only expired entries and preserve non-expired ones", () => {
    vi.useFakeTimers();
    try {
      const cache = new SettlementCache();

      cache.isDuplicate("tx-a");
      vi.advanceTimersByTime(10_000);
      cache.isDuplicate("tx-b");
      vi.advanceTimersByTime(10_000);
      cache.isDuplicate("tx-c");

      // Advance so tx-a is expired (> 120s old) but tx-b and tx-c are not
      vi.advanceTimersByTime(101_000); // total: tx-a=121s, tx-b=111s, tx-c=101s

      expect(cache.isDuplicate("tx-a")).toBe(false); // expired, re-inserted as new
      expect(cache.isDuplicate("tx-b")).toBe(true); // still cached
      expect(cache.isDuplicate("tx-c")).toBe(true); // still cached
    } finally {
      vi.useRealTimers();
    }
  });

  it("should prune all entries when all are expired", () => {
    vi.useFakeTimers();
    try {
      const cache = new SettlementCache();

      cache.isDuplicate("tx-1");
      cache.isDuplicate("tx-2");
      cache.isDuplicate("tx-3");

      vi.advanceTimersByTime(121_000);

      expect(cache.isDuplicate("tx-1")).toBe(false);
      expect(cache.isDuplicate("tx-2")).toBe(false);
      expect(cache.isDuplicate("tx-3")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should not prune any entries when none are expired", () => {
    const cache = new SettlementCache();

    cache.isDuplicate("tx-x");
    cache.isDuplicate("tx-y");
    cache.isDuplicate("tx-z");

    expect(cache.isDuplicate("tx-x")).toBe(true);
    expect(cache.isDuplicate("tx-y")).toBe(true);
    expect(cache.isDuplicate("tx-z")).toBe(true);
  });
});
