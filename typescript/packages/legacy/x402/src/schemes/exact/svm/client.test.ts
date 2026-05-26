/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, describe, expect, it, vi, beforeEach } from "vitest";
import { type Address, type TransactionSigner, generateKeyPairSigner, lamports } from "@solana/kit";
import * as solanaKit from "@solana/kit";
import * as token2022 from "@solana-program/token-2022";
import * as token from "@solana-program/token";
import * as computeBudget from "@solana-program/compute-budget";
import * as paymentUtils from "../../utils";
import { PaymentRequirements } from "../../../types/verify";
import * as rpc from "../../../shared/svm/rpc";
import { createAndSignPayment, createPaymentHeader } from "./client";

// Mocking dependencies
vi.mock("../../../shared/svm/rpc");
vi.mock("../../utils/paymentUtils");
vi.mock("@solana-program/token-2022", async importOriginal => {
  const actual = await importOriginal<typeof token2022>();
  return {
    ...actual,
    findAssociatedTokenPda: vi.fn(),
    getTransferCheckedInstruction: vi.fn().mockReturnValue({ instruction: "mock_transfer" }),
    fetchMint: vi.fn(),
  };
});
vi.mock("@solana/kit", async importOriginal => {
  const actual = await importOriginal<typeof solanaKit>();
  return {
    ...actual,
    createTransactionMessage: vi.fn().mockReturnValue({ version: 0, instructions: [] }),
    setTransactionMessageFeePayer: vi.fn().mockImplementation((_payer, tx) => tx),
    setTransactionMessageLifetimeUsingBlockhash: vi.fn().mockImplementation((_bh, tx) => tx),
    appendTransactionMessageInstructions: vi.fn().mockImplementation((ixs, tx) => {
      return { ...tx, instructions: [...tx.instructions, ...ixs] };
    }),
    prependTransactionMessageInstruction: vi.fn().mockImplementation((ix, tx) => {
      return { ...tx, instructions: [ix, ...tx.instructions] };
    }),
    partiallySignTransactionMessageWithSigners: vi.fn().mockResolvedValue("signed_tx_message"),
    getBase64EncodedWireTransaction: vi.fn().mockReturnValue("base64_encoded_tx"),
    fetchEncodedAccount: vi.fn(),
  };
});
vi.mock("@solana-program/compute-budget", async importOriginal => {
  const actual = await importOriginal<typeof computeBudget>();
  return {
    ...actual,
    getSetComputeUnitLimitInstruction: vi.fn().mockReturnValue({ instruction: "mock" }),
    setTransactionMessageComputeUnitPrice: vi.fn().mockImplementation((_price, tx) => tx),
    estimateComputeUnitLimitFactory: vi.fn().mockReturnValue(vi.fn().mockResolvedValue(1000)),
  };
});

