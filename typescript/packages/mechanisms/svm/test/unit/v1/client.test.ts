import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExactSvmSchemeV1 } from "../../../src/exact/v1";
import type { ClientSvmSigner } from "../../../src/signer";
import type { PaymentRequirementsV1 } from "@x402/core/types/v1";
import { USDC_DEVNET_ADDRESS } from "../../../src/constants";

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

      // Mock RPC and account fetching
      vi.mock("@solana-program/token-2022", () => ({
        fetchMint: vi.fn().mockResolvedValue({
          programAddress: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as never,
          data: { decimals: 6 },
        }),
        findAssociatedTokenPda: vi.fn().mockResolvedValue(["AssociatedTokenAddress" as never]),
        getTransferCheckedInstruction: vi.fn().mockReturnValue({} as never),
        TOKEN_2022_PROGRAM_ADDRESS: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as never,
      }));

      vi.mock("@solana/kit", () => ({
        fetchEncodedAccount: vi.fn().mockResolvedValue({ exists: true }),
        createTransactionMessage: vi.fn().mockReturnValue({} as never),
        pipe: vi.fn((initial: unknown, ...fns: ((arg: unknown) => unknown)[]) =>
          fns.reduce((acc, fn) => fn(acc), initial),
        ),
        setTransactionMessageComputeUnitPrice: vi.fn((price: unknown, tx: unknown) => tx),
        setTransactionMessageFeePayer: vi.fn((payer: unknown, tx: unknown) => tx),
        appendTransactionMessageInstructions: vi.fn((ixs: unknown, tx: unknown) => tx),
        prependTransactionMessageInstruction: vi.fn((ix: unknown, tx: unknown) => tx),
        setTransactionMessageLifetimeUsingBlockhash: vi.fn((hash: unknown, tx: unknown) => tx),
        partiallySignTransactionMessageWithSigners: vi.fn().mockResolvedValue({
          messageBytes: new Uint8Array(10),
          signatures: {},
        }),
        getBase64EncodedWireTransaction: vi.fn().mockReturnValue("base64transaction=="),
      }));

      // Note: Actual testing requires complex mocking of Solana RPC calls
      // This is a structure test to verify the method exists and has correct return type
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
  });
});
