import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExactSvmScheme } from "../../src/exact/facilitator/scheme";
import { ExactSvmSchemeV1 } from "../../src/exact/v1/facilitator/scheme";
import { SettlementCache } from "../../src/settlement-cache";
import type { FacilitatorSvmSigner } from "../../src/signer";
import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";
import type { PaymentPayloadV1, PaymentRequirementsV1 } from "@x402/core/types/v1";
import { USDC_DEVNET_ADDRESS, SOLANA_DEVNET_CAIP2 } from "../../src/constants";

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
      expect(result.invalidReason).toBe("unsupported_scheme");
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
      expect(result.invalidReason).toBe("network_mismatch");
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
      expect(result.errorReason).toBe("unsupported_scheme");
      expect(result.network).toBe(SOLANA_DEVNET_CAIP2);
    });
  });

  describe("duplicate settlement cache", () => {
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
      const facilitator = new ExactSvmScheme(mockSigner);
      setupSettleMocks(facilitator);

      const payload = makePayload("sameTransactionBase64==");

      const result1 = await facilitator.settle(payload, requirements);
      expect(result1.success).toBe(true);

      const result2 = await facilitator.settle(payload, requirements);
      expect(result2.success).toBe(false);
      expect(result2.errorReason).toBe("duplicate_settlement");
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
      vi.spyOn(v2, "verify").mockResolvedValue({
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