describe("SVM Client", () => {
  let clientSigner: TransactionSigner;
  let paymentRequirements: PaymentRequirements;
  const mockRpcClient = {
    getLatestBlockhash: vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({
        value: {
          blockhash: "mockBlockhash",
          lastValidBlockHeight: 1234,
        },
      }),
    }),
    fetchEncodedAccount: vi.fn(),
  };

  beforeAll(async () => {
    clientSigner = await generateKeyPairSigner();
    const payToAddress = (await generateKeyPairSigner()).address;
    const assetAddress = (await generateKeyPairSigner()).address;
    const feePayerAddress = (await generateKeyPairSigner()).address;
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
        feePayer: feePayerAddress,
      },
    };
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock RPC client using the getRpcClient function
    vi.spyOn(rpc, "getRpcClient").mockReturnValue(mockRpcClient as any);

    // Mock fetchEncodedAccount to return existing account by default when fetching ATAs
    vi.spyOn(solanaKit, "fetchEncodedAccount").mockResolvedValue({ exists: true } as any);

    // Mock fetchMint to determine token program
    vi.spyOn(token2022, "fetchMint").mockImplementation(async (_rpc, address) => {
      if (address === paymentRequirements.asset) {
        return {
          address: address,
          programAddress: token.TOKEN_PROGRAM_ADDRESS,
          executable: false,
          lamports: lamports(1000n),
          space: 165n,
          data: {
            mintAuthority: null,
            supply: 0n,
            decimals: 6,
            isInitialized: true,
            freezeAuthority: null,
            extensions: [],
          },
        } as any;
      }
      throw new Error("Mint not found");
    });

    // Mock ATAs
    vi.spyOn(token2022, "findAssociatedTokenPda").mockResolvedValue([
      "sourceATA" as Address,
      1 as any,
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("createAndSignPayment", () => {
    it("should create and sign a payment for a spl-token token", async () => {
      // Arrange
      vi.spyOn(solanaKit, "partiallySignTransactionMessageWithSigners").mockResolvedValue(
        "signed_tx_message" as any,
      );
      const findAtaSpy = vi.spyOn(token2022, "findAssociatedTokenPda");
      const transferIxSpy = vi.spyOn(token2022, "getTransferCheckedInstruction");

      // Act
      await createAndSignPayment(clientSigner, 1, paymentRequirements);

      // Assert
      expect(findAtaSpy).toHaveBeenCalledTimes(2); // once for sender, once for receiver
      expect(findAtaSpy).toHaveBeenCalledWith({
        mint: paymentRequirements.asset,
        owner: clientSigner.address,
        tokenProgram: token.TOKEN_PROGRAM_ADDRESS,
      });
      expect(findAtaSpy).toHaveBeenCalledWith({
        mint: paymentRequirements.asset,
        owner: paymentRequirements.payTo,
        tokenProgram: token.TOKEN_PROGRAM_ADDRESS,
      });
      expect(transferIxSpy).toHaveBeenCalledOnce();
      expect(transferIxSpy).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ programAddress: token.TOKEN_PROGRAM_ADDRESS }),
      );
    });

    it("should create and sign a payment for a token-2022 token", async () => {
      // Arrange
      vi.spyOn(solanaKit, "partiallySignTransactionMessageWithSigners").mockResolvedValue(
        "signed_tx_message" as any,
      );
      vi.spyOn(token2022, "fetchMint").mockResolvedValue({
        address: paymentRequirements.asset as Address,
        programAddress: token2022.TOKEN_2022_PROGRAM_ADDRESS,
        data: { decimals: 6 },
      } as any);
      const findAtaSpy = vi.spyOn(token2022, "findAssociatedTokenPda");
      const transferIxSpy = vi.spyOn(token2022, "getTransferCheckedInstruction");

      // Act
      await createAndSignPayment(clientSigner, 1, paymentRequirements);

      // Assert
      expect(findAtaSpy).toHaveBeenCalledTimes(2);
      expect(findAtaSpy).toHaveBeenCalledWith({
        mint: paymentRequirements.asset,
        owner: clientSigner.address,
        tokenProgram: token2022.TOKEN_2022_PROGRAM_ADDRESS,
      });
      expect(findAtaSpy).toHaveBeenCalledWith({
        mint: paymentRequirements.asset,
        owner: paymentRequirements.payTo,
        tokenProgram: token2022.TOKEN_2022_PROGRAM_ADDRESS,
      });
      expect(transferIxSpy).toHaveBeenCalledOnce();
      expect(transferIxSpy).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ programAddress: token2022.TOKEN_2022_PROGRAM_ADDRESS }),
      );
    });

    it("should throw an error if asset is not from a known token program", async () => {
      // Arrange
      vi.spyOn(token2022, "fetchMint").mockResolvedValue({
        address: paymentRequirements.asset as Address,
        programAddress: "someotherprogram" as any,
        executable: false,
        lamports: lamports(1000n),
        space: 165n,
        data: {} as any,
      });

      // Act & Assert
      await expect(createAndSignPayment(clientSigner, 1, paymentRequirements)).rejects.toThrow(
        "Asset was not created by a known token program",
      );
    });
  });

  describe("createPaymentHeader", () => {
    it("should create a payment header string", async () => {
      // Arrange
      vi.spyOn(paymentUtils, "encodePayment").mockReturnValue("encoded_payment_header");

      // Act
      const header = await createPaymentHeader(clientSigner, 1, paymentRequirements);

      // Assert
      expect(paymentUtils.encodePayment).toHaveBeenCalledOnce();
      expect(header).toBe("encoded_payment_header");
    });

    it("should handle different x402 versions", async () => {
      // Arrange
      const encodePaymentSpy = vi
        .spyOn(paymentUtils, "encodePayment")
        .mockReturnValue("encoded_payment_header");

      // Act
      await createPaymentHeader(clientSigner, 2, paymentRequirements);

      // Assert
      expect(encodePaymentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          x402Version: 2,
        }),
      );
    });

    it("should throw an error if signing fails", async () => {
      // Arrange
      vi.spyOn(solanaKit, "partiallySignTransactionMessageWithSigners").mockRejectedValue(
        new Error("Signing failed"),
      );

      // Act & Assert
      await expect(createPaymentHeader(clientSigner, 1, paymentRequirements)).rejects.toThrow(
        "Signing failed",
      );
    });

    it("should throw an error if encoding fails", async () => {
      // Arrange
      vi.spyOn(solanaKit, "partiallySignTransactionMessageWithSigners").mockResolvedValue(
        "signed_tx_message" as any,
      );
      vi.spyOn(paymentUtils, "encodePayment").mockImplementation(() => {
        throw new Error("Encoding failed");
      });

      // Act & Assert
      await expect(createPaymentHeader(clientSigner, 1, paymentRequirements)).rejects.toThrow(
        "Encoding failed",
      );
    });
  });

  describe("getComputeUnitLimit", () => {
    it("should estimate and set the compute unit limit", async () => {
      // Arrange
      vi.spyOn(solanaKit, "partiallySignTransactionMessageWithSigners").mockResolvedValue(
        "signed_tx_message" as any,
      );
      const estimateComputeUnitLimitMock = vi.fn().mockResolvedValue(200000);
      vi.spyOn(computeBudget, "estimateComputeUnitLimitFactory").mockReturnValue(
        estimateComputeUnitLimitMock,
      );
      const setComputeUnitLimitSpy = vi.spyOn(computeBudget, "getSetComputeUnitLimitInstruction");

      // Act
      await createAndSignPayment(clientSigner, 1, paymentRequirements);

      // Assert
      expect(estimateComputeUnitLimitMock).toHaveBeenCalledOnce();
      expect(setComputeUnitLimitSpy).toHaveBeenCalledWith({ units: 200000 });
    });
  });

  describe("getComputeUnitPrice", () => {
    it("should return default price of 1 microlamport", async () => {
      // Arrange
      vi.spyOn(solanaKit, "partiallySignTransactionMessageWithSigners").mockResolvedValue(
        "signed_tx_message" as any,
      );
      const computePriceSpy = vi.spyOn(computeBudget, "setTransactionMessageComputeUnitPrice");

      // Act
      await createAndSignPayment(clientSigner, 1, paymentRequirements);

      // Assert
      expect(computePriceSpy).toHaveBeenCalledWith(1, expect.any(Object));
    });
  });

  describe("Custom RPC Configuration", () => {
    it("should use custom RPC URL from config for devnet", async () => {
      // Arrange
      const customRpcUrl = "http://localhost:8899";
      const config = { svmConfig: { rpcUrl: customRpcUrl } };
      const getRpcClientSpy = vi.spyOn(rpc, "getRpcClient");

      // Act
      await createAndSignPayment(clientSigner, 1, paymentRequirements, config);

      // Assert
      expect(getRpcClientSpy).toHaveBeenCalledWith("solana-devnet", customRpcUrl);
    });

    it("should use custom RPC URL from config for mainnet", async () => {
      // Arrange
      const customRpcUrl = "https://custom-mainnet.com";
      const config = { svmConfig: { rpcUrl: customRpcUrl } };
      const mainnetRequirements = { ...paymentRequirements, network: "solana" as const };
      const getRpcClientSpy = vi.spyOn(rpc, "getRpcClient");

      // Act
      await createAndSignPayment(clientSigner, 1, mainnetRequirements, config);

      // Assert
      expect(getRpcClientSpy).toHaveBeenCalledWith("solana", customRpcUrl);
    });

    it("should use default RPC when config is undefined", async () => {
      // Arrange
      const getRpcClientSpy = vi.spyOn(rpc, "getRpcClient");

      // Act
      await createAndSignPayment(clientSigner, 1, paymentRequirements, undefined);

      // Assert
      expect(getRpcClientSpy).toHaveBeenCalledWith("solana-devnet", undefined);
    });

    it("should use default RPC when svmConfig is undefined", async () => {
      // Arrange
      const config = {}; // Empty config object
      const getRpcClientSpy = vi.spyOn(rpc, "getRpcClient");

      // Act
      await createAndSignPayment(clientSigner, 1, paymentRequirements, config);

      // Assert
      expect(getRpcClientSpy).toHaveBeenCalledWith("solana-devnet", undefined);
    });

    it("should propagate config through createPaymentHeader → createAndSignPayment", async () => {
      // Arrange
      const customRpcUrl = "http://localhost:8899";
      const config = { svmConfig: { rpcUrl: customRpcUrl } };
      const getRpcClientSpy = vi.spyOn(rpc, "getRpcClient");
      vi.mocked(paymentUtils.encodePayment).mockReturnValue("encoded_header");

      // Act
      await createPaymentHeader(clientSigner, 1, paymentRequirements, config);

      // Assert - verify config was passed all the way through
      expect(getRpcClientSpy).toHaveBeenCalledWith("solana-devnet", customRpcUrl);
      expect(paymentUtils.encodePayment).toHaveBeenCalled();
    });
  });
});
