import { describe, expect, it, vi, beforeEach } from "vitest";
import { ExactOpenPaymentsScheme } from "../../src/exact/server/scheme";
import type { OpenPaymentsServerConfig } from "../../src/types";
import type { PaymentRequirements, Price } from "@x402/core/types";

global.fetch = vi.fn();

const makeConfig = (): OpenPaymentsServerConfig => ({
  walletAddress: "https://wallet.example.com/server",
});

const makeRequirements = (overrides?: Partial<PaymentRequirements>): PaymentRequirements => ({
  scheme: "exact",
  network: "ilp:openpayments",
  amount: "100",
  asset: "USD",
  payTo: "",
  maxTimeoutSeconds: 300,
  extra: {},
  ...overrides,
});

const makeSupportedKind = () => ({
  x402Version: 2,
  scheme: "exact",
  network: "ilp:openpayments" as const,
});

/** Returns a mock fetch response with the given wallet asset info. */
function mockWalletFetch(assetCode: string, assetScale: number) {
  vi.mocked(global.fetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      resourceServer: "https://resource.example.com",
      authServer: "https://auth.example.com",
      assetCode,
      assetScale,
    }),
  });
}

describe("ExactOpenPaymentsScheme (Server)", () => {
  let server: ExactOpenPaymentsScheme;

  beforeEach(() => {
    server = new ExactOpenPaymentsScheme(makeConfig());
    vi.clearAllMocks();
  });

  describe("construction", () => {
    it("should expose correct scheme", () => {
      expect(server.scheme).toBe("exact");
    });
  });

  describe("enhancePaymentRequirements", () => {
    it("should set payTo from config.walletAddress", async () => {
      const requirements = makeRequirements({ payTo: "" });
      const result = await server.enhancePaymentRequirements(requirements, makeSupportedKind(), []);
      expect(result.payTo).toBe("https://wallet.example.com/server");
    });

    it("should preserve existing requirements fields", async () => {
      const requirements = makeRequirements({ amount: "500", asset: "EUR" });
      const result = await server.enhancePaymentRequirements(requirements, makeSupportedKind(), []);
      expect(result.amount).toBe("500");
      expect(result.asset).toBe("EUR");
    });

    it("should not include serverWalletAddress in extra", async () => {
      const requirements = makeRequirements();
      const result = await server.enhancePaymentRequirements(requirements, makeSupportedKind(), []);
      expect(result.extra).not.toHaveProperty("serverWalletAddress");
    });
  });

  describe("parsePrice", () => {
    describe("Case 1 — plain string/number (human-readable decimal)", () => {
      it("should convert decimal money string using wallet discovery", async () => {
        mockWalletFetch("USD", 2);
        const result = await server.parsePrice("1.50", "ilp:openpayments");
        expect(result.amount).toBe("150");
        expect(result.asset).toBe("USD");
        expect(result.extra).toEqual({ assetScale: 2 });
      });

      it("should strip leading dollar sign from money string", async () => {
        mockWalletFetch("USD", 2);
        const result = await server.parsePrice("$2.00", "ilp:openpayments");
        expect(result.amount).toBe("200");
        expect(result.asset).toBe("USD");
        expect(result.extra).toEqual({ assetScale: 2 });
      });

      it("should hard fail if wallet discovery fails", async () => {
        vi.mocked(global.fetch).mockRejectedValueOnce(new Error("network error"));
        await expect(server.parsePrice(1, "ilp:openpayments")).rejects.toThrow("network error");
      });

      it("should throw if money format is invalid", async () => {
        await expect(server.parsePrice("not-a-number", "ilp:openpayments")).rejects.toThrow(
          "Invalid money format",
        );
      });

      it("should use custom money parser when registered", async () => {
        const customParser = vi.fn().mockResolvedValue({ amount: "9999", asset: "EUR", extra: {} });
        server.registerMoneyParser(customParser);
        const result = await server.parsePrice(1, "ilp:openpayments");
        expect(result.amount).toBe("9999");
        expect(result.asset).toBe("EUR");
        expect(customParser).toHaveBeenCalledWith(1, "ilp:openpayments");
      });

      it("should fall through to default when custom parser returns null", async () => {
        const customParser = vi.fn().mockResolvedValue(null);
        server.registerMoneyParser(customParser);
        mockWalletFetch("USD", 2);
        const result = await server.parsePrice(1, "ilp:openpayments");
        expect(result.amount).toBe("100");
        expect(result.extra).toEqual({ assetScale: 2 });
      });

      it("should cache wallet discovery result across multiple calls", async () => {
        vi.mocked(global.fetch).mockResolvedValue({
          ok: true,
          json: async () => ({
            resourceServer: "https://resource.example.com",
            authServer: "https://auth.example.com",
            assetCode: "USD",
            assetScale: 2,
          }),
        });
        await server.parsePrice(1, "ilp:openpayments");
        await server.parsePrice(2, "ilp:openpayments");
        expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
      });
    });

    describe("Case 2 — AssetAmount with asset code only (no scale)", () => {
      it("should throw if AssetAmount is missing asset", async () => {
        const price = { amount: "250" } as unknown as Price;
        await expect(server.parsePrice(price, "ilp:openpayments")).rejects.toThrow(
          "Asset code must be specified",
        );
      });

      it("should convert amount as human-readable decimal using wallet scale", async () => {
        mockWalletFetch("USD", 2);
        const result = await server.parsePrice(
          { amount: "1.50", asset: "USD" },
          "ilp:openpayments",
        );
        expect(result.amount).toBe("150");
        expect(result.asset).toBe("USD");
        expect(result.extra).toEqual({ assetScale: 2 });
      });

      it("should use wallet asset code in the result", async () => {
        mockWalletFetch("USD", 9);
        const result = await server.parsePrice(
          { amount: "0.01", asset: "USD" },
          "ilp:openpayments",
        );
        expect(result.amount).toBe("10000000");
        expect(result.asset).toBe("USD");
        expect(result.extra).toEqual({ assetScale: 9 });
      });

      it("should validate asset code case-insensitively", async () => {
        mockWalletFetch("USD", 2);
        const result = await server.parsePrice(
          { amount: "1.00", asset: "usd" },
          "ilp:openpayments",
        );
        expect(result.amount).toBe("100");
      });

      it("should throw on asset code mismatch", async () => {
        mockWalletFetch("USD", 2);
        await expect(
          server.parsePrice({ amount: "1.00", asset: "EUR" }, "ilp:openpayments"),
        ).rejects.toThrow('Asset code mismatch: provided "EUR" but wallet uses "USD"');
      });

      it("should hard fail if wallet discovery fails", async () => {
        vi.mocked(global.fetch).mockRejectedValueOnce(new Error("network error"));
        await expect(
          server.parsePrice({ amount: "1.00", asset: "USD" }, "ilp:openpayments"),
        ).rejects.toThrow("network error");
      });

      it("should throw if amount is not a valid decimal", async () => {
        mockWalletFetch("USD", 2);
        await expect(
          server.parsePrice({ amount: "not-a-number", asset: "USD" }, "ilp:openpayments"),
        ).rejects.toThrow("Invalid amount format");
      });

      it("should throw if decimal amount is too small for the wallet scale", async () => {
        mockWalletFetch("USD", 2);
        await expect(
          server.parsePrice({ amount: "0.001", asset: "USD" }, "ilp:openpayments"),
        ).rejects.toThrow("too small for asset scale");
      });

      it("should preserve other extra fields alongside assetScale", async () => {
        mockWalletFetch("USD", 2);
        const result = await server.parsePrice(
          { amount: "1.00", asset: "USD", extra: { someKey: "someValue" } },
          "ilp:openpayments",
        );
        expect(result.extra).toEqual({ someKey: "someValue", assetScale: 2 });
      });

      it("should share wallet discovery cache with Case 1 calls", async () => {
        vi.mocked(global.fetch).mockResolvedValue({
          ok: true,
          json: async () => ({
            resourceServer: "https://resource.example.com",
            authServer: "https://auth.example.com",
            assetCode: "USD",
            assetScale: 2,
          }),
        });
        await server.parsePrice("1.00", "ilp:openpayments");
        await server.parsePrice({ amount: "1.00", asset: "USD" }, "ilp:openpayments");
        expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
      });
    });

    describe("Case 3 — AssetAmount with asset code and scale", () => {
      it("should pass amount through unchanged when input scale matches wallet scale", async () => {
        mockWalletFetch("USD", 2);
        const result = await server.parsePrice(
          { amount: "100", asset: "USD", extra: { assetScale: 2 } },
          "ilp:openpayments",
        );
        expect(result.amount).toBe("100");
        expect(result.asset).toBe("USD");
        expect(result.extra).toEqual({ assetScale: 2 });
      });

      it("should adapt amount upward when wallet scale is larger than input scale", async () => {
        mockWalletFetch("USD", 9);
        const result = await server.parsePrice(
          { amount: "100", asset: "USD", extra: { assetScale: 2 } },
          "ilp:openpayments",
        );
        // 100 cents * 10^(9-2) = 100 * 10_000_000 = 1_000_000_000
        expect(result.amount).toBe("1000000000");
        expect(result.asset).toBe("USD");
        expect(result.extra).toEqual({ assetScale: 9 });
      });

      it("should throw when wallet scale is smaller than input scale (precision loss)", async () => {
        mockWalletFetch("USD", 2);
        await expect(
          server.parsePrice(
            { amount: "1000", asset: "USD", extra: { assetScale: 6 } },
            "ilp:openpayments",
          ),
        ).rejects.toThrow(
          "Cannot adapt amount from scale 6 to wallet scale 2: would lose precision",
        );
      });

      it("should throw on asset code mismatch", async () => {
        mockWalletFetch("USD", 2);
        await expect(
          server.parsePrice(
            { amount: "100", asset: "EUR", extra: { assetScale: 2 } },
            "ilp:openpayments",
          ),
        ).rejects.toThrow('Asset code mismatch: provided "EUR" but wallet uses "USD"');
      });

      it("should hard fail if wallet discovery fails", async () => {
        vi.mocked(global.fetch).mockRejectedValueOnce(new Error("network error"));
        await expect(
          server.parsePrice(
            { amount: "100", asset: "USD", extra: { assetScale: 2 } },
            "ilp:openpayments",
          ),
        ).rejects.toThrow("network error");
      });

      it("should throw if amount is not an integer string", async () => {
        mockWalletFetch("USD", 9);
        await expect(
          server.parsePrice(
            { amount: "0.01", asset: "USD", extra: { assetScale: 2 } },
            "ilp:openpayments",
          ),
        ).rejects.toThrow("not a valid integer");
      });

      it("should preserve other extra fields alongside assetScale", async () => {
        mockWalletFetch("USD", 9);
        const result = await server.parsePrice(
          { amount: "100", asset: "USD", extra: { assetScale: 2, someKey: "someValue" } },
          "ilp:openpayments",
        );
        expect(result.extra).toEqual({ someKey: "someValue", assetScale: 9 });
      });

      it("should validate asset code case-insensitively", async () => {
        mockWalletFetch("USD", 2);
        const result = await server.parsePrice(
          { amount: "100", asset: "usd", extra: { assetScale: 2 } },
          "ilp:openpayments",
        );
        expect(result.amount).toBe("100");
      });
    });

    describe("floating-point precision", () => {
      it("should produce exact integer for 0.07 at scale 8 (would be 6999999 with float arithmetic)", async () => {
        mockWalletFetch("USD", 8);
        const result = await server.parsePrice("0.07", "ilp:openpayments");
        expect(result.amount).toBe("7000000");
      });

      it("should produce exact integer for { amount: '0.07', asset } at scale 8", async () => {
        mockWalletFetch("USD", 8);
        const result = await server.parsePrice(
          { amount: "0.07", asset: "USD" },
          "ilp:openpayments",
        );
        expect(result.amount).toBe("7000000");
      });

      it("should handle number input 1e-8 (scientific notation) at scale 8", async () => {
        mockWalletFetch("USD", 8);
        const result = await server.parsePrice(1e-8, "ilp:openpayments");
        expect(result.amount).toBe("1");
      });

      it("should truncate excess fractional digits (floor semantics)", async () => {
        mockWalletFetch("USD", 2);
        // "1.999" at scale 2: truncates to "1.99" = 199
        const result = await server.parsePrice("1.999", "ilp:openpayments");
        expect(result.amount).toBe("199");
      });
    });
  });

  describe("registerMoneyParser", () => {
    it("should return the server instance for chaining", () => {
      const parser = vi.fn().mockResolvedValue(null);
      const result = server.registerMoneyParser(parser);
      expect(result).toBe(server);
    });
  });
});
