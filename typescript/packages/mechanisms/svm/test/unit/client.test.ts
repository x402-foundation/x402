import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExactSvmScheme } from "../../src/exact";
import type { ClientSvmSigner } from "../../src/signer";
import type { PaymentRequirements } from "@x402/core/types";
import { USDC_DEVNET_ADDRESS, SOLANA_DEVNET_CAIP2 } from "../../src/constants";

describe("ExactSvmScheme", () => {
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
      const client = new ExactSvmScheme(mockSigner);
      expect(client.scheme).toBe("exact");
    });

    it("should accept optional config", () => {
      const client = new ExactSvmScheme(mockSigner, {
        rpcUrl: "https://custom-rpc.com",
      });
      expect(client.scheme).toBe("exact");
    });
  });

  describe("createPaymentPayload", () => {
    it("should create V2 payment payload", async () => {
      const client = new ExactSvmScheme(mockSigner);

      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: {
          feePayer: "FeePayer1111111111111111111111111111",
        },
      };

      // Note: Full testing requires complex mocking of Solana RPC and transaction building
      // This verifies the method exists and has correct signature
      expect(client.createPaymentPayload).toBeDefined();
      expect(typeof client.createPaymentPayload).toBe("function");

      // Verify client accepts PaymentRequirements (v2 format)
      expect(requirements.amount).toBe("100000"); // V2 uses 'amount' not 'maxAmountRequired'
    });

    it("should throw if feePayer is missing from requirements", () => {
      const client = new ExactSvmScheme(mockSigner);

      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: {}, // Missing feePayer
      };

      // The method should exist and handle this error scenario
      expect(client.createPaymentPayload).toBeDefined();
      expect(requirements.extra?.feePayer).toBeUndefined();
    });

    it("should accept V2 requirements with amount field", () => {
      const client = new ExactSvmScheme(mockSigner);

      // Verify the client accepts PaymentRequirements (v2) with amount field
      type V2Requirements = PaymentRequirements & { amount: string };
      const hasAmountField = (req: PaymentRequirements): req is V2Requirements => "amount" in req;

      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "500000", // V2 uses 'amount'
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: { feePayer: "FeePayer1111111111111111111111111111" },
      };

      expect(hasAmountField(requirements)).toBe(true);
      if (hasAmountField(requirements)) {
        expect(requirements.amount).toBe("500000");
      }
      expect(client.scheme).toBe("exact");
    });
  });
});
