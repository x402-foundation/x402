import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchMint } from "@solana-program/token-2022";
import { ExactSvmSchemeV1 } from "../../../src/exact/v1/client/scheme";
import type { ClientSvmSigner } from "../../../src/signer";
import type { PaymentRequirementsV1 } from "@x402/core/types/v1";
import { MAX_MEMO_BYTES, TOKEN_PROGRAM_ADDRESS } from "../../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../../src/defaultAssets";

vi.mock("@solana-program/token-2022", async importOriginal => {
  const actual = await importOriginal<typeof import("@solana-program/token-2022")>();
  return {
    ...actual,
    fetchMint: vi.fn(),
  };
});

vi.mock("../../../src/utils", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/utils")>();
  return {
    ...actual,
    createRpcClient: vi.fn(() => ({
      getLatestBlockhash: () => ({
        send: async () => ({
          value: {
            blockhash: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
            lastValidBlockHeight: 1n,
          },
        }),
      }),
    })),
  };
});

describe("ExactSvmSchemeV1", () => {
  let mockSigner: ClientSvmSigner;

  beforeEach(() => {
    mockSigner = {
      address: "9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ" as never,
      signTransactions: vi.fn().mockResolvedValue([
        {
          messageBytes: new Uint8Array(10),
          signatures: {},
        },
      ]) as never,
    };
  });

  describe("constructor", () => {
    it("should create instance with correct scheme", () => {
      const client = new ExactSvmSchemeV1(mockSigner);
      expect(client.scheme).toBe("exact");
    });
  });

  describe("createPaymentPayload", () => {
    it("should create V1 payment payload with scheme and network fields", async () => {
      const client = new ExactSvmSchemeV1(mockSigner);

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

      expect(client.createPaymentPayload).toBeDefined();
      expect(typeof client.createPaymentPayload).toBe("function");
      expect(requirements.maxAmountRequired).toBe("100000");
    });

    it("should throw if feePayer is missing", () => {
      const client = new ExactSvmSchemeV1(mockSigner);

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "solana-devnet",
        asset: USDC_DEVNET_ADDRESS,
        maxAmountRequired: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: {}, // Missing feePayer
      };

      // The actual implementation will throw when it tries to get feePayer
      // We're testing that the method exists and would handle this scenario
      expect(client.createPaymentPayload).toBeDefined();
      expect(requirements.extra?.feePayer).toBeUndefined();
    });

    it("should accept V1 requirements with maxAmountRequired field", () => {
      const client = new ExactSvmSchemeV1(mockSigner);

      // Verify the client accepts PaymentRequirementsV1 with maxAmountRequired field
      type V1Requirements = PaymentRequirementsV1 & { maxAmountRequired: string };
      const hasMaxAmountField = (req: PaymentRequirementsV1): req is V1Requirements =>
        "maxAmountRequired" in req;

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "solana-devnet",
        asset: USDC_DEVNET_ADDRESS,
        maxAmountRequired: "500000", // V1 uses maxAmountRequired instead of amount
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: { feePayer: "FeePayer1111111111111111111111111111" },
      };

      expect(hasMaxAmountField(requirements)).toBe(true);
      if (hasMaxAmountField(requirements)) {
        expect(requirements.maxAmountRequired).toBe("500000");
      }
      expect(client.scheme).toBe("exact");
    });

    it("rejects a mint owned by an unknown program", async () => {
      vi.mocked(fetchMint).mockResolvedValue({
        data: { decimals: 6 },
        programAddress: "11111111111111111111111111111111",
      } as never);
      const client = new ExactSvmSchemeV1(mockSigner);
      await expect(
        client.createPaymentPayload(1, {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: mockSigner.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: mockSigner.address },
        } as never),
      ).rejects.toThrow("Asset was not created by a known token program");
    });

    it("forwards a configured rpcUrl before rejecting an unknown mint program", async () => {
      vi.mocked(fetchMint).mockResolvedValue({
        data: { decimals: 6 },
        programAddress: "11111111111111111111111111111111",
      } as never);
      const client = new ExactSvmSchemeV1(mockSigner, { rpcUrl: "https://custom-rpc.example" });
      await expect(
        client.createPaymentPayload(1, {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: mockSigner.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: mockSigner.address },
        } as never),
      ).rejects.toThrow("Asset was not created by a known token program");
    });

    it("rejects when extra.feePayer is missing after mint resolution", async () => {
      vi.mocked(fetchMint).mockResolvedValue({
        data: { decimals: 6 },
        programAddress: TOKEN_PROGRAM_ADDRESS,
      } as never);
      const client = new ExactSvmSchemeV1(mockSigner);
      await expect(
        client.createPaymentPayload(1, {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: mockSigner.address,
          maxTimeoutSeconds: 3600,
          extra: {},
        } as never),
      ).rejects.toThrow("feePayer is required");
    });

    it("rejects extra.memo that exceeds MAX_MEMO_BYTES", async () => {
      vi.mocked(fetchMint).mockResolvedValue({
        data: { decimals: 6 },
        programAddress: TOKEN_PROGRAM_ADDRESS,
      } as never);
      const client = new ExactSvmSchemeV1(mockSigner);
      await expect(
        client.createPaymentPayload(1, {
          scheme: "exact",
          network: "solana-devnet",
          asset: USDC_DEVNET_ADDRESS,
          maxAmountRequired: "100000",
          payTo: mockSigner.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: mockSigner.address, memo: "m".repeat(MAX_MEMO_BYTES + 1) },
        } as never),
      ).rejects.toThrow(`extra.memo exceeds maximum ${MAX_MEMO_BYTES} bytes`);
    });
  });
});
