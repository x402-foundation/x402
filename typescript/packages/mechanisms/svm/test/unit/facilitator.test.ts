import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import { x402Facilitator } from "@x402/core/facilitator";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { ExactSvmScheme } from "../../src/exact/facilitator/scheme";
import { registerExactSvmScheme } from "../../src/exact/facilitator/register";
import * as Errors from "../../src/exact/facilitator/errors";
import { ExactSvmSchemeV1 } from "../../src/exact/v1/facilitator/scheme";
import { SettlementCache } from "../../src/settlement-cache";
import type { FacilitatorSvmSigner } from "../../src/signer";
import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";
import type { PaymentPayloadV1, PaymentRequirementsV1 } from "@x402/core/types/v1";
import {
  LIGHTHOUSE_PROGRAM_ADDRESS,
  SOLANA_DEVNET_CAIP2,
  MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import { NETWORKS } from "../../src/v1";
import * as svmUtils from "../../src/utils";
import {
  buildExactPaymentTransaction,
  resignMutatedTransaction,
} from "./helpers/signedTransaction";

// Encodes a SetComputeUnitPrice instruction: discriminator(3) + microLamports as u64 LE
function makeComputePriceData(microLamports: bigint): Uint8Array {
  const buf = new ArrayBuffer(9);
  const view = new DataView(buf);
  view.setUint8(0, 3);
  view.setBigUint64(1, microLamports, true);
  return new Uint8Array(buf);
}

// Encodes a SetComputeUnitLimit instruction: discriminator(2) + units as u32 LE
function makeComputeLimitData(units: number): Uint8Array {
  const buf = new ArrayBuffer(5);
  const view = new DataView(buf);
  view.setUint8(0, 2);
  view.setUint32(1, units, true);
  return new Uint8Array(buf);
}

function v2Requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: SOLANA_DEVNET_CAIP2,
    asset: USDC_DEVNET_ADDRESS,
    amount: "100000",
    payTo: "PayToAddress11111111111111111111111111",
    maxTimeoutSeconds: 3600,
    extra: { feePayer: "FeePayer1111111111111111111111111111" },
    ...overrides,
  };
}

function v2Payment(
  transaction: string,
  acceptedOverrides: Partial<PaymentRequirements> = {},
): PaymentPayload {
  const accepted = v2Requirements(acceptedOverrides);
  return {
    x402Version: 2,
    resource: {
      url: "http://example.com/protected",
      description: "Test resource",
      mimeType: "application/json",
    },
    accepted,
    payload: { transaction },
  };
}

