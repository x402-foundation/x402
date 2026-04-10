import { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExactOpenPaymentsScheme } from "../../src/exact/facilitator/scheme";
import { InMemoryPaymentUrlCache } from "../../src/types";
import { generatePaymentUrlCacheKey } from "../../src/utils";
import type { OpenPaymentsFacilitatorConfig } from "../../src/types";

const mockOpenPaymentsClient = {
  grant: {
    request: vi.fn(),
  },
  incomingPayment: {
    getPublic: vi.fn(),
    get: vi.fn(),
  },
};

global.fetch = vi.fn();

const makePayload = (overrides?: Partial<PaymentPayload["payload"]>): PaymentPayload => ({
  x402Version: 2,
  resource: {
    url: "https://api.example.com/resource",
    description: "Test resource",
    mimeType: "application/json",
  },
  accepted: {
    scheme: "exact",
    network: "ilp:openpayments",
    amount: "100",
    asset: "USD",
    payTo: "https://wallet.example.com/alice",
    maxTimeoutSeconds: 60,
    extra: {},
  },
  payload: {
    incomingPaymentUrl: "https://wallet.example.com/alice/incoming-payments/payment_123",
    ...overrides,
  },
});

const makeRequirements = (overrides?: Partial<PaymentRequirements>): PaymentRequirements => ({
  scheme: "exact",
  network: "ilp:openpayments",
  amount: "100",
  asset: "USD",
  payTo: "https://wallet.example.com/alice",
  maxTimeoutSeconds: 60,
  extra: {},
  ...overrides,
});

const makeCompletedPayment = (amount = "100") => ({
  id: "https://wallet.example.com/alice/incoming-payments/payment_123",
  completed: true,
  receivedAmount: { value: amount, assetCode: "USD", assetScale: 2 },
  createdAt: new Date().toISOString(),
  walletAddress: "https://wallet.example.com/alice",
});

/**
 * Back-date a cache entry by key so it appears older than the idempotency window.
 */
function backdateEntry(cache: InMemoryPaymentUrlCache, key: string, ageMs: number): void {
  const entry = cache.get(key);
  if (!entry) throw new Error(`Cache key not found: ${key}`);
  cache.set(key, { ...entry, timestamp: Date.now() - ageMs });
}

