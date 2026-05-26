import { describe, it, expect } from "vitest";
import {
  USDC_PUBNET_ADDRESS,
  USDC_TESTNET_ADDRESS,
  STELLAR_PUBNET_CAIP2,
  STELLAR_TESTNET_CAIP2,
} from "../../src/constants";
import { ExactStellarScheme } from "../../src/exact/server/scheme";

describe("ExactStellarScheme", () => {
  const server = new ExactStellarScheme();

  describe("parsePrice", () => {
    describe("Stellar Pubnet network", () => {
      const network = STELLAR_PUBNET_CAIP2;

      it("should parse dollar string prices", async () => {
        const result = await server.parsePrice("$0.10", network);
        expect(result.amount).toBe("1000000"); // 0.10 USDC = 1000000 smallest units (7 decimals)
        expect(result.asset).toBe(USDC_PUBNET_ADDRESS);
        expect(result.extra).toEqual({});
      });

      it("should parse simple number string prices", async () => {
        const result = await server.parsePrice("0.10", network);
        expect(result.amount).toBe("1000000");
        expect(result.asset).toBe(USDC_PUBNET_ADDRESS);
      });

      it("should parse number prices", async () => {
        const result = await server.parsePrice(0.1, network);
        expect(result.amount).toBe("1000000");
        expect(result.asset).toBe(USDC_PUBNET_ADDRESS);
      });

      it("should handle larger amounts", async () => {
        const result = await server.parsePrice("100.50", network);
        expect(result.amount).toBe("1005000000"); // 100.50 USDC
      });

      it("should handle whole numbers", async () => {
        const result = await server.parsePrice("1", network);
        expect(result.amount).toBe("10000000"); // 1 USDC (7 decimals)
      });

      it("should avoid floating-point rounding error", async () => {
        const result = await server.parsePrice("$4.02", network);
        expect(result.amount).toBe("40200000"); // 4.02 USDC
      });
    });

    describe("Stellar Testnet network", () => {
      const network = STELLAR_TESTNET_CAIP2;

      it("should use Testnet USDC address", async () => {
        const result = await server.parsePrice("1.00", network);
        expect(result.asset).toBe(USDC_TESTNET_ADDRESS);
        expect(result.amount).toBe("10000000");
      });
    });

    describe("pre-parsed price objects", () => {
      it("should handle pre-parsed price objects with asset", async () => {
        const result = await server.parsePrice(
          {
            amount: "123456",
            asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
            extra: { foo: "bar" },
          },
          STELLAR_PUBNET_CAIP2,
        );
        expect(result.amount).toBe("123456");
        expect(result.asset).toBe("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA");
        expect(result.extra).toEqual({ foo: "bar" });
      });

      it("should throw for price objects without asset", async () => {
        await expect(
          async () => await server.parsePrice({ amount: "123456" } as never, STELLAR_PUBNET_CAIP2),
        ).rejects.toThrow("Asset address must be specified");
      });
    });

    describe("error cases", () => {
      it("should throw for invalid money formats", async () => {
        await expect(
          async () => await server.parsePrice("not-a-price!", STELLAR_PUBNET_CAIP2),
        ).rejects.toThrow("Invalid money format");
      });

      it("should throw for invalid amounts", async () => {
        await expect(
          async () => await server.parsePrice("abc", STELLAR_PUBNET_CAIP2),
        ).rejects.toThrow("Invalid money format");
      });
    });
  });

  describe("enhancePaymentRequirements", () => {
    it("should add areFeesSponsored from facilitator to payment requirements", async () => {
      const requirements = {
        scheme: "exact",
        network: STELLAR_PUBNET_CAIP2,
        asset: USDC_PUBNET_ADDRESS,
        amount: "1000000",
        payTo: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        maxTimeoutSeconds: 3600,
        extra: {},
      };

      const result = await server.enhancePaymentRequirements(
        requirements as never,
        {
          x402Version: 2,
          scheme: "exact",
          network: STELLAR_PUBNET_CAIP2,
          extra: { areFeesSponsored: true },
        },
        [],
      );

      expect(result).toEqual({
        ...requirements,
        extra: { areFeesSponsored: true },
      });
    });

    it("should preserve existing extra fields", async () => {
      const requirements = {
        scheme: "exact",
        network: STELLAR_TESTNET_CAIP2,
        asset: USDC_TESTNET_ADDRESS,
        amount: "1000000",
        payTo: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        maxTimeoutSeconds: 3600,
        extra: { custom: "value" },
      };

      const result = await server.enhancePaymentRequirements(
        requirements as never,
        {
          x402Version: 2,
          scheme: "exact",
          network: STELLAR_TESTNET_CAIP2,
          extra: { areFeesSponsored: true },
        },
        [],
      );

      expect(result.extra).toEqual({
        areFeesSponsored: true,
        custom: "value",
      });
    });
  });
});
