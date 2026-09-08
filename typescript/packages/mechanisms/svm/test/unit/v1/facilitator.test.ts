import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import {
  generateKeyPairSigner,
  getBase64Codec,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  type Address,
} from "@solana/kit";
import { ExactSvmSchemeV1 } from "../../../src/exact/v1/facilitator/scheme";
import type { FacilitatorSvmSigner } from "../../../src/signer";
import type { PaymentRequirementsV1 } from "@x402/core/types/v1";
import type { PaymentPayloadV1 } from "@x402/core/types/v1";
import {
  LIGHTHOUSE_PROGRAM_ADDRESS,
  MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "../../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../../src/defaultAssets";
import * as svmUtils from "../../../src/utils";
import {
  buildExactPaymentTransaction,
  encodeSignedTransaction,
  placeholderFeePayerSignature,
  resignMutatedTransaction,
} from "../helpers/signedTransaction";

// Encodes a SetComputeUnitPrice instruction: discriminator(3) + microLamports as u64 LE
function makeComputePriceData(microLamports: bigint): Uint8Array {
  const buf = new ArrayBuffer(9);
  const view = new DataView(buf);
  view.setUint8(0, 3);
  view.setBigUint64(1, microLamports, true);
  return new Uint8Array(buf);
}

describe("ExactSvmSchemeV1", () => {
  let mockSigner: FacilitatorSvmSigner;

  beforeEach(() => {
    mockSigner = {
      address: "FacilitatorAddress1111111111111111111" as never,
      getAddresses: vi
        .fn()
        .mockReturnValue([
          "FeePayer1111111111111111111111111111",
          "FacilitatorAddress1111111111111111111",
        ]) as never,
      getSigner: vi.fn() as never,
      signTransactions: vi.fn() as never,
      signMessages: vi.fn().mockResolvedValue([
        {
          // Mock signature dictionary
          FacilitatorAddress1111111111111111111: new Uint8Array(64),
        },
      ]) as never,
      getRpcForNetwork: vi.fn().mockReturnValue({
        getBalance: vi.fn().mockResolvedValue(BigInt(10000000)),
        getLatestBlockhash: vi.fn().mockResolvedValue({
          value: {
            blockhash: "mockBlockhash",
            lastValidBlockHeight: BigInt(100000),
          },
        }),
        simulateTransaction: vi.fn().mockResolvedValue({
          value: { err: null },
        }),
        sendTransaction: vi.fn().mockResolvedValue("mockSignature123"),
        getSignatureStatuses: vi.fn().mockResolvedValue({
          value: [{ confirmationStatus: "confirmed" }],
        }),
      }) as never,
    };
  });

  describe("constructor", () => {
    it("should create instance with correct scheme", () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      expect(facilitator.scheme).toBe("exact");
    });
  });

  describe("getExtra / getSigners", () => {
    it("returns all managed fee payers from getSigners", () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      expect(facilitator.getSigners("solana-devnet")).toEqual([
        "FeePayer1111111111111111111111111111",
        "FacilitatorAddress1111111111111111111",
      ]);
    });

    it("selects a managed feePayer in getExtra", () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const extra = facilitator.getExtra("solana-devnet");
      expect(extra).toBeDefined();
      expect(mockSigner.getAddresses()).toContain(extra!.feePayer);
    });
  });

  describe("verify", () => {
    it("should reject if scheme does not match", async () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);

      const payload: PaymentPayloadV1 = {
        x402Version: 1,
        scheme: "wrong",
        network: "solana-devnet",
        payload: {
          transaction: "base64transaction==",
        },
      };

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "solana-devnet",
        asset: USDC_DEVNET_ADDRESS,
        maxAmountRequired: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: {
          feePayer: "FeePayer1111111111111111111111111111",
        },
      };

      const result = await facilitator.verify(payload as never, requirements as never);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("unsupported_scheme");
    });

    it("should reject if network does not match", async () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);

      const payload: PaymentPayloadV1 = {
        x402Version: 1,
        scheme: "exact",
        network: "solana-mainnet", // Wrong network
        payload: {
          transaction: "validbase64transaction==",
        },
      };

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "solana-devnet",
        asset: USDC_DEVNET_ADDRESS,
        maxAmountRequired: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: {
          feePayer: "FeePayer1111111111111111111111111111",
        },
      };

      const result = await facilitator.verify(payload as never, requirements as never);

      // Network check happens early in Step 1 (before transaction parsing)
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("network_mismatch");
    });

    it("should reject if feePayer is missing", async () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);

      const payload: PaymentPayloadV1 = {
        x402Version: 1,
        scheme: "exact",
        network: "solana-devnet",
        payload: {
          transaction: "base64transaction==",
        },
      };

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "solana-devnet",
        asset: USDC_DEVNET_ADDRESS,
        maxAmountRequired: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: {}, // Missing feePayer
      };

      const result = await facilitator.verify(payload as never, requirements as never);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_svm_payload_missing_fee_payer");
    });

    it("should reject if feePayer is not managed by this facilitator", async () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);

      const payload: PaymentPayloadV1 = {
        x402Version: 1,
        scheme: "exact",
        network: "solana-devnet",
        payload: {
          transaction: "base64transaction==",
        },
      };

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "solana-devnet",
        asset: USDC_DEVNET_ADDRESS,
        maxAmountRequired: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: {
          feePayer: "UnmanagedFeePayer111111111111111111111",
        },
      };

      const result = await facilitator.verify(payload as never, requirements as never);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("fee_payer_not_managed_by_facilitator");
    });

    it("should reject if transaction cannot be decoded", async () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);

      const payload: PaymentPayloadV1 = {
        x402Version: 1,
        scheme: "exact",
        network: "solana-devnet",
        payload: {
          transaction: "invalid!!!", // Invalid base64
        },
      };

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "solana-devnet",
        asset: USDC_DEVNET_ADDRESS,
        maxAmountRequired: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: {
          feePayer: "FeePayer1111111111111111111111111111",
        },
      };

      const result = await facilitator.verify(payload as never, requirements as never);

      expect(result.isValid).toBe(false);
      // Transaction decoding or instruction parsing fails
      expect(result.invalidReason).toContain("invalid_exact_svm_payload_transaction");
    });

    it("should reject address lookup table transactions with a clean invalid reason", async () => {
      const feePayer = await generateKeyPairSigner();
      const altAddr = await generateKeyPairSigner();
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
            accountIndices: [2],
            data: new Uint8Array([2, 0, 0, 0, 0]),
          },
        ],
        addressTableLookups: [
          {
            lookupTableAddress: altAddr.address,
            writableIndexes: [0],
            readonlyIndexes: [],
          },
        ],
      };

      const messageBytes = getCompiledTransactionMessageEncoder().encode(compiled);
      const transaction = await encodeSignedTransaction(
        messageBytes,
        [],
        placeholderFeePayerSignature(feePayer.address),
      );

      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: "PayToAddress11111111111111111111111111",
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(
        "invalid_exact_svm_payload_transaction_could_not_be_decoded",
      );
    });

    it("should reject a well-formed transfer whose client signature is forged", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const genuine = await buildExactPaymentTransaction({
        amount: 100000n,
        feePayer: feePayer.address,
        mint: USDC_DEVNET_ADDRESS as Address,
        payTo: payTo.address,
        payer,
      });
      const decoded = getTransactionDecoder().decode(getBase64Codec().encode(genuine));
      const transaction = await encodeSignedTransaction(decoded.messageBytes, [], {
        ...placeholderFeePayerSignature(feePayer.address),
        [payer.address]: new Uint8Array(64),
      });
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_svm_payload_signature_invalid");
    });

    it("should reject a well-formed transfer whose client signature is missing", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const genuine = await buildExactPaymentTransaction({
        amount: 100000n,
        feePayer: feePayer.address,
        mint: USDC_DEVNET_ADDRESS as Address,
        payTo: payTo.address,
        payer,
      });
      const decoded = getTransactionDecoder().decode(getBase64Codec().encode(genuine));
      const transaction = await encodeSignedTransaction(decoded.messageBytes, [], {
        ...placeholderFeePayerSignature(feePayer.address),
        [payer.address]: new Uint8Array(0),
      });
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_svm_payload_signature_invalid");
    });

    it("should reject a transaction with fewer than 3 instructions", async () => {
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
            data: new Uint8Array([2, 32, 78, 0, 0]),
          },
          {
            programAddressIndex: 1,
            accountIndices: [],
            data: makeComputePriceData(1n),
          },
        ],
      };
      const messageBytes = getCompiledTransactionMessageEncoder().encode(compiled);
      const transaction = await encodeSignedTransaction(
        messageBytes,
        [],
        placeholderFeePayerSignature(feePayer.address),
      );
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: "PayToAddress11111111111111111111111111",
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(
        "invalid_exact_svm_payload_transaction_instructions_length",
      );
    });

    it("should reject when the first instruction is not a compute limit", async () => {
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
            data: makeComputePriceData(1n),
          },
          {
            programAddressIndex: 1,
            accountIndices: [],
            data: makeComputePriceData(1n),
          },
          {
            programAddressIndex: 1,
            accountIndices: [],
            data: makeComputePriceData(1n),
          },
        ],
      };
      const messageBytes = getCompiledTransactionMessageEncoder().encode(compiled);
      const transaction = await encodeSignedTransaction(
        messageBytes,
        [],
        placeholderFeePayerSignature(feePayer.address),
      );
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: "PayToAddress11111111111111111111111111",
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(
        "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction",
      );
    });

    it("should reject when the third instruction is not a token transfer", async () => {
      const feePayer = await generateKeyPairSigner();
      const computeBudget = "ComputeBudget111111111111111111111111111111" as Address;
      const memo = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;
      const compiled = {
        version: 0 as const,
        header: {
          numSignerAccounts: 1,
          numReadonlySignerAccounts: 0,
          numReadonlyNonSignerAccounts: 2,
        },
        staticAccounts: [feePayer.address, computeBudget, memo],
        lifetimeToken: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
        instructions: [
          {
            programAddressIndex: 1,
            accountIndices: [],
            data: new Uint8Array([2, 32, 78, 0, 0]),
          },
          {
            programAddressIndex: 1,
            accountIndices: [],
            data: makeComputePriceData(1n),
          },
          {
            programAddressIndex: 2,
            accountIndices: [],
            data: new TextEncoder().encode("memo"),
          },
        ],
      };
      const messageBytes = getCompiledTransactionMessageEncoder().encode(compiled);
      const transaction = await encodeSignedTransaction(
        messageBytes,
        [],
        placeholderFeePayerSignature(feePayer.address),
      );
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: "PayToAddress11111111111111111111111111",
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_svm_payload_no_transfer_instruction");
    });

    it("should reject a mint mismatch on a well-formed TransferChecked", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const transaction = await buildExactPaymentTransaction({
        amount: 100000n,
        feePayer: feePayer.address,
        mint: USDC_DEVNET_ADDRESS as Address,
        payTo: payTo.address,
        payer,
      });
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      mockSigner.simulateTransaction = vi.fn().mockResolvedValue(undefined) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          maxAmountRequired: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_svm_payload_mint_mismatch");
    });

    it("should reject an amount mismatch on a well-formed TransferChecked", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const transaction = await buildExactPaymentTransaction({
        amount: 50n,
        feePayer: feePayer.address,
        mint: USDC_DEVNET_ADDRESS as Address,
        payTo: payTo.address,
        payer,
      });
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_svm_payload_amount_mismatch");
    });

    it("should reject when the facilitator would transfer its own tokens", async () => {
      const feePayer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const transaction = await buildExactPaymentTransaction({
        amount: 100000n,
        feePayer: feePayer.address,
        mint: USDC_DEVNET_ADDRESS as Address,
        payTo: payTo.address,
        payer: feePayer,
      });
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(
        "invalid_exact_svm_payload_transaction_fee_payer_transferring_funds",
      );
    });

    it("should reject a required memo that is missing or mismatched", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const transaction = await buildExactPaymentTransaction({
        amount: 100000n,
        feePayer: feePayer.address,
        memo: "actual-memo",
        mint: USDC_DEVNET_ADDRESS as Address,
        payTo: payTo.address,
        payer,
      });
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address, memo: "expected-memo" },
        } as never,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_svm_payload_memo_mismatch");
    });

    it("should reject when instruction 2 is not a token transfer", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const transaction = await resignMutatedTransaction(
        payer,
        await buildExactPaymentTransaction({
          amount: 100000n,
          feePayer: feePayer.address,
          mint: USDC_DEVNET_ADDRESS as Address,
          payTo: payTo.address,
          payer,
        }),
        compiled => {
          const transfer = compiled.instructions[2];
          const memo = compiled.instructions[3];
          if (transfer && memo) {
            compiled.instructions[2] = memo;
            compiled.instructions[3] = transfer;
          }
        },
      );
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_svm_payload_no_transfer_instruction");
    });

    it("should reject a TransferChecked whose accounts cannot be parsed", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const transaction = await resignMutatedTransaction(
        payer,
        await buildExactPaymentTransaction({
          amount: 100000n,
          feePayer: feePayer.address,
          mint: USDC_DEVNET_ADDRESS as Address,
          payTo: payTo.address,
          payer,
        }),
        compiled => {
          const transfer = compiled.instructions[2];
          if (!transfer?.accountIndices || transfer.accountIndices.length < 4) {
            throw new Error("expected TransferChecked with 4 accounts");
          }
          // Keep a well-formed TransferChecked elsewhere so getTokenPayer
          // still finds an owner, but shrink instruction[2] so the kit
          // parser throws (disc 12 + length ≥ 10, too few accounts).
          compiled.instructions.push({
            accountIndices: [...transfer.accountIndices],
            data: transfer.data ? new Uint8Array(transfer.data) : undefined,
            programAddressIndex: transfer.programAddressIndex,
          });
          transfer.accountIndices = transfer.accountIndices.slice(0, 2);
        },
      );
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_svm_payload_no_transfer_instruction");
    });

    it("should reject a Token-2022 destination ATA that is not the payTo account", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const otherPayTo = await generateKeyPairSigner();
      const transaction = await buildExactPaymentTransaction({
        amount: 100000n,
        feePayer: feePayer.address,
        mint: USDC_DEVNET_ADDRESS as Address,
        payTo: payTo.address,
        payer,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS as Address,
      });
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: otherPayTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_svm_payload_recipient_mismatch");
    });

    it("should reject when the destination ATA is not the payTo account", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const otherPayTo = await generateKeyPairSigner();
      const transaction = await buildExactPaymentTransaction({
        amount: 100000n,
        feePayer: feePayer.address,
        mint: USDC_DEVNET_ADDRESS as Address,
        payTo: payTo.address,
        payer,
      });
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: otherPayTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_svm_payload_recipient_mismatch");
    });

    it("should reject when the payTo address cannot be used to derive an ATA", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const transaction = await buildExactPaymentTransaction({
        amount: 100000n,
        feePayer: feePayer.address,
        mint: USDC_DEVNET_ADDRESS as Address,
        payTo: payTo.address,
        payer,
      });
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: "not-a-solana-address",
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_svm_payload_recipient_mismatch");
    });

    it("should reject a required memo when the transfer has no Memo instruction", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const transaction = await buildExactPaymentTransaction({
        amount: 100000n,
        feePayer: feePayer.address,
        includeMemo: false,
        mint: USDC_DEVNET_ADDRESS as Address,
        payTo: payTo.address,
        payer,
      });
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address, memo: "order-1" },
        } as never,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_svm_payload_memo_count");
    });

    it("should reject an unknown program after TransferChecked", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const transaction = await buildExactPaymentTransaction({
        amount: 100000n,
        extraInstructions: [
          {
            programAddress: "11111111111111111111111111111111" as Address,
            accounts: [] as const,
            data: new Uint8Array([0]),
          },
        ],
        feePayer: feePayer.address,
        includeMemo: false,
        mint: USDC_DEVNET_ADDRESS as Address,
        payTo: payTo.address,
        payer,
      });
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_svm_payload_unknown_fourth_instruction");
    });

    it("should accept a structurally valid transfer once simulation succeeds", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const transaction = await buildExactPaymentTransaction({
        amount: 100000n,
        feePayer: feePayer.address,
        mint: USDC_DEVNET_ADDRESS as Address,
        payTo: payTo.address,
        payer,
      });
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      mockSigner.simulateTransaction = vi.fn().mockResolvedValue(undefined) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.isValid).toBe(true);
      expect(result.payer).toBe(payer.address);
    });

    it("should reject when simulation fails after a structurally valid transfer", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const transaction = await buildExactPaymentTransaction({
        amount: 100000n,
        feePayer: feePayer.address,
        mint: USDC_DEVNET_ADDRESS as Address,
        payTo: payTo.address,
        payer,
      });
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      mockSigner.simulateTransaction = vi
        .fn()
        .mockRejectedValue(new Error("insufficient funds")) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("transaction_simulation_failed");
      expect(result.invalidMessage).toContain("insufficient funds");
    });

    it("should accept an optional Lighthouse instruction after TransferChecked", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const transaction = await buildExactPaymentTransaction({
        amount: 100000n,
        extraInstructions: [
          {
            programAddress: LIGHTHOUSE_PROGRAM_ADDRESS as Address,
            accounts: [] as const,
            data: new Uint8Array([0]),
          },
        ],
        feePayer: feePayer.address,
        mint: USDC_DEVNET_ADDRESS as Address,
        payTo: payTo.address,
        payer,
      });
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      mockSigner.simulateTransaction = vi.fn().mockResolvedValue(undefined) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.verify(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.isValid).toBe(true);
    });

    it("should settle a structurally valid transfer after verify succeeds", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const transaction = await buildExactPaymentTransaction({
        amount: 100000n,
        feePayer: feePayer.address,
        mint: USDC_DEVNET_ADDRESS as Address,
        payTo: payTo.address,
        payer,
      });
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      mockSigner.simulateTransaction = vi.fn().mockResolvedValue(undefined) as never;
      mockSigner.signTransaction = vi.fn().mockResolvedValue("signed-wire") as never;
      mockSigner.sendTransaction = vi.fn().mockResolvedValue("settleSig") as never;
      mockSigner.confirmTransaction = vi.fn().mockResolvedValue(undefined) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.settle(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.success).toBe(true);
      expect(result.transaction).toBe("settleSig");
      expect(result.payer).toBe(payer.address);
    });

    it("should fail settlement and drop the dedup key when verify rejects a decoded transfer", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const transaction = await buildExactPaymentTransaction({
        amount: 100000n,
        feePayer: feePayer.address,
        mint: USDC_DEVNET_ADDRESS as Address,
        payTo: payTo.address,
        payer,
      });
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const result = await facilitator.settle(
        {
          x402Version: 1,
          scheme: "exact",
          network: "solana-devnet",
          payload: { transaction },
        } as never,
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          maxAmountRequired: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        } as never,
      );
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("invalid_exact_svm_payload_mint_mismatch");
    });
  });

  describe("verifyComputePriceInstruction (price cap)", () => {
    it("should reject price above MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS", () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const instruction = {
        programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
        data: makeComputePriceData(BigInt(MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS) + 1n),
      };
      expect(() =>
        (
          facilitator as unknown as { verifyComputePriceInstruction: (i: unknown) => void }
        ).verifyComputePriceInstruction(instruction),
      ).toThrow(
        "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high",
      );
    });

    it("should reject price well above MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS", () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const instruction = {
        programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
        data: makeComputePriceData(BigInt("18446744073709551615")), // u64::MAX
      };
      expect(() =>
        (
          facilitator as unknown as { verifyComputePriceInstruction: (i: unknown) => void }
        ).verifyComputePriceInstruction(instruction),
      ).toThrow(
        "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high",
      );
    });

    it("should accept price exactly at MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS", () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const instruction = {
        programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
        data: makeComputePriceData(BigInt(MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS)),
      };
      expect(() =>
        (
          facilitator as unknown as { verifyComputePriceInstruction: (i: unknown) => void }
        ).verifyComputePriceInstruction(instruction),
      ).not.toThrow();
    });

    it("should accept price well below MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS", () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const instruction = {
        programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
        data: makeComputePriceData(1n),
      };
      expect(() =>
        (
          facilitator as unknown as { verifyComputePriceInstruction: (i: unknown) => void }
        ).verifyComputePriceInstruction(instruction),
      ).not.toThrow();
    });

    it("should reject a compute price instruction that cannot be parsed", () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const instruction = {
        programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
        data: new Uint8Array([3]),
      };
      expect(() =>
        (
          facilitator as unknown as { verifyComputePriceInstruction: (i: unknown) => void }
        ).verifyComputePriceInstruction(instruction),
      ).toThrow("invalid_exact_svm_payload_transaction_instructions_compute_price_instruction");
    });
  });

  describe("verifyComputeLimitInstruction", () => {
    it("should reject a non-compute-budget program", () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const instruction = {
        programAddress: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        data: new Uint8Array([2, 0, 0, 0, 0]),
      };
      expect(() =>
        (
          facilitator as unknown as { verifyComputeLimitInstruction: (i: unknown) => void }
        ).verifyComputeLimitInstruction(instruction),
      ).toThrow("invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction");
    });

    it("should reject a compute price whose discriminator is not SetComputeUnitPrice", () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      expect(() =>
        (
          facilitator as unknown as { verifyComputePriceInstruction: (i: unknown) => void }
        ).verifyComputePriceInstruction({
          programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
          data: new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0]),
        }),
      ).toThrow("invalid_exact_svm_payload_transaction_instructions_compute_price_instruction");
    });

    it("should reject a compute limit instruction that cannot be parsed", () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      const instruction = {
        programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
        data: new Uint8Array([2]),
      };
      expect(() =>
        (
          facilitator as unknown as { verifyComputeLimitInstruction: (i: unknown) => void }
        ).verifyComputeLimitInstruction(instruction),
      ).toThrow("invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction");
    });
  });

  describe("settle", () => {
    it("should fail settlement if verification fails", async () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);

      const payload: PaymentPayloadV1 = {
        x402Version: 1,
        scheme: "wrong",
        network: "solana-devnet",
        payload: {
          transaction: "base64transaction==",
        },
      };

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "solana-devnet",
        asset: USDC_DEVNET_ADDRESS,
        maxAmountRequired: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: {
          feePayer: "FeePayer1111111111111111111111111111",
        },
      };

      const result = await facilitator.settle(payload as never, requirements as never);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("unsupported_scheme");
      expect(result.network).toBe("solana-devnet");
    });
  });

  describe("duplicate settlement cache", () => {
    beforeEach(() => {
      // Return a fake decoded Transaction whose messageBytes are derived deterministically
      // from the transaction string. This lets the cache key tests work with arbitrary
      // test strings without needing real Solana transaction binaries.
      vi.spyOn(svmUtils, "decodeTransactionFromPayload").mockImplementation(
        (payload: { transaction: string }) =>
          ({ messageBytes: new TextEncoder().encode(payload.transaction) }) as never,
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function makePayload(transaction: string): PaymentPayloadV1 {
      return {
        x402Version: 1,
        scheme: "exact",
        network: "solana-devnet",
        payload: { transaction },
      };
    }

    const requirements: PaymentRequirementsV1 = {
      scheme: "exact",
      network: "solana-devnet",
      asset: USDC_DEVNET_ADDRESS,
      maxAmountRequired: "100000",
      payTo: "PayToAddress11111111111111111111111111",
      maxTimeoutSeconds: 3600,
      extra: { feePayer: "FeePayer1111111111111111111111111111" },
    };

    function setupSettleMocks(facilitator: ExactSvmSchemeV1) {
      vi.spyOn(facilitator, "verify").mockResolvedValue({
        isValid: true,
        payer: "PayerAddress",
      });
      (mockSigner as Record<string, unknown>).signTransaction = vi
        .fn()
        .mockResolvedValue("signedTx");
      (mockSigner as Record<string, unknown>).sendTransaction = vi
        .fn()
        .mockResolvedValue("txSignature123");
      (mockSigner as Record<string, unknown>).confirmTransaction = vi
        .fn()
        .mockResolvedValue(undefined);
    }

    it("should reject duplicate settlement of the same transaction", async () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      setupSettleMocks(facilitator);

      const payload = makePayload("sameTransactionBase64==");

      const result1 = await facilitator.settle(payload as never, requirements as never);
      expect(result1.success).toBe(true);

      const result2 = await facilitator.settle(payload as never, requirements as never);
      expect(result2.success).toBe(false);
      expect(result2.errorReason).toBe("duplicate_settlement");
    });

    it("should allow settlement of distinct transactions", async () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      setupSettleMocks(facilitator);

      const result1 = await facilitator.settle(
        makePayload("transactionA==") as never,
        requirements as never,
      );
      expect(result1.success).toBe(true);

      const result2 = await facilitator.settle(
        makePayload("transactionB==") as never,
        requirements as never,
      );
      expect(result2.success).toBe(true);
    });

    it("should evict cache entries after TTL", async () => {
      vi.useFakeTimers();
      try {
        const facilitator = new ExactSvmSchemeV1(mockSigner);
        setupSettleMocks(facilitator);

        const payload = makePayload("expiringTransaction==");

        const result1 = await facilitator.settle(payload as never, requirements as never);
        expect(result1.success).toBe(true);

        // Advance past the 120s TTL
        vi.advanceTimersByTime(121_000);

        const result2 = await facilitator.settle(payload as never, requirements as never);
        expect(result2.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should release the cache when send fails so a retry can proceed", async () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      setupSettleMocks(facilitator);
      (mockSigner as Record<string, unknown>).sendTransaction = vi
        .fn()
        .mockRejectedValueOnce(new Error("rpc send failed"))
        .mockResolvedValueOnce("txSignature123");

      const payload = makePayload("retryAfterSendFail==");
      const result1 = await facilitator.settle(payload as never, requirements as never);
      expect(result1.success).toBe(false);
      expect(result1.errorReason).toBe("transaction_failed");

      const result2 = await facilitator.settle(payload as never, requirements as never);
      expect(result2.success).toBe(true);
    });

    it("should keep duplicate settlement when getTokenPayerFromTransaction throws", async () => {
      const facilitator = new ExactSvmSchemeV1(mockSigner);
      setupSettleMocks(facilitator);
      vi.spyOn(svmUtils, "getTokenPayerFromTransaction").mockImplementation(() => {
        throw new Error("no payer");
      });

      const payload = makePayload("duplicatePayerThrow==");
      const result1 = await facilitator.settle(payload as never, requirements as never);
      expect(result1.success).toBe(true);

      const result2 = await facilitator.settle(payload as never, requirements as never);
      expect(result2.success).toBe(false);
      expect(result2.errorReason).toBe("duplicate_settlement");
      expect(result2.payer).toBe("");
    });
  });
});
