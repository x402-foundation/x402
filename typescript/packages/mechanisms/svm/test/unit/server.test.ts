import { describe, it, expect } from "vitest";
import { ExactSvmScheme } from "../../src/exact/server/scheme";
import {
  USDC_MAINNET_ADDRESS,
  USDC_DEVNET_ADDRESS,
  SOLANA_MAINNET_CAIP2,
  SOLANA_DEVNET_CAIP2,
  SOLANA_TESTNET_CAIP2,
} from "../../src/constants";

describe("ExactSvmScheme", () => {
  const server = new ExactSvmScheme();

  describe("parsePrice", () => {
    describe("Solana Mainnet network", () => {
      const network = SOLANA_MAINNET_CAIP2;

      it("should parse dollar string prices", async () => {
        const result = await server.parsePrice("$0.10", network);
        expect(result.amount).toBe("100000"); // 0.10 USDC = 100000 smallest units
        expect(result.asset).toBe(USDC_MAINNET_ADDRESS);
        expect(result.extra).toEqual({});
      });

      it("should parse simple number string prices", async () => {
        const result = await server.parsePrice("0.10", network);
        expect(result.amount).toBe("100000");
        expect(result.asset).toBe(USDC_MAINNET_ADDRESS);
      });

      it("should parse number prices", async () => {
        const result = await server.parsePrice(0.1, network);
        expect(result.amount).toBe("100000");
        expect(result.asset).toBe(USDC_MAINNET_ADDRESS);
      });

      it("should handle larger amounts", async () => {
        const result = await server.parsePrice("100.50", network);
        expect(result.amount).toBe("100500000"); // 100.50 USDC
      });

      it("should handle whole numbers", async () => {
        const result = await server.parsePrice("1", network);
        expect(result.amount).toBe("1000000"); // 1 USDC
      });

      it("should avoid floating-point rounding error", async () => {
        const result = await server.parsePrice("$4.02", network);
        expect(result.amount).toBe("4020000"); // 4.02 USDC
      });
    });

    describe("Solana Devnet network", () => {
      const network = SOLANA_DEVNET_CAIP2;

      it("should use Devnet USDC address", async () => {
        const result = await server.parsePrice("1.00", network);
        expect(result.asset).toBe(USDC_DEVNET_ADDRESS);
        expect(result.amount).toBe("1000000");
      });
    });

    describe("Solana Testnet network", () => {
      const network = SOLANA_TESTNET_CAIP2;

      it("should use Testnet USDC address (same as devnet)", async () => {
        const result = await server.parsePrice("1.00", network);
        expect(result.asset).toBe(USDC_DEVNET_ADDRESS);
        expect(result.amount).toBe("1000000");
      });
    });

    describe("pre-parsed price objects", () => {
      it("should handle pre-parsed price objects with asset", async () => {
        const result = await server.parsePrice(
          {
            amount: "123456",
            asset: "CustomTokenAddress11111111111111111111",
            extra: { foo: "bar" },
          },
          SOLANA_MAINNET_CAIP2,
        );
        expect(result.amount).toBe("123456");
        expect(result.asset).toBe("CustomTokenAddress11111111111111111111");
        expect(result.extra).toEqual({ foo: "bar" });
      });

      it("should throw for price objects without asset", async () => {
        await expect(
          async () => await server.parsePrice({ amount: "123456" } as never, SOLANA_MAINNET_CAIP2),
        ).rejects.toThrow("Asset address must be specified");
      });
    });

    describe("error cases", () => {
      it("should throw for invalid money formats", async () => {
        await expect(
          async () => await server.parsePrice("not-a-price!", SOLANA_MAINNET_CAIP2),
        ).rejects.toThrow("Invalid money format");
      });

      it("should throw for invalid amounts", async () => {
        await expect(
          async () => await server.parsePrice("abc", SOLANA_MAINNET_CAIP2),
        ).rejects.toThrow("Invalid money format");
      });
    });
  });

  describe("enhancePaymentRequirements", () => {
    it("should add feePayer to payment requirements", async () => {
      const requirements = {
        scheme: "exact",
        network: SOLANA_MAINNET_CAIP2,
        asset: USDC_MAINNET_ADDRESS,
        amount: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: {},
      };

      const facilitatorAddress = "FacilitatorAddress1111111111111111111";
      const result = await server.enhancePaymentRequirements(
        requirements as never,
        {
          x402Version: 2,
          scheme: "exact",
          network: SOLANA_MAINNET_CAIP2,
          extra: { feePayer: facilitatorAddress },
        },
        [],
      );

      expect(result).toEqual({
        ...requirements,
        extra: { feePayer: facilitatorAddress },
      });
    });

    it("should preserve existing extra fields", async () => {
      const requirements = {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: { custom: "value" },
      };

      const result = await server.enhancePaymentRequirements(
        requirements as never,
        {
          x402Version: 2,
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          extra: { feePayer: "FeePayer1111111111111111111111111111" },
        },
        [],
      );

      expect(result.extra).toEqual({
        custom: "value",
        feePayer: "FeePayer1111111111111111111111111111",
      });
    });
  });
});
