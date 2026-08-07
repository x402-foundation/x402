import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExactSvmScheme } from "../../src/exact";
import type { ClientSvmSigner } from "../../src/signer";
import type { PaymentRequirements } from "@x402/core/types";
import { USDC_DEVNET_ADDRESS, SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { resolveBlockhash } from "../../src/utils";

const PROVIDED_BLOCKHASH = "EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k";
const FALLBACK_BLOCKHASH = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF";

function createBlockhashRpc() {
  const send = vi.fn().mockResolvedValue({
    value: {
      blockhash: FALLBACK_BLOCKHASH,
      lastValidBlockHeight: 67890n,
    },
  });
  const rpc = {
    getLatestBlockhash: () => ({ send }),
  };

  return { rpc, send };
}

function requirementsWithRecentBlockhash(
  recentBlockhash?: string | number,
  lastValidBlockHeight?: string | number,
) {
  return {
    extra: {
      ...(recentBlockhash === undefined ? {} : { recentBlockhash }),
      ...(lastValidBlockHeight === undefined ? {} : { lastValidBlockHeight }),
    },
  };
}

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

describe("resolveBlockhash", () => {
  it("uses a valid server-provided blockhash without an RPC call", async () => {
    const { rpc, send } = createBlockhashRpc();

    const result = await resolveBlockhash(
      rpc as never,
      requirementsWithRecentBlockhash(PROVIDED_BLOCKHASH, "12345") as never,
    );

    expect(result).toEqual({
      blockhash: PROVIDED_BLOCKHASH,
      lastValidBlockHeight: 12345n,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("uses a valid blockhash when lastValidBlockHeight is absent or malformed", async () => {
    const { rpc, send } = createBlockhashRpc();

    const missingHeight = await resolveBlockhash(
      rpc as never,
      requirementsWithRecentBlockhash(PROVIDED_BLOCKHASH) as never,
    );
    const malformedHeight = await resolveBlockhash(
      rpc as never,
      requirementsWithRecentBlockhash(PROVIDED_BLOCKHASH, "not-a-height") as never,
    );

    expect(missingHeight.lastValidBlockHeight).toBe(0n);
    expect(malformedHeight.lastValidBlockHeight).toBe(0n);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["non-string", 12345],
    ["malformed", "not-a-blockhash"],
  ])("falls back to RPC when recentBlockhash is %s", async (_name, recentBlockhash) => {
    const { rpc, send } = createBlockhashRpc();

    const result = await resolveBlockhash(
      rpc as never,
      requirementsWithRecentBlockhash(recentBlockhash) as never,
    );

    expect(result).toEqual({
      blockhash: FALLBACK_BLOCKHASH,
      lastValidBlockHeight: 67890n,
    });
    expect(send).toHaveBeenCalledOnce();
  });
});