describe("ExactSvmScheme", () => {
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
      const facilitator = new ExactSvmScheme(mockSigner);
      expect(facilitator.scheme).toBe("exact");
    });
  });

  describe("getExtra / getSigners", () => {
    it("returns all managed fee payers from getSigners", () => {
      const facilitator = new ExactSvmScheme(mockSigner);
      expect(facilitator.getSigners(SOLANA_DEVNET_CAIP2)).toEqual([
        "FeePayer1111111111111111111111111111",
        "FacilitatorAddress1111111111111111111",
      ]);
    });

    it("selects a managed feePayer in getExtra", () => {
      const facilitator = new ExactSvmScheme(mockSigner);
      const extra = facilitator.getExtra(SOLANA_DEVNET_CAIP2);
      expect(extra).toBeDefined();
      expect(mockSigner.getAddresses()).toContain(extra!.feePayer);
    });
  });

  describe("verify", () => {
    it("should reject if scheme does not match", async () => {
      const facilitator = new ExactSvmScheme(mockSigner);

      const payload: PaymentPayload = {
        x402Version: 2,
        resource: {
          url: "http://example.com/protected",
          description: "Test resource",
          mimeType: "application/json",
        },
        accepted: {
          scheme: "wrong", // Wrong scheme
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: "PayToAddress11111111111111111111111111",
          maxTimeoutSeconds: 3600,
          extra: { feePayer: "FeePayer1111111111111111111111111111" },
        },
        payload: {
          transaction: "base64transaction==",
        },
      };

      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: { feePayer: "FeePayer1111111111111111111111111111" },
      };

      const result = await facilitator.verify(payload, requirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrUnsupportedScheme);
    });

    it("should reject if network does not match", async () => {
      const facilitator = new ExactSvmScheme(mockSigner);

      const payload: PaymentPayload = {
        x402Version: 2,
        resource: {
          url: "http://example.com/protected",
          description: "Test resource",
          mimeType: "application/json",
        },
        accepted: {
          scheme: "exact",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", // Mainnet
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: "PayToAddress11111111111111111111111111",
          maxTimeoutSeconds: 3600,
          extra: { feePayer: "FeePayer1111111111111111111111111111" },
        },
        payload: {
          transaction: "validbase64transaction==",
        },
      };

      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2, // Devnet
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: { feePayer: "FeePayer1111111111111111111111111111" },
      };

      const result = await facilitator.verify(payload, requirements);

      // Network check happens early in Step 1 (before transaction parsing)
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrNetworkMismatch);
    });

    it("should reject if feePayer is missing", async () => {
      const facilitator = new ExactSvmScheme(mockSigner);

      const payload: PaymentPayload = {
        x402Version: 2,
        resource: {
          url: "http://example.com/protected",
          description: "Test resource",
          mimeType: "application/json",
        },
        accepted: {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: "PayToAddress11111111111111111111111111",
          maxTimeoutSeconds: 3600,
          extra: {},
        },
        payload: {
          transaction: "base64transaction==",
        },
      };

      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: {}, // Missing feePayer
      };

      const result = await facilitator.verify(payload, requirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_svm_payload_missing_fee_payer");
    });

    it("should reject if feePayer is not managed by this facilitator", async () => {
      const facilitator = new ExactSvmScheme(mockSigner);

      const payload: PaymentPayload = {
        x402Version: 2,
        resource: {
          url: "http://example.com/protected",
          description: "Test resource",
          mimeType: "application/json",
        },
        accepted: {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: "PayToAddress11111111111111111111111111",
          maxTimeoutSeconds: 3600,
          extra: { feePayer: "UnmanagedFeePayer111111111111111111111" },
        },
        payload: {
          transaction: "base64transaction==",
        },
      };

      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: { feePayer: "UnmanagedFeePayer111111111111111111111" },
      };

      const result = await facilitator.verify(payload, requirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrFeePayerNotManaged);
    });

    it("should reject if transaction cannot be decoded", async () => {
      const facilitator = new ExactSvmScheme(mockSigner);

      const payload: PaymentPayload = {
        x402Version: 2,
        resource: {
          url: "http://example.com/protected",
          description: "Test resource",
          mimeType: "application/json",
        },
        accepted: {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: "PayToAddress11111111111111111111111111",
          maxTimeoutSeconds: 3600,
          extra: { feePayer: "FeePayer1111111111111111111111111111" },
        },
        payload: {
          transaction: "invalid!!!", // Invalid base64
        },
      };

      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: { feePayer: "FeePayer1111111111111111111111111111" },
      };

      const result = await facilitator.verify(payload, requirements);

      expect(result.isValid).toBe(false);
      // Transaction decoding or instruction validation fails
      expect(result.invalidReason).toContain("invalid_exact_svm_payload_transaction");
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
      const facilitator = new ExactSvmScheme(mockSigner);
      const result = await facilitator.verify(
        v2Payment(transaction, {
          asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          extra: { feePayer: feePayer.address },
          payTo: payTo.address,
        }),
        v2Requirements({
          asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          extra: { feePayer: feePayer.address },
          payTo: payTo.address,
        }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrMintMismatch);
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
      const facilitator = new ExactSvmScheme(mockSigner);
      const result = await facilitator.verify(
        v2Payment(transaction, {
          extra: { feePayer: feePayer.address },
          payTo: payTo.address,
        }),
        v2Requirements({ extra: { feePayer: feePayer.address }, payTo: payTo.address }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrAmountMismatch);
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
      const facilitator = new ExactSvmScheme(mockSigner);
      const result = await facilitator.verify(
        v2Payment(transaction, {
          extra: { feePayer: feePayer.address },
          payTo: payTo.address,
        }),
        v2Requirements({ extra: { feePayer: feePayer.address }, payTo: payTo.address }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrFeePayerTransferringFunds);
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
      const facilitator = new ExactSvmScheme(mockSigner);
      const result = await facilitator.verify(
        v2Payment(transaction, {
          extra: { feePayer: feePayer.address },
          payTo: payTo.address,
        }),
        v2Requirements({ extra: { feePayer: feePayer.address }, payTo: payTo.address }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrNoTransferInstruction);
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
      const facilitator = new ExactSvmScheme(mockSigner);
      const result = await facilitator.verify(
        v2Payment(transaction, {
          extra: { feePayer: feePayer.address },
          payTo: payTo.address,
        }),
        v2Requirements({ extra: { feePayer: feePayer.address }, payTo: payTo.address }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrNoTransferInstruction);
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
      const facilitator = new ExactSvmScheme(mockSigner);
      const result = await facilitator.verify(
        v2Payment(transaction, {
          extra: { feePayer: feePayer.address },
          payTo: otherPayTo.address,
        }),
        v2Requirements({ extra: { feePayer: feePayer.address }, payTo: otherPayTo.address }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrRecipientMismatch);
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
      const facilitator = new ExactSvmScheme(mockSigner);
      const result = await facilitator.verify(
        v2Payment(transaction, {
          extra: { feePayer: feePayer.address },
          payTo: "not-a-solana-address",
        }),
        v2Requirements({ extra: { feePayer: feePayer.address }, payTo: "not-a-solana-address" }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrRecipientMismatch);
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
      const facilitator = new ExactSvmScheme(mockSigner);
      const result = await facilitator.verify(
        v2Payment(transaction, {
          extra: { feePayer: feePayer.address, memo: "expected-memo" },
          payTo: payTo.address,
        }),
        v2Requirements({
          extra: { feePayer: feePayer.address, memo: "expected-memo" },
          payTo: payTo.address,
        }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrMemoMismatch);
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
      const facilitator = new ExactSvmScheme(mockSigner);
      const result = await facilitator.verify(
        v2Payment(transaction, {
          extra: { feePayer: feePayer.address, memo: "order-1" },
          payTo: payTo.address,
        }),
        v2Requirements({
          extra: { feePayer: feePayer.address, memo: "order-1" },
          payTo: payTo.address,
        }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrMemoCount);
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
      const facilitator = new ExactSvmScheme(mockSigner);
      const result = await facilitator.verify(
        v2Payment(transaction, {
          extra: { feePayer: feePayer.address },
          payTo: payTo.address,
        }),
        v2Requirements({ extra: { feePayer: feePayer.address }, payTo: payTo.address }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrUnknownFourthInstruction);
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
      const facilitator = new ExactSvmScheme(mockSigner);
      const result = await facilitator.verify(
        v2Payment(transaction, {
          extra: { feePayer: feePayer.address },
          payTo: payTo.address,
        }),
        v2Requirements({ extra: { feePayer: feePayer.address }, payTo: payTo.address }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrTransactionSimulationFailed);
      expect(result.invalidMessage).toContain("insufficient funds");
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
      const facilitator = new ExactSvmScheme(mockSigner);
      const result = await facilitator.verify(
        v2Payment(transaction, {
          extra: { feePayer: feePayer.address },
          payTo: payTo.address,
        }),
        v2Requirements({ extra: { feePayer: feePayer.address }, payTo: payTo.address }),
      );
      expect(result.isValid).toBe(true);
      expect(result.payer).toBe(payer.address);
    });

    it("should accept a Token-2022 TransferChecked once simulation succeeds", async () => {
      const feePayer = await generateKeyPairSigner();
      const payer = await generateKeyPairSigner();
      const payTo = await generateKeyPairSigner();
      const transaction = await buildExactPaymentTransaction({
        amount: 100000n,
        feePayer: feePayer.address,
        mint: USDC_DEVNET_ADDRESS as Address,
        payTo: payTo.address,
        payer,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS as Address,
      });
      mockSigner.getAddresses = vi.fn().mockReturnValue([feePayer.address]) as never;
      mockSigner.simulateTransaction = vi.fn().mockResolvedValue(undefined) as never;
      const facilitator = new ExactSvmScheme(mockSigner);
      const result = await facilitator.verify(
        v2Payment(transaction, {
          extra: { feePayer: feePayer.address },
          payTo: payTo.address,
        }),
        v2Requirements({ extra: { feePayer: feePayer.address }, payTo: payTo.address }),
      );
      expect(result.isValid).toBe(true);
      expect(result.payer).toBe(payer.address);
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
      const facilitator = new ExactSvmScheme(mockSigner);
      const result = await facilitator.verify(
        v2Payment(transaction, {
          extra: { feePayer: feePayer.address },
          payTo: payTo.address,
        }),
        v2Requirements({ extra: { feePayer: feePayer.address }, payTo: payTo.address }),
      );
      expect(result.isValid).toBe(true);
    });

    it("should reject Path 2 when a recoverable junk instruction is not an allowed wallet program", async () => {
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
      mockSigner.simulateTransactionWithInnerInstructions = vi.fn() as never;
      mockSigner.getConfirmedTransactionInnerInstructions = vi.fn() as never;
      mockSigner.getTokenAccountBalance = vi.fn() as never;
      mockSigner.fetchAddressLookupTables = vi.fn() as never;
      const facilitator = new ExactSvmScheme(mockSigner, undefined, {
        enableSmartWalletVerification: true,
        smartWalletAllowedPrograms: ["SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"],
      });
      const result = await facilitator.verify(
        v2Payment(transaction, {
          extra: { feePayer: feePayer.address },
          payTo: payTo.address,
        }),
        v2Requirements({ extra: { feePayer: feePayer.address }, payTo: payTo.address }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain(Errors.ErrSmartWalletProgramNotAllowed);
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
      const facilitator = new ExactSvmScheme(mockSigner);
      const result = await facilitator.settle(
        v2Payment(transaction, {
          extra: { feePayer: feePayer.address },
          payTo: payTo.address,
        }),
        v2Requirements({ extra: { feePayer: feePayer.address }, payTo: payTo.address }),
      );
      expect(result.success).toBe(true);
      expect(result.transaction).toBe("settleSig");
      expect(result.payer).toBe(payer.address);
    });
  });

  describe("verifyComputePriceInstruction (price cap)", () => {
    it("should reject price above MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS", () => {
      const facilitator = new ExactSvmScheme(mockSigner);
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
      const facilitator = new ExactSvmScheme(mockSigner);
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
      const facilitator = new ExactSvmScheme(mockSigner);
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
      const facilitator = new ExactSvmScheme(mockSigner);
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
  });

  describe("operator-configurable limits", () => {
    const priceInstruction = (microLamports: bigint) => ({
      programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
      data: makeComputePriceData(microLamports),
    });
    const limitInstruction = (units: number) => ({
      programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
      data: makeComputeLimitData(units),
    });
    const callPrice = (f: ExactSvmScheme, i: unknown) =>
      (
        f as unknown as { verifyComputePriceInstruction: (i: unknown) => void }
      ).verifyComputePriceInstruction(i);
    const callLimit = (f: ExactSvmScheme, i: unknown) =>
      (
        f as unknown as { verifyComputeLimitInstruction: (i: unknown) => void }
      ).verifyComputeLimitInstruction(i);

    it("should enforce a lowered maxPriorityFeeMicroLamports", () => {
      const facilitator = new ExactSvmScheme(mockSigner, undefined, {
        maxPriorityFeeMicroLamports: 5,
      });
      expect(() => callPrice(facilitator, priceInstruction(6n))).toThrow(
        "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high",
      );
      expect(() => callPrice(facilitator, priceInstruction(5n))).not.toThrow();
    });

    it("should keep the default price cap when maxPriorityFeeMicroLamports is unset", () => {
      const facilitator = new ExactSvmScheme(mockSigner);
      expect(() =>
        callPrice(facilitator, priceInstruction(BigInt(MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS))),
      ).not.toThrow();
    });

    it("should enforce maxComputeUnits when configured", () => {
      const facilitator = new ExactSvmScheme(mockSigner, undefined, { maxComputeUnits: 60_000 });
      expect(() => callLimit(facilitator, limitInstruction(60_001))).toThrow(
        "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction_too_high",
      );
      expect(() => callLimit(facilitator, limitInstruction(60_000))).not.toThrow();
    });

    it("should not cap compute units when maxComputeUnits is unset", () => {
      const facilitator = new ExactSvmScheme(mockSigner);
      expect(() => callLimit(facilitator, limitInstruction(1_400_000))).not.toThrow();
    });

    // NaN/Infinity reach these options easily via parseInt on an unset env var,
    // and each degrades differently: a NaN compute-unit or signature ceiling
    // makes every comparison false (no limit), while a NaN priority fee makes
    // BigInt() throw and rejects every payment under a misleading reason code.
    it.each([
      ["maxPriorityFeeMicroLamports", NaN],
      ["maxPriorityFeeMicroLamports", Infinity],
      ["maxPriorityFeeMicroLamports", 1.5],
      ["maxPriorityFeeMicroLamports", -1],
      ["maxComputeUnits", NaN],
      ["maxComputeUnits", Infinity],
      ["maxComputeUnits", -1],
      ["maxComputeUnits", 0],
      ["maxRequiredSignatures", NaN],
      ["maxRequiredSignatures", Infinity],
      ["maxRequiredSignatures", 0],
    ])("should reject %s = %s at construction", (option, value) => {
      expect(
        () => new ExactSvmScheme(mockSigner, undefined, { [option]: value as number }),
      ).toThrow(option);
    });

    it("should accept the boundary values of each limit", () => {
      expect(
        () =>
          new ExactSvmScheme(mockSigner, undefined, {
            maxPriorityFeeMicroLamports: 0,
            maxComputeUnits: 1,
            maxRequiredSignatures: 1,
          }),
      ).not.toThrow();
    });

    it("should reject a compute price instruction that cannot be parsed", () => {
      const facilitator = new ExactSvmScheme(mockSigner);
      expect(() =>
        callPrice(facilitator, {
          programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
          data: new Uint8Array([3]),
        }),
      ).toThrow("invalid_exact_svm_payload_transaction_instructions_compute_price_instruction");
    });

    it("should reject a compute limit whose discriminator is not SetComputeUnitLimit", () => {
      const facilitator = new ExactSvmScheme(mockSigner);
      expect(() =>
        (
          facilitator as unknown as { verifyComputeLimitInstruction: (i: unknown) => void }
        ).verifyComputeLimitInstruction({
          programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
          data: new Uint8Array([3, 0, 0, 0, 0]),
        }),
      ).toThrow(Errors.ErrComputeLimitInstruction);
    });

    it("should reject a compute price whose discriminator is not SetComputeUnitPrice", () => {
      const facilitator = new ExactSvmScheme(mockSigner);
      expect(() =>
        (
          facilitator as unknown as { verifyComputePriceInstruction: (i: unknown) => void }
        ).verifyComputePriceInstruction({
          programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
          data: new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0]),
        }),
      ).toThrow(Errors.ErrComputePriceInstruction);
    });

    it("should reject a compute limit instruction that cannot be parsed", () => {
      const facilitator = new ExactSvmScheme(mockSigner);
      expect(() =>
        callLimit(facilitator, {
          programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
          data: new Uint8Array([2]),
        }),
      ).toThrow("invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction");
    });
  });

  describe("settle", () => {
    it("should fail settlement if verification fails", async () => {
      const facilitator = new ExactSvmScheme(mockSigner);

      const payload: PaymentPayload = {
        x402Version: 2,
        resource: {
          url: "http://example.com/protected",
          description: "Test resource",
          mimeType: "application/json",
        },
        accepted: {
          scheme: "wrong", // Wrong scheme
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: "PayToAddress11111111111111111111111111",
          maxTimeoutSeconds: 3600,
          extra: { feePayer: "FeePayer1111111111111111111111111111" },
        },
        payload: {
          transaction: "base64transaction==",
        },
      };

      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: { feePayer: "FeePayer1111111111111111111111111111" },
      };

      const result = await facilitator.settle(payload, requirements);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrUnsupportedScheme);
      expect(result.network).toBe(SOLANA_DEVNET_CAIP2);
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

    function makePayload(transaction: string): PaymentPayload {
      return {
        x402Version: 2,
        resource: {
          url: "http://example.com/protected",
          description: "Test resource",
          mimeType: "application/json",
        },
        accepted: {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: "PayToAddress11111111111111111111111111",
          maxTimeoutSeconds: 3600,
          extra: { feePayer: "FeePayer1111111111111111111111111111" },
        },
        payload: { transaction },
      };
    }

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: "PayToAddress11111111111111111111111111",
      maxTimeoutSeconds: 3600,
      extra: { feePayer: "FeePayer1111111111111111111111111111" },
    };

    function setupSettleMocks(facilitator: ExactSvmScheme) {
      // settle() calls the internal _verify (which also reports the path), so we
      // mock that to isolate the duplicate-cache logic from real verification.
      const verifySpy = vi
        .spyOn(
          facilitator as unknown as {
            _verify: (...args: unknown[]) => Promise<unknown>;
          },
          "_verify",
        )
        .mockResolvedValue({
          response: { isValid: true, payer: "PayerAddress" },
          verificationPath: "static",
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
      return { verifySpy };
    }

    it("should reject duplicate settlement of the same transaction", async () => {
      const facilitator = new ExactSvmScheme(mockSigner);
      const { verifySpy } = setupSettleMocks(facilitator);
      vi.spyOn(svmUtils, "getTokenPayerFromTransaction").mockReturnValue("TokenPayer111");

      const payload = makePayload("sameTransactionBase64==");

      const result1 = await facilitator.settle(payload, requirements);
      expect(result1.success).toBe(true);

      const result2 = await facilitator.settle(payload, requirements);
      expect(result2.success).toBe(false);
      expect(result2.errorReason).toBe("duplicate_settlement");
      expect(result2.payer).toBe("TokenPayer111");
      expect(verifySpy).toHaveBeenCalledTimes(1);
    });

    it("should release the settlement cache when verification fails so a retry can proceed", async () => {
      const facilitator = new ExactSvmScheme(mockSigner);
      const verify = vi.spyOn(
        facilitator as unknown as { _verify: (...args: unknown[]) => Promise<unknown> },
        "_verify",
      );
      verify
        .mockResolvedValueOnce({
          response: {
            isValid: false,
            invalidReason: Errors.ErrTransactionSimulationFailed,
            payer: "",
          },
          verificationPath: null,
        })
        .mockResolvedValueOnce({
          response: { isValid: true, payer: "PayerAddress" },
          verificationPath: "static",
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

      const payload = makePayload("retryAfterVerifyFail==");
      const result1 = await facilitator.settle(payload, requirements);
      expect(result1.success).toBe(false);
      expect(result1.errorReason).toBe(Errors.ErrTransactionSimulationFailed);

      const result2 = await facilitator.settle(payload, requirements);
      expect(result2.success).toBe(true);
    });

    it("should release the settlement cache when send/confirm fails so a retry can proceed", async () => {
      const facilitator = new ExactSvmScheme(mockSigner);
      setupSettleMocks(facilitator);
      (mockSigner as Record<string, unknown>).sendTransaction = vi
        .fn()
        .mockRejectedValueOnce(new Error("rpc send failed"))
        .mockResolvedValueOnce("txSignature123");

      const payload = makePayload("retryAfterTransientFailure==");
      const result1 = await facilitator.settle(payload, requirements);
      expect(result1.success).toBe(false);
      expect(result1.errorReason).toBe(Errors.ErrTransactionFailed);

      const result2 = await facilitator.settle(payload, requirements);
      expect(result2.success).toBe(true);
    });

    it("should allow settlement of distinct transactions", async () => {
      const facilitator = new ExactSvmScheme(mockSigner);
      setupSettleMocks(facilitator);

      const result1 = await facilitator.settle(makePayload("transactionA=="), requirements);
      expect(result1.success).toBe(true);

      const result2 = await facilitator.settle(makePayload("transactionB=="), requirements);
      expect(result2.success).toBe(true);
    });

    it("should evict cache entries after TTL", async () => {
      vi.useFakeTimers();
      try {
        const facilitator = new ExactSvmScheme(mockSigner);
        setupSettleMocks(facilitator);

        const payload = makePayload("expiringTransaction==");

        const result1 = await facilitator.settle(payload, requirements);
        expect(result1.success).toBe(true);

        // Advance past the 120s TTL
        vi.advanceTimersByTime(121_000);

        const result2 = await facilitator.settle(payload, requirements);
        expect(result2.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should block cross-version duplicate when sharing a cache", async () => {
      const sharedCache = new SettlementCache();
      const v2 = new ExactSvmScheme(mockSigner, sharedCache);
      const v1 = new ExactSvmSchemeV1(mockSigner, sharedCache);

      // Mock V2 settle flow
      vi.spyOn(
        v2 as unknown as { _verify: (...args: unknown[]) => Promise<unknown> },
        "_verify",
      ).mockResolvedValue({
        response: { isValid: true, payer: "PayerAddress" },
        verificationPath: "static",
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

      // Settle via V2 first
      const v2Result = await v2.settle(makePayload("crossVersionTx=="), requirements);
      expect(v2Result.success).toBe(true);

      // Mock V1 verify
      vi.spyOn(v1, "verify").mockResolvedValue({
        isValid: true,
        payer: "PayerAddress",
      });

      // Same tx via V1 should be rejected
      const v1Payload: PaymentPayloadV1 = {
        x402Version: 1,
        scheme: "exact",
        network: "solana-devnet",
        payload: { transaction: "crossVersionTx==" },
      };
      const v1Requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "solana-devnet",
        asset: USDC_DEVNET_ADDRESS,
        maxAmountRequired: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: { feePayer: "FeePayer1111111111111111111111111111" },
      };

      const v1Result = await v1.settle(v1Payload as never, v1Requirements as never);
      expect(v1Result.success).toBe(false);
      expect(v1Result.errorReason).toBe("duplicate_settlement");
    });
  });
});

describe("registerExactSvmScheme", () => {
  it("registers v2 on the configured networks and all v1 networks with a shared cache", () => {
    const facilitator = new x402Facilitator();
    const signer: FacilitatorSvmSigner = {
      getAddresses: () => ["FeePayer1111111111111111111111111111" as never],
      signTransaction: async () => "tx",
      simulateTransaction: async () => {},
      sendTransaction: async () => "sig",
      confirmTransaction: async () => {},
    };

    const returned = registerExactSvmScheme(facilitator, {
      signer,
      networks: SOLANA_DEVNET_CAIP2,
    });
    expect(returned).toBe(facilitator);

    const supported = facilitator.getSupported();
    const v2 = supported.kinds.filter(k => k.x402Version === 2 && k.scheme === "exact");
    const v1 = supported.kinds.filter(k => k.x402Version === 1 && k.scheme === "exact");
    expect(v2.map(k => k.network)).toEqual([SOLANA_DEVNET_CAIP2]);
    expect(v1.map(k => k.network).sort()).toEqual([...NETWORKS].sort());
    expect(v2[0]?.extra?.feePayer).toBe("FeePayer1111111111111111111111111111");
  });
});

describe("SettlementCache", () => {
  it("delete releases a key so isDuplicate can accept it again", () => {
    const cache = new SettlementCache();
    expect(cache.isDuplicate("pending-tx")).toBe(false);
    expect(cache.isDuplicate("pending-tx")).toBe(true);
    cache.delete("pending-tx");
    expect(cache.isDuplicate("pending-tx")).toBe(false);
  });
});

describe("SettlementCache prune optimization", () => {
  it("should prune only expired entries and preserve non-expired ones", () => {
    vi.useFakeTimers();
    try {
      const cache = new SettlementCache();

      // Insert three entries 10s apart
      cache.isDuplicate("tx-a");
      vi.advanceTimersByTime(10_000);
      cache.isDuplicate("tx-b");
      vi.advanceTimersByTime(10_000);
      cache.isDuplicate("tx-c");

      // Advance so tx-a and tx-b are expired (> 120s old) but tx-c is not
      vi.advanceTimersByTime(101_000); // total: tx-a=121s, tx-b=111s, tx-c=101s

      // tx-a should be expired, tx-b and tx-c should still be cached
      // Trigger prune via a new isDuplicate call
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

      // All expired — none should be detected as duplicates
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

    // All still fresh — all should be detected as duplicates
    expect(cache.isDuplicate("tx-x")).toBe(true);
    expect(cache.isDuplicate("tx-y")).toBe(true);
    expect(cache.isDuplicate("tx-z")).toBe(true);
  });
});