describe("ExactOpenPaymentsScheme (Facilitator)", () => {
  let facilitator: ExactOpenPaymentsScheme;
  let config: OpenPaymentsFacilitatorConfig;
  let cache: InMemoryPaymentUrlCache;

  beforeEach(() => {
    cache = new InMemoryPaymentUrlCache();
    config = {
      keyId: "test-key-id",
      privateKey: "dGVzdF9wcml2YXRlX2tleQ==",
      walletAddress: "https://wallet.example.com/facilitator",
      usedPaymentUrlsCache: cache,
      maxRetries: 0,
      retryDelayMs: 0,
      cacheEvictionTtlMs: 100_000,
    };
    facilitator = new ExactOpenPaymentsScheme(config);
    (facilitator as any).openPaymentsClient = mockOpenPaymentsClient;
    vi.clearAllMocks();
    // Default mocks for the 3-step grant flow used by every verify call
    mockOpenPaymentsClient.incomingPayment.getPublic.mockResolvedValue({
      authServer: "https://auth.example.com",
    });
    mockOpenPaymentsClient.grant.request.mockResolvedValue({
      access_token: {
        value: "test-read-token",
        manage: "https://auth.example.com/token/1",
        expires_in: 3600,
      },
    });
  });

  describe("construction", () => {
    it("should expose correct scheme and caipFamily", () => {
      expect(facilitator.scheme).toBe("exact");
      expect(facilitator.caipFamily).toBe("ilp:openpayments");
    });
  });

  describe("getExtra", () => {
    it("should return undefined", () => {
      expect(facilitator.getExtra("ilp:openpayments")).toBeUndefined();
    });
  });

  describe("getSigners", () => {
    it("should return the facilitator wallet address", () => {
      expect(facilitator.getSigners("ilp:openpayments")).toEqual([config.walletAddress]);
    });
  });

  describe("verify", () => {
    it("should accept a valid completed payment", async () => {
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue(makeCompletedPayment("100"));
      const result = await facilitator.verify(makePayload(), makeRequirements());
      expect(result.isValid).toBe(true);
      expect(result.payer).toBeUndefined();
    });

    it("should request incoming-payment:read and read-all grant scoped to payTo wallet identifier", async () => {
      const payTo = "https://wallet.example.com/merchant";
      const incomingPaymentUrl = `${payTo}/incoming-payments/payment_456`;
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue({
        ...makeCompletedPayment("100"),
        id: incomingPaymentUrl,
        walletAddress: payTo,
      });
      const requirements = makeRequirements({ payTo });
      await facilitator.verify(makePayload({ incomingPaymentUrl }), requirements);
      expect(mockOpenPaymentsClient.grant.request).toHaveBeenCalledWith(
        { url: "https://auth.example.com" },
        {
          access_token: {
            access: [
              {
                type: "incoming-payment",
                actions: ["read", "read-all"],
                identifier: payTo,
              },
            ],
          },
        },
      );
    });

    it("should reject when scheme does not match", async () => {
      const payload = makePayload();
      payload.accepted.scheme = "wrong_scheme";
      const result = await facilitator.verify(payload, makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("unsupported_scheme");
    });

    it("should reject when requirements scheme does not match", async () => {
      const result = await facilitator.verify(
        makePayload(),
        makeRequirements({ scheme: "wrong_scheme" }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("unsupported_scheme");
    });

    it("should reject when incomingPaymentUrl is missing", async () => {
      const payload = makePayload();
      payload.payload["incomingPaymentUrl"] = undefined;
      const result = await facilitator.verify(payload, makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(
        "invalid_exact_openpayments_payload_missing_incoming_payment_url",
      );
    });

    it("should reject when incoming payment URL host does not match payTo host", async () => {
      const payload = makePayload({
        incomingPaymentUrl: "https://other-bank.example.com/incoming-payments/123",
      });
      const result = await facilitator.verify(payload, makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_openpayments_payload_wallet_mismatch");
    });

    it("should reject when payment walletAddress from server does not match payTo", async () => {
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue({
        ...makeCompletedPayment("100"),
        walletAddress: "https://wallet.example.com/bob",
      });
      const result = await facilitator.verify(makePayload(), makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_openpayments_payload_wallet_mismatch");
    });

    it("should reject when payment walletAddress is absent from server response", async () => {
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue({
        ...makeCompletedPayment("100"),
        walletAddress: undefined,
      });
      const result = await facilitator.verify(makePayload(), makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_openpayments_payload_wallet_mismatch");
    });

    it("should reject when incomingPaymentUrl is not a valid URL", async () => {
      const payload = makePayload({ incomingPaymentUrl: "not-a-url" });
      const result = await facilitator.verify(payload, makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_openpayments_payload_invalid_url");
    });

    it("should reject when payment is not completed", async () => {
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue({
        ...makeCompletedPayment("100"),
        completed: false,
      });
      const result = await facilitator.verify(makePayload(), makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_openpayments_payload_not_completed");
    });

    it("should reject when received amount does not match requirements", async () => {
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue(makeCompletedPayment("50"));
      const result = await facilitator.verify(makePayload(), makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_openpayments_payload_amount_mismatch");
    });

    it("should reject when payment asset code does not match requirements", async () => {
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue({
        ...makeCompletedPayment("100"),
        receivedAmount: { value: "100", assetCode: "EUR", assetScale: 2 },
      });
      const result = await facilitator.verify(makePayload(), makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_openpayments_payload_asset_mismatch");
    });

    it("should reject when payment asset scale does not match requirements.extra.assetScale", async () => {
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue({
        ...makeCompletedPayment("100"),
        receivedAmount: { value: "100", assetCode: "USD", assetScale: 4 },
      });
      const result = await facilitator.verify(
        makePayload(),
        makeRequirements({ extra: { assetScale: 2 } }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_openpayments_payload_asset_scale_mismatch");
    });

    it("should accept when requirements.extra.assetScale matches payment scale", async () => {
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue(makeCompletedPayment("100"));
      const result = await facilitator.verify(
        makePayload(),
        makeRequirements({ extra: { assetScale: 2 } }),
      );
      expect(result.isValid).toBe(true);
    });

    it("should reject when payment is too old", async () => {
      const oldDate = new Date(Date.now() - 120 * 1000).toISOString();
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue({
        ...makeCompletedPayment("100"),
        createdAt: oldDate,
      });
      const result = await facilitator.verify(
        makePayload(),
        makeRequirements({ maxTimeoutSeconds: 60 }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_openpayments_payload_too_old");
    });

    it("should reject replay after idempotency window", async () => {
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue(makeCompletedPayment("100"));

      // First verify — succeeds and caches the URL
      await facilitator.verify(makePayload(), makeRequirements());

      // Back-date the cache entry beyond the idempotency window
      const key = generatePaymentUrlCacheKey(
        "https://wallet.example.com/alice/incoming-payments/payment_123",
        "https://api.example.com/resource",
      );
      backdateEntry(cache, key, 10000);

      const result = await facilitator.verify(makePayload(), makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_openpayments_payload_url_already_used");
    });

    it("should allow idempotent retry within the idempotency window", async () => {
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue(makeCompletedPayment("100"));

      // First verify
      const first = await facilitator.verify(makePayload(), makeRequirements());
      expect(first.isValid).toBe(true);

      // Immediate second verify — within idempotency window — should also pass
      const second = await facilitator.verify(makePayload(), makeRequirements());
      expect(second.isValid).toBe(true);
    });

    it("should throw when SDK throws a non-auth error", async () => {
      mockOpenPaymentsClient.incomingPayment.get.mockRejectedValue(
        new Error("Network connection refused"),
      );
      await expect(facilitator.verify(makePayload(), makeRequirements())).rejects.toThrow(
        "Failed to retrieve incoming payment",
      );
    });

    it("should return not_completed when payment stays pending after retries", async () => {
      // retryWithBackoff keeps seeing non-COMPLETED until RetryConditionNotMetError
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue({
        ...makeCompletedPayment("100"),
        completed: false,
      });
      const result = await facilitator.verify(makePayload(), makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_openpayments_payload_not_completed");
    });

    it("should throw when incoming payment response is missing createdAt", async () => {
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue({
        ...makeCompletedPayment("100"),
        createdAt: undefined,
      });
      await expect(facilitator.verify(makePayload(), makeRequirements())).rejects.toThrow(
        "Incoming payment response missing createdAt",
      );
    });

    it("should evict stale cache entries after successful verify", async () => {
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue(makeCompletedPayment("100"));

      // First verify seeds the cache
      await facilitator.verify(makePayload(), makeRequirements());

      const key = generatePaymentUrlCacheKey(
        "https://wallet.example.com/alice/incoming-payments/payment_123",
        "https://api.example.com/resource",
      );
      // Back-date entry well beyond cacheEvictionTtlMs (100_000 ms)
      backdateEntry(cache, key, 200_000);

      // A different payment URL so the cache check doesn't block us
      const payload2 = makePayload({
        incomingPaymentUrl: "https://wallet.example.com/alice/incoming-payments/payment_different",
      });
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue({
        ...makeCompletedPayment("100"),
        url: "https://wallet.example.com/alice/incoming-payments/payment_different",
      });
      await facilitator.verify(payload2, makeRequirements());

      // Original stale entry should have been evicted
      expect(cache.get(key)).toBeUndefined();
    });

    it("should use empty string resource URL when payload.resource is missing", async () => {
      const payload = makePayload();
      payload.resource = undefined;
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue(makeCompletedPayment("100"));

      const result = await facilitator.verify(payload, makeRequirements());
      // Verify still passes — empty resource URL is a valid (though degenerate) cache key
      expect(result.isValid).toBe(true);
    });

    it("should throw when getPublic response is missing authServer", async () => {
      mockOpenPaymentsClient.incomingPayment.getPublic.mockResolvedValueOnce({ authServer: "" });
      await expect(facilitator.verify(makePayload(), makeRequirements())).rejects.toThrow(
        "did not return an authServer URL",
      );
    });

    it("should call getPublic on every verify to discover the auth server", async () => {
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue(makeCompletedPayment("100"));
      const payload2 = makePayload({
        incomingPaymentUrl: "https://wallet.example.com/alice/incoming-payments/payment_456",
      });

      await facilitator.verify(makePayload(), makeRequirements());
      await facilitator.verify(payload2, makeRequirements());

      expect(mockOpenPaymentsClient.incomingPayment.getPublic).toHaveBeenCalledTimes(2);
    });
  });

  describe("settle", () => {
    it("should return success with incomingPaymentUrl as transaction (no-op)", async () => {
      const result = await facilitator.settle(makePayload(), makeRequirements());
      expect(result.success).toBe(true);
      expect(result.transaction).toBe(
        "https://wallet.example.com/alice/incoming-payments/payment_123",
      );
      expect(result.network).toBe("ilp:openpayments");
    });
  });
});
