/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifySchemesAndNetworks,
  getValidatedTransferCheckedInstruction,
  verifyTransferCheckedInstruction,
  verify,
  verifyTransactionInstructions,
  verifyComputeLimitInstruction,
  verifyComputePriceInstruction,
} from "./verify";
import {
  type TransactionSigner,
  assertIsInstructionWithData,
  assertIsInstructionWithAccounts,
  decompileTransactionMessage,
  fetchEncodedAccounts,
  ProgramDerivedAddressBump,
  generateKeyPairSigner,
} from "@solana/kit";
import { PaymentPayload, PaymentRequirements, ExactSvmPayload } from "../../../../types/verify";
import { Network } from "../../../../types";
import { SCHEME } from "../../";
import * as SvmShared from "../../../../shared/svm";
import * as rpc from "../../../../shared/svm/rpc";
import {
  TOKEN_PROGRAM_ADDRESS,
  TokenInstruction,
  identifyTokenInstruction,
  parseTransferCheckedInstruction as parseTransferCheckedInstructionToken,
} from "@solana-program/token";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  Token2022Instruction,
  identifyToken2022Instruction,
  parseTransferCheckedInstruction as parseTransferCheckedInstruction2022,
  findAssociatedTokenPda,
} from "@solana-program/token-2022";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import {
  parseSetComputeUnitLimitInstruction,
  parseSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";

vi.mock("@solana/kit", async () => {
  const actual = await vi.importActual("@solana/kit");
  return {
    ...actual,
    getBase64Encoder: vi.fn(),
    getTransactionDecoder: vi.fn(),
    assertIsInstructionWithData: vi.fn(),
    assertIsInstructionWithAccounts: vi.fn(),
    getCompiledTransactionMessageDecoder: vi.fn().mockReturnValue({ decode: vi.fn() }),
    decompileTransactionMessage: vi.fn(),
    fetchEncodedAccounts: vi.fn(),
  };
});

vi.mock("@solana-program/token", async () => {
  const actual = await vi.importActual("@solana-program/token");
  return {
    ...actual,
    identifyTokenInstruction: vi.fn(),
    parseTransferCheckedInstruction: vi.fn(),
  };
});

vi.mock("@solana-program/token-2022", async () => {
  const actual = await vi.importActual("@solana-program/token-2022");
  return {
    ...actual,
    identifyToken2022Instruction: vi.fn(),
    parseTransferCheckedInstruction: vi.fn(),
    findAssociatedTokenPda: vi.fn(),
  };
});

vi.mock("@solana-program/compute-budget", async () => {
  const actual = await vi.importActual("@solana-program/compute-budget");
  return {
    ...actual,
    parseSetComputeUnitLimitInstruction: vi.fn(),
    parseSetComputeUnitPriceInstruction: vi.fn(),
  };
});

vi.mock("../../../../shared/svm", async () => {
  const actual = await vi.importActual("../../../../shared/svm");
  return {
    ...actual,
    decodeTransactionFromPayload: vi.fn(),
    signAndSimulateTransaction: vi.fn(),
    getTokenPayerFromTransaction: vi.fn(),
  };
});

vi.mock("../../../../shared/svm/rpc", async () => {
  const actual = await vi.importActual("../../../../shared/svm/rpc");
  return {
    ...actual,
    getRpcClient: vi.fn(),
  };
});

const devnetUSDCAddress = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

describe("verify", () => {
  describe("verifySchemesAndNetworks", () => {
    const validPayload: PaymentPayload = {
      scheme: SCHEME,
      network: "solana-devnet",
      x402Version: 1,
      payload: {
        transaction: "valid_transaction_string",
      } as ExactSvmPayload,
    };

    const validRequirements: PaymentRequirements = {
      scheme: SCHEME,
      network: "solana-devnet",
      payTo: "someAddress",
      maxAmountRequired: "1000",
      resource: "resource",
      description: "description",
      mimeType: "mimeType",
      maxTimeoutSeconds: 60,
      asset: "USDC",
    };

    it("should not throw an error for valid schemes and networks", () => {
      expect(() => verifySchemesAndNetworks(validPayload, validRequirements)).not.toThrow();
    });

    it("should throw an error for unsupported scheme in payload", () => {
      const invalidPayload = { ...validPayload, scheme: "unsupported" as "exact" };
      expect(() => verifySchemesAndNetworks(invalidPayload, validRequirements)).toThrow(
        "unsupported_scheme",
      );
    });

    it("should throw an error for unsupported scheme in requirements", () => {
      const invalidRequirements = { ...validRequirements, scheme: "unsupported" as "exact" };
      expect(() => verifySchemesAndNetworks(validPayload, invalidRequirements)).toThrow(
        "unsupported_scheme",
      );
    });

    it("should throw an error for mismatched networks", () => {
      const invalidPayload = { ...validPayload, network: "solana" as Network };
      expect(() => verifySchemesAndNetworks(invalidPayload, validRequirements)).toThrow(
        "invalid_network",
      );
    });

    it("should throw an error for unsupported network in requirements", () => {
      const invalidRequirements = {
        ...validRequirements,
        network: "unsupported-network" as Network,
      };
      const invalidPayload = {
        ...validPayload,
        network: "unsupported-network" as Network,
      };
      expect(() => verifySchemesAndNetworks(invalidPayload, invalidRequirements)).toThrow(
        "invalid_network",
      );
    });
  });

  describe("getValidatedTransferCheckedInstruction", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(assertIsInstructionWithData).mockReturnValue(undefined);
      vi.mocked(assertIsInstructionWithAccounts).mockReturnValue(undefined);
    });

    it("should throw an error if instruction validation fails for data", () => {
      const mockInstruction = {};
      vi.mocked(assertIsInstructionWithData).mockImplementation(() => {
        throw new Error("Invalid instruction data");
      });
      expect(() => getValidatedTransferCheckedInstruction(mockInstruction as any)).toThrow(
        "invalid_exact_svm_payload_transaction_instructions",
      );
    });

    it("should throw an error if instruction validation fails for accounts", () => {
      const mockInstruction = {};
      vi.mocked(assertIsInstructionWithAccounts).mockImplementation(() => {
        throw new Error("Invalid instruction accounts");
      });
      expect(() => getValidatedTransferCheckedInstruction(mockInstruction as any)).toThrow(
        "invalid_exact_svm_payload_transaction_instructions",
      );
    });

    it("should throw an error for a non-transfer instruction", () => {
      const mockInstruction = { programAddress: { toString: () => "some_other_program" } };

      expect(() => getValidatedTransferCheckedInstruction(mockInstruction as any)).toThrow(
        "invalid_exact_svm_payload_transaction_not_a_transfer_instruction",
      );
    });

    it("should throw if spl-token instruction is not TransferChecked", () => {
      const mockInstruction = {
        programAddress: { toString: () => TOKEN_PROGRAM_ADDRESS.toString() },
        data: new Uint8Array(),
      };
      vi.mocked(identifyTokenInstruction).mockReturnValue("some_other_instruction" as any);

      expect(() => getValidatedTransferCheckedInstruction(mockInstruction as any)).toThrow(
        "invalid_exact_svm_payload_transaction_instruction_not_spl_token_transfer_checked",
      );
    });

    it("should throw if token-2022 instruction is not TransferChecked", () => {
      const mockInstruction = {
        programAddress: { toString: () => TOKEN_2022_PROGRAM_ADDRESS.toString() },
        data: new Uint8Array(),
      };
      vi.mocked(identifyToken2022Instruction).mockReturnValue("some_other_instruction" as any);

      expect(() => getValidatedTransferCheckedInstruction(mockInstruction as any)).toThrow(
        "invalid_exact_svm_payload_transaction_instruction_not_token_2022_transfer_checked",
      );
    });

    it("should return a valid tokenInstruction for a spl-token transfer", () => {
      const mockInstruction = {
        programAddress: { toString: () => TOKEN_PROGRAM_ADDRESS.toString() },
        data: new Uint8Array(),
      };
      const mockParsedInstruction = { instruction: "parsed" };
      vi.mocked(identifyTokenInstruction).mockReturnValue(TokenInstruction.TransferChecked);
      vi.mocked(parseTransferCheckedInstructionToken).mockReturnValue(mockParsedInstruction as any);

      const result = getValidatedTransferCheckedInstruction(mockInstruction as any);

      expect(result).toEqual(mockParsedInstruction);
      expect(parseTransferCheckedInstructionToken).toHaveBeenCalledWith({
        ...mockInstruction,
        data: new Uint8Array(mockInstruction.data),
      });
    });

    it("should return a valid tokenInstruction for a token-2022 transfer", () => {
      const mockInstruction = {
        programAddress: { toString: () => TOKEN_2022_PROGRAM_ADDRESS.toString() },
        data: new Uint8Array(),
      };
      const mockParsedInstruction = { instruction: "parsed" };
      vi.mocked(identifyToken2022Instruction).mockReturnValue(Token2022Instruction.TransferChecked);
      vi.mocked(parseTransferCheckedInstruction2022).mockReturnValue(mockParsedInstruction as any);

      const result = getValidatedTransferCheckedInstruction(mockInstruction as any);

      expect(result).toEqual(mockParsedInstruction);
      expect(parseTransferCheckedInstruction2022).toHaveBeenCalledWith({
        ...mockInstruction,
        data: new Uint8Array(mockInstruction.data),
      });
    });
  });

  describe("verifyTransferCheckedInstruction", () => {
    let mockTokenInstruction: any;
    let mockPaymentRequirements: PaymentRequirements;
    let mockRpc: any;
    let mockSigner: TransactionSigner;

    beforeEach(() => {
      vi.clearAllMocks();
      mockSigner = {
        address: "FeePayer111111111111111111111111111111111" as any,
        signTransactions: vi.fn(),
      } as TransactionSigner;
      mockTokenInstruction = {
        programAddress: { toString: () => TOKEN_2022_PROGRAM_ADDRESS.toString() },
        accounts: {
          mint: { address: "mintAddress" },
          destination: { address: "destinationAta" },
          source: { address: "sourceAta" },
          authority: { address: "authorityAddress" },
        },
        data: {
          amount: 1000n,
        },
      };
      mockPaymentRequirements = {
        scheme: SCHEME,
        network: "solana-devnet",
        payTo: "payToAddress",
        maxAmountRequired: "1000",
        resource: "resource",
        description: "description",
        mimeType: "mimeType",
        maxTimeoutSeconds: 60,
        asset: devnetUSDCAddress,
      };
      mockRpc = {}; // Mock rpc object

      vi.mocked(findAssociatedTokenPda).mockResolvedValue(["destinationAta"] as any);
      vi.mocked(rpc.getRpcClient).mockReturnValue(mockRpc);
      vi.mocked(fetchEncodedAccounts).mockResolvedValue([
        { address: "sourceAta", exists: true },
        { address: "destinationAta", exists: true },
      ] as any);
    });

    it("should not throw for valid transfer details", async () => {
      await expect(
        verifyTransferCheckedInstruction(
          mockTokenInstruction,
          mockPaymentRequirements,
          mockSigner,
          mockRpc,
        ),
      ).resolves.not.toThrow();
    });

    it("should throw for incorrect destination ATA", async () => {
      vi.mocked(findAssociatedTokenPda).mockResolvedValue(["incorrectAta"] as any);
      await expect(
        verifyTransferCheckedInstruction(
          mockTokenInstruction,
          mockPaymentRequirements,
          mockSigner,
          mockRpc,
        ),
      ).rejects.toThrow("invalid_exact_svm_payload_transaction_transfer_to_incorrect_ata");
    });

    it("should throw if receiver ATA is not found", async () => {
      vi.mocked(fetchEncodedAccounts).mockResolvedValue([
        { address: "sourceAta", exists: true },
        { address: "destinationAta", exists: false },
      ] as any);
      await expect(
        verifyTransferCheckedInstruction(
          mockTokenInstruction,
          mockPaymentRequirements,
          mockSigner,
          mockRpc,
        ),
      ).rejects.toThrow("invalid_exact_svm_payload_transaction_receiver_ata_not_found");
    });

    it("should throw if sender ATA is not found", async () => {
      vi.mocked(fetchEncodedAccounts).mockResolvedValue([
        { address: "sourceAta", exists: false },
        { address: "destinationAta", exists: true },
      ] as any);
      await expect(
        verifyTransferCheckedInstruction(
          mockTokenInstruction,
          mockPaymentRequirements,
          mockSigner,
          mockRpc,
        ),
      ).rejects.toThrow("invalid_exact_svm_payload_transaction_sender_ata_not_found");
    });

    it("should throw for amount mismatch", async () => {
      mockPaymentRequirements.maxAmountRequired = "1001";
      await expect(
        verifyTransferCheckedInstruction(
          mockTokenInstruction,
          mockPaymentRequirements,
          mockSigner,
          mockRpc,
        ),
      ).rejects.toThrow("invalid_exact_svm_payload_transaction_amount_mismatch");
    });

    it("should throw an error if the fee payer is the transfer authority", async () => {
      mockTokenInstruction.accounts.authority.address = mockSigner.address;

      await expect(
        verifyTransferCheckedInstruction(
          mockTokenInstruction,
          mockPaymentRequirements,
          mockSigner,
          mockRpc,
        ),
      ).rejects.toThrow("invalid_exact_svm_payload_transaction_fee_payer_transferring_funds");
    });

    it("should not throw if authority is different from fee payer", async () => {
      mockTokenInstruction.accounts.authority.address = "DifferentAuthority111111111111111111111";

      await expect(
        verifyTransferCheckedInstruction(
          mockTokenInstruction,
          mockPaymentRequirements,
          mockSigner,
          mockRpc,
        ),
      ).resolves.not.toThrow();
    });
  });

  describe("verify high level flow", () => {
    let mockSigner: TransactionSigner;
    let mockPayerAddress: string;
    let mockPayload: PaymentPayload;
    let mockRequirements: PaymentRequirements;
    let mockComputeLimitInstruction: any;
    let mockComputePriceInstruction: any;
    let mockTransferInstruction: any;

    beforeEach(async () => {
      vi.clearAllMocks();

      mockSigner = {} as any;
      mockPayerAddress = (await generateKeyPairSigner()).address;
      mockPayload = {
        scheme: SCHEME,
        network: "solana-devnet",
        x402Version: 1,
        payload: { transaction: "..." } as ExactSvmPayload,
      };
      mockRequirements = {
        scheme: SCHEME,
        network: "solana-devnet",
        payTo: "payToAddress",
        maxAmountRequired: "1000",
        asset: devnetUSDCAddress,
      } as any;
      mockComputeLimitInstruction = {
        programAddress: { toString: () => COMPUTE_BUDGET_PROGRAM_ADDRESS.toString() },
        data: new Uint8Array([2, 100, 25, 0, 0]),
      };
      mockComputePriceInstruction = {
        programAddress: { toString: () => COMPUTE_BUDGET_PROGRAM_ADDRESS.toString() },
        data: new Uint8Array([3, 1, 0, 0, 0, 0, 0, 0, 0]),
      };
      mockTransferInstruction = {
        programAddress: { toString: () => TOKEN_2022_PROGRAM_ADDRESS.toString() },
        data: new Uint8Array([TokenInstruction.TransferChecked, 1, 2, 3, 4, 5, 6, 7, 8, 1, 1]), // needs to be valid transfer checked data
        accounts: [
          { address: "sourceAta" },
          { address: "mintAddress" },
          { address: "destinationAta" },
          { address: "authorityAddress" },
        ],
      };

      // mocks for happy path
      vi.mocked(SvmShared.decodeTransactionFromPayload).mockReturnValue({
        signatures: {},
        messageBytes: new Uint8Array(),
      } as any);
      vi.mocked(rpc.getRpcClient).mockReturnValue({} as any);
      vi.mocked(decompileTransactionMessage).mockReturnValue({
        instructions: [
          mockComputeLimitInstruction,
          mockComputePriceInstruction,
          mockTransferInstruction,
        ],
      } as any);
      vi.mocked(parseSetComputeUnitPriceInstruction).mockReturnValue({
        data: {
          discriminator: 3,
          microLamports: 1n,
        },
      } as any);
      vi.mocked(SvmShared.signAndSimulateTransaction).mockResolvedValue({
        value: { err: null },
      } as any);
      vi.mocked(findAssociatedTokenPda).mockResolvedValue(["destinationAta"] as any);
      vi.mocked(fetchEncodedAccounts).mockResolvedValue([
        { address: "sourceAta", exists: true },
        { address: "destinationAta", exists: true },
      ] as any);
      vi.mocked(parseTransferCheckedInstruction2022).mockReturnValue({
        programAddress: { toString: () => TOKEN_2022_PROGRAM_ADDRESS.toString() },
        accounts: {
          mint: { address: "mintAddress" },
          destination: { address: "destinationAta" },
          source: { address: "sourceAta" },
          authority: { address: "authorityAddress" },
        },
        data: {
          amount: 1000n,
        },
      } as any);
      vi.mocked(identifyToken2022Instruction).mockReturnValue(Token2022Instruction.TransferChecked);
      vi.mocked(SvmShared.getTokenPayerFromTransaction).mockReturnValue(mockPayerAddress);
    });

    it("should return isValid: true for a valid transaction", async () => {
      const result = await verify(mockSigner, mockPayload, mockRequirements);
      expect(result.isValid).toBe(true);
      expect(result.payer).toBe(mockPayerAddress);
    });

    it("should return isValid: false if schemes or networks are invalid", async () => {
      const invalidPayload = { ...mockPayload, scheme: "invalid" as "exact" };
      const result = await verify(mockSigner, invalidPayload, mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("unsupported_scheme");
    });

    it("should return isValid: false if transaction decoding fails", async () => {
      const error = new Error("invalid_exact_svm_payload_transaction");
      vi.mocked(SvmShared.decodeTransactionFromPayload).mockImplementation(() => {
        throw error;
      });
      const result = await verify(mockSigner, mockPayload, mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_svm_payload_transaction");
    });

    it("should return isValid: false if instruction validation fails", async () => {
      vi.mocked(decompileTransactionMessage).mockReturnValue({
        instructions: [mockTransferInstruction, mockTransferInstruction],
      } as any);
      const result = await verify(mockSigner, mockPayload, mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(
        "invalid_exact_svm_payload_transaction_instructions_length",
      );
    });

    it("should return isValid: false if transfer details verification fails", async () => {
      vi.mocked(findAssociatedTokenPda).mockResolvedValue(["incorrectAta"] as any);
      const result = await verify(mockSigner, mockPayload, mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(
        "invalid_exact_svm_payload_transaction_transfer_to_incorrect_ata",
      );
    });

    it("should return isValid: false if simulation fails", async () => {
      vi.mocked(SvmShared.signAndSimulateTransaction).mockResolvedValue({
        value: { err: "simulation_error" },
      } as any);
      const result = await verify(mockSigner, mockPayload, mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_svm_payload_transaction_simulation_failed");
    });
  });

  describe("verifyTransactionInstructions", () => {
    let mockTransactionMessage: any;
    let mockPaymentRequirements: PaymentRequirements;
    let mockComputeLimitInstruction: any;
    let mockComputePriceInstruction: any;
    let mockTransferInstruction: any;
    let mockRpc: any;
    let mockSigner: TransactionSigner;

    beforeEach(() => {
      vi.clearAllMocks();

      mockPaymentRequirements = {
        scheme: SCHEME,
        network: "solana-devnet",
        payTo: "payToAddress",
        maxAmountRequired: "1000",
        asset: devnetUSDCAddress,
      } as any;
      mockRpc = {};
      mockSigner = {
        address: "FeePayer111111111111111111111111111111111" as any,
        signTransactions: vi.fn(),
      } as TransactionSigner;
      mockComputeLimitInstruction = {
        programAddress: { toString: () => COMPUTE_BUDGET_PROGRAM_ADDRESS.toString() },
        data: new Uint8Array([2, 100, 25, 0, 0]),
      };
      mockComputePriceInstruction = {
        programAddress: { toString: () => COMPUTE_BUDGET_PROGRAM_ADDRESS.toString() },
        data: new Uint8Array([3, 1, 0, 0, 0, 0, 0, 0, 0]),
      };
      mockTransferInstruction = {
        programAddress: { toString: () => TOKEN_2022_PROGRAM_ADDRESS.toString() },
        data: new Uint8Array([3, 1, 2, 3, 4, 5, 6, 7, 8, 1, 1]), // TransferChecked is 3
        accounts: [
          { address: devnetUSDCAddress },
          { address: "destinationAta" },
          { address: "sourceAta" },
          { address: "authorityAddress" },
        ],
      };
      vi.mocked(parseTransferCheckedInstruction2022).mockReturnValue({
        programAddress: { toString: () => TOKEN_2022_PROGRAM_ADDRESS.toString() },
        accounts: {
          mint: { address: devnetUSDCAddress },
          destination: { address: "destinationAta" },
          source: { address: "sourceAta" },
          authority: { address: "authorityAddress" },
        },
        data: { amount: 1000n },
      } as any);
      vi.mocked(identifyToken2022Instruction).mockReturnValue(Token2022Instruction.TransferChecked);
      vi.mocked(findAssociatedTokenPda).mockResolvedValue(["destinationAta"] as any);
      vi.mocked(fetchEncodedAccounts).mockResolvedValue([
        { address: "sourceAta", exists: true },
        { address: "destinationAta", exists: true },
      ] as any);
      vi.mocked(rpc.getRpcClient).mockReturnValue({} as any);
      // no create ATA parsing anymore
    });

    it("should throw an error if the transaction has less than 3 instructions", async () => {
      mockTransactionMessage = {
        instructions: [mockComputeLimitInstruction, mockComputePriceInstruction],
      };

      await expect(
        verifyTransactionInstructions(
          mockTransactionMessage,
          mockPaymentRequirements,
          mockSigner,
          mockRpc,
        ),
      ).rejects.toThrow("invalid_exact_svm_payload_transaction_instructions_length");
    });

    it("should throw an error if the transaction has more than 3 instructions", async () => {
      mockTransactionMessage = {
        instructions: [
          mockComputeLimitInstruction,
          mockComputePriceInstruction,
          mockTransferInstruction,
          mockTransferInstruction,
        ],
      };

      await expect(
        verifyTransactionInstructions(
          mockTransactionMessage,
          mockPaymentRequirements,
          mockSigner,
          mockRpc,
        ),
      ).rejects.toThrow("invalid_exact_svm_payload_transaction_instructions_length");
    });

    it("should throw an error if the tx has 3 instructions and the destination ATA does not exist", async () => {
      mockTransactionMessage = {
        instructions: [
          mockComputeLimitInstruction,
          mockComputePriceInstruction,
          mockTransferInstruction,
        ],
      };

      vi.mocked(fetchEncodedAccounts).mockResolvedValue([
        { address: "sourceAta", exists: true },
        { address: "destinationAta", exists: false },
      ] as any);

      await expect(
        verifyTransactionInstructions(
          mockTransactionMessage,
          mockPaymentRequirements,
          mockSigner,
          mockRpc,
        ),
      ).rejects.toThrow("invalid_exact_svm_payload_transaction_receiver_ata_not_found");
    });

    it("should throw an error if the fee payer address appears in any instruction's accounts", async () => {
      const instructionWithFeePayer = {
        programAddress: { toString: () => TOKEN_2022_PROGRAM_ADDRESS.toString() },
        data: new Uint8Array([3, 1, 2, 3, 4, 5, 6, 7, 8, 1, 1]),
        accounts: [
          { address: "someOtherAddress" },
          { address: mockSigner.address },
          { address: "yetAnotherAddress" },
        ],
      };

      mockTransactionMessage = {
        instructions: [
          mockComputeLimitInstruction,
          mockComputePriceInstruction,
          instructionWithFeePayer,
        ],
      };

      await expect(
        verifyTransactionInstructions(
          mockTransactionMessage,
          mockPaymentRequirements,
          mockSigner,
          mockRpc,
        ),
      ).rejects.toThrow(
        "invalid_exact_svm_payload_transaction_fee_payer_included_in_instruction_accounts",
      );
    });

    it("should throw an error if the fee payer is in the compute limit instruction accounts", async () => {
      const instructionWithFeePayer = {
        ...mockComputeLimitInstruction,
        accounts: [{ address: mockSigner.address }],
      };

      mockTransactionMessage = {
        instructions: [
          instructionWithFeePayer,
          mockComputePriceInstruction,
          mockTransferInstruction,
        ],
      };

      await expect(
        verifyTransactionInstructions(
          mockTransactionMessage,
          mockPaymentRequirements,
          mockSigner,
          mockRpc,
        ),
      ).rejects.toThrow(
        "invalid_exact_svm_payload_transaction_fee_payer_included_in_instruction_accounts",
      );
    });

    it("should throw an error if the fee payer is in the compute price instruction accounts", async () => {
      const instructionWithFeePayer = {
        ...mockComputePriceInstruction,
        accounts: [{ address: mockSigner.address }],
      };

      mockTransactionMessage = {
        instructions: [
          mockComputeLimitInstruction,
          instructionWithFeePayer,
          mockTransferInstruction,
        ],
      };

      await expect(
        verifyTransactionInstructions(
          mockTransactionMessage,
          mockPaymentRequirements,
          mockSigner,
          mockRpc,
        ),
      ).rejects.toThrow(
        "invalid_exact_svm_payload_transaction_fee_payer_included_in_instruction_accounts",
      );
    });

    it("should throw an error if the fee payer is the transfer source", async () => {
      const transferWithFeePayerSource = {
        ...mockTransferInstruction,
        accounts: [
          { address: mockSigner.address },
          { address: devnetUSDCAddress },
          { address: "destinationAta" },
          { address: "authorityAddress" },
        ],
      };

      mockTransactionMessage = {
        instructions: [
          mockComputeLimitInstruction,
          mockComputePriceInstruction,
          transferWithFeePayerSource,
        ],
      };

      await expect(
        verifyTransactionInstructions(
          mockTransactionMessage,
          mockPaymentRequirements,
          mockSigner,
          mockRpc,
        ),
      ).rejects.toThrow(
        "invalid_exact_svm_payload_transaction_fee_payer_included_in_instruction_accounts",
      );
    });
  });

  describe("verifyComputeLimitInstruction", () => {
    let mockInstruction: any;

    beforeEach(() => {
      vi.clearAllMocks();
      mockInstruction = {
        programAddress: { toString: () => COMPUTE_BUDGET_PROGRAM_ADDRESS.toString() },
        data: new Uint8Array([2, 100, 25, 0, 0]),
      };
      vi.mocked(parseSetComputeUnitLimitInstruction).mockReturnValue({} as any);
    });

    it("should not throw for a valid compute limit instruction", () => {
      expect(() => verifyComputeLimitInstruction(mockInstruction)).not.toThrow();
    });

    it("should throw if the program address is incorrect", () => {
      mockInstruction.programAddress = { toString: () => "incorrect_program_address" };
      expect(() => verifyComputeLimitInstruction(mockInstruction)).toThrow(
        "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction",
      );
    });

    it("should throw if the instruction discriminator is incorrect", () => {
      mockInstruction.data = new Uint8Array([99, 100, 25, 0, 0]);
      expect(() => verifyComputeLimitInstruction(mockInstruction)).toThrow(
        "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction",
      );
    });

    it("should throw if parseSetComputeUnitLimitInstruction throws", () => {
      vi.mocked(parseSetComputeUnitLimitInstruction).mockImplementation(() => {
        throw new Error("parsing failed");
      });
      expect(() => verifyComputeLimitInstruction(mockInstruction)).toThrow(
        "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction",
      );
    });
  });

  describe("verifyComputePriceInstruction", () => {
    let mockInstruction: any;

    beforeEach(() => {
      vi.clearAllMocks();
      mockInstruction = {
        programAddress: { toString: () => COMPUTE_BUDGET_PROGRAM_ADDRESS.toString() },
        data: new Uint8Array([3, 1, 0, 0, 0, 0, 0, 0, 0]),
      };
      vi.mocked(parseSetComputeUnitPriceInstruction).mockReturnValue({
        data: {
          discriminator: 3,
          microLamports: 1n,
        },
      } as any);
    });

    it("should not throw for a valid compute price instruction", () => {
      expect(() => verifyComputePriceInstruction(mockInstruction)).not.toThrow();
    });

    it("should throw if the program address is incorrect", () => {
      mockInstruction.programAddress = { toString: () => "incorrect_program_address" };
      expect(() => verifyComputePriceInstruction(mockInstruction)).toThrow(
        "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction",
      );
    });

    it("should throw if the instruction discriminator is incorrect", () => {
      mockInstruction.data = new Uint8Array([99, 0, 0, 0, 0, 0, 0, 0, 0]);
      expect(() => verifyComputePriceInstruction(mockInstruction)).toThrow(
        "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction",
      );
    });

    it("should throw if parseSetComputeUnitPriceInstruction throws", () => {
      vi.mocked(parseSetComputeUnitPriceInstruction).mockImplementation(() => {
        throw new Error("parsing failed");
      });
      expect(() => verifyComputePriceInstruction(mockInstruction)).toThrow("parsing failed");
    });

    it("should throw if the compute unit price is greater than 5 lamports", () => {
      // Arrange
      vi.mocked(parseSetComputeUnitPriceInstruction).mockReturnValue({
        data: {
          discriminator: 3,
          microLamports: 5_000_001n,
        },
      } as any);

      // Act & Assert
      expect(() => verifyComputePriceInstruction(mockInstruction)).toThrow(
        "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high",
      );
    });
  });

  describe("Custom RPC Configuration", () => {
    const mockPaymentRequirements: PaymentRequirements = {
      scheme: SCHEME,
      network: "solana-devnet" as Network,
      payTo: "TestRecipient111111111111111111111111111" as any,
      asset: "TestToken1111111111111111111111111111111" as any,
      maxAmountRequired: "1000000",
      resource: "http://example.com/resource",
      description: "Test payment",
      mimeType: "application/json",
      maxTimeoutSeconds: 300,
    };

    const mockPayload: PaymentPayload = {
      scheme: SCHEME,
      network: "solana-devnet" as Network,
      x402Version: 1,
      payload: {
        transaction: "base64encodedtransaction",
      } as ExactSvmPayload,
    };

    const mockSigner = {
      address: "TestSigner1111111111111111111111111111" as any,
      signTransactions: vi.fn().mockResolvedValue([{}] as any),
    } as TransactionSigner;

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should use custom RPC URL from config during verification", async () => {
      // Arrange
      const customRpcUrl = "http://localhost:8899";
      const config = { svmConfig: { rpcUrl: customRpcUrl } };

      const mockRpcClient = {
        getLatestBlockhash: vi.fn().mockReturnValue({
          send: vi.fn().mockResolvedValue({
            value: { blockhash: "test", lastValidBlockHeight: 100 },
          }),
        }),
      };

      vi.spyOn(rpc, "getRpcClient").mockReturnValue(mockRpcClient as any);
      vi.spyOn(SvmShared, "decodeTransactionFromPayload").mockReturnValue({
        messageBytes: new Uint8Array(),
        signatures: [],
      } as any);
      vi.spyOn(SvmShared, "signAndSimulateTransaction").mockResolvedValue({
        value: { err: null },
      } as any);

      vi.mocked(decompileTransactionMessage).mockReturnValue({
        instructions: [
          {
            programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
            data: new Uint8Array([2, 0, 0, 0, 232, 3, 0, 0]),
          } as any,
          {
            programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
            data: new Uint8Array([3, 1, 0, 0, 0, 0, 0, 0, 0]),
          } as any,
          {
            programAddress: TOKEN_PROGRAM_ADDRESS,
            data: new Uint8Array([12]),
            accounts: [] as any,
          } as any,
        ],
      } as any);

      vi.mocked(identifyTokenInstruction).mockReturnValue(TokenInstruction.TransferChecked);
      vi.mocked(parseTransferCheckedInstructionToken).mockReturnValue({
        programAddress: TOKEN_PROGRAM_ADDRESS,
        accounts: {
          source: { address: "Source111111111111111111111111111111111" as any },
          destination: { address: "Dest11111111111111111111111111111111111" as any },
        },
        data: { amount: 1000000n },
      } as any);

      vi.mocked(findAssociatedTokenPda).mockResolvedValue([
        "Dest11111111111111111111111111111111111" as any,
        255 as ProgramDerivedAddressBump,
      ]);
      vi.mocked(fetchEncodedAccounts).mockResolvedValue([
        { exists: true, address: "Source111111111111111111111111111111111" as any },
        { exists: true, address: "Dest11111111111111111111111111111111111" as any },
      ] as any);

      // Act
      await verify(mockSigner, mockPayload, mockPaymentRequirements, config);

      // Assert
      expect(rpc.getRpcClient).toHaveBeenCalledWith("solana-devnet", customRpcUrl);
    });

    it("should use custom RPC URL during transaction introspection", async () => {
      // Arrange
      const customRpcUrl = "https://custom-mainnet.com";
      const config = { svmConfig: { rpcUrl: customRpcUrl } };
      const mainnetRequirements = { ...mockPaymentRequirements, network: "solana" as Network };
      const mainnetPayload = { ...mockPayload, network: "solana" as Network };

      const mockRpcClient = {
        getLatestBlockhash: vi.fn().mockReturnValue({
          send: vi.fn().mockResolvedValue({
            value: { blockhash: "test", lastValidBlockHeight: 100 },
          }),
        }),
      };

      vi.spyOn(rpc, "getRpcClient").mockReturnValue(mockRpcClient as any);
      vi.spyOn(SvmShared, "decodeTransactionFromPayload").mockReturnValue({
        messageBytes: new Uint8Array(),
        signatures: [],
      } as any);
      vi.spyOn(SvmShared, "signAndSimulateTransaction").mockResolvedValue({
        value: { err: null },
      } as any);

      vi.mocked(decompileTransactionMessage).mockReturnValue({
        instructions: [
          {
            programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
            data: new Uint8Array([2, 0, 0, 0, 232, 3, 0, 0]),
          } as any,
          {
            programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
            data: new Uint8Array([3, 1, 0, 0, 0, 0, 0, 0, 0]),
          } as any,
          {
            programAddress: TOKEN_PROGRAM_ADDRESS,
            data: new Uint8Array([12]),
            accounts: [] as any,
          } as any,
        ],
      } as any);

      vi.mocked(identifyTokenInstruction).mockReturnValue(TokenInstruction.TransferChecked);
      vi.mocked(parseTransferCheckedInstructionToken).mockReturnValue({
        programAddress: TOKEN_PROGRAM_ADDRESS,
        accounts: {
          source: { address: "Source111111111111111111111111111111111" as any },
          destination: { address: "Dest11111111111111111111111111111111111" as any },
        },
        data: { amount: 1000000n },
      } as any);

      vi.mocked(findAssociatedTokenPda).mockResolvedValue([
        "Dest11111111111111111111111111111111111" as any,
        255 as ProgramDerivedAddressBump,
      ]);
      vi.mocked(fetchEncodedAccounts).mockResolvedValue([
        { exists: true, address: "Source111111111111111111111111111111111" as any },
        { exists: true, address: "Dest11111111111111111111111111111111111" as any },
      ] as any);

      // Act
      await verify(mockSigner, mainnetPayload, mainnetRequirements, config);

      // Assert
      expect(rpc.getRpcClient).toHaveBeenCalledWith("solana", customRpcUrl);
    });

    it("should work without config (backward compatibility)", async () => {
      // Arrange
      const mockRpcClient = {
        getLatestBlockhash: vi.fn().mockReturnValue({
          send: vi.fn().mockResolvedValue({
            value: { blockhash: "test", lastValidBlockHeight: 100 },
          }),
        }),
      };

      vi.spyOn(rpc, "getRpcClient").mockReturnValue(mockRpcClient as any);
      vi.spyOn(SvmShared, "decodeTransactionFromPayload").mockReturnValue({
        messageBytes: new Uint8Array(),
        signatures: [],
      } as any);
      vi.spyOn(SvmShared, "signAndSimulateTransaction").mockResolvedValue({
        value: { err: null },
      } as any);

      vi.mocked(decompileTransactionMessage).mockReturnValue({
        instructions: [
          {
            programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
            data: new Uint8Array([2, 0, 0, 0, 232, 3, 0, 0]),
          } as any,
          {
            programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
            data: new Uint8Array([3, 1, 0, 0, 0, 0, 0, 0, 0]),
          } as any,
          {
            programAddress: TOKEN_PROGRAM_ADDRESS,
            data: new Uint8Array([12]),
            accounts: [] as any,
          } as any,
        ],
      } as any);

      vi.mocked(identifyTokenInstruction).mockReturnValue(TokenInstruction.TransferChecked);
      vi.mocked(parseTransferCheckedInstructionToken).mockReturnValue({
        programAddress: TOKEN_PROGRAM_ADDRESS,
        accounts: {
          source: { address: "Source111111111111111111111111111111111" as any },
          destination: { address: "Dest11111111111111111111111111111111111" as any },
        },
        data: { amount: 1000000n },
      } as any);

      vi.mocked(findAssociatedTokenPda).mockResolvedValue([
        "Dest11111111111111111111111111111111111" as any,
        255 as ProgramDerivedAddressBump,
      ]);
      vi.mocked(fetchEncodedAccounts).mockResolvedValue([
        { exists: true, address: "Source111111111111111111111111111111111" as any },
        { exists: true, address: "Dest11111111111111111111111111111111111" as any },
      ] as any);

      // Act
      await verify(mockSigner, mockPayload, mockPaymentRequirements);

      // Assert - should use defaults (undefined)
      expect(rpc.getRpcClient).toHaveBeenCalledWith("solana-devnet", undefined);
    });
  });
});
