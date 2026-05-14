import { describe, it, expect } from "vitest";
import { AuthCaptureEvmScheme } from "../../../src/authCapture/server/index";

const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

describe("AuthCaptureEvmScheme", () => {
  describe("parsePrice", () => {
    it("should parse dollar amounts with default decimals (6 for USDC)", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice("$1.00", "eip155:84532");

      expect(result.amount).toBe("1000000");
      expect(result.asset).toBe(BASE_SEPOLIA_USDC);
      expect(result.extra).toEqual({ name: "USDC", version: "2" });
    });

    it("should parse amounts without dollar sign", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice("0.50", "eip155:84532");

      expect(result.amount).toBe("500000");
      expect(result.extra).toEqual({ name: "USDC", version: "2" });
    });

    it("should parse small amounts correctly", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice("$0.01", "eip155:84532");

      expect(result.amount).toBe("10000");
    });

    it("should parse large amounts correctly", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice("$1000.00", "eip155:84532");

      expect(result.amount).toBe("1000000000");
    });

    it("should handle amounts with commas", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice("$1,000.50", "eip155:84532");

      expect(result.amount).toBe("1000500000");
    });

    it("should handle zero amounts", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice("$0.00", "eip155:84532");

      expect(result.amount).toBe("0");
    });

    it("should accept numeric price", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice(0.01, "eip155:84532");

      expect(result.amount).toBe("10000");
      expect(result.asset).toBe(BASE_SEPOLIA_USDC);
      expect(result.extra).toEqual({ name: "USDC", version: "2" });
    });

    it("should return extra with name and version for Base mainnet", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice("$1.00", "eip155:8453");

      expect(result.extra).toEqual({ name: "USD Coin", version: "2" });
    });

    it("should pass through AssetAmount objects with extra", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice(
        { asset: "0xCustomToken", amount: "42000", extra: { name: "Custom", version: "1" } },
        "eip155:84532",
      );

      expect(result.amount).toBe("42000");
      expect(result.asset).toBe("0xCustomToken");
      expect(result.extra).toEqual({ name: "Custom", version: "1" });
    });

    it("should pass through AssetAmount objects without extra", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice(
        { asset: "0xCustomToken", amount: "42000" },
        "eip155:84532",
      );

      expect(result.amount).toBe("42000");
      expect(result.asset).toBe("0xCustomToken");
      expect(result.extra).toEqual({});
    });

    it("should throw when AssetAmount has no asset", async () => {
      const scheme = new AuthCaptureEvmScheme();
      await expect(
        scheme.parsePrice({ asset: "", amount: "42000" }, "eip155:84532"),
      ).rejects.toThrow("Asset address must be specified");
    });

    it("should throw for unsupported network", async () => {
      const scheme = new AuthCaptureEvmScheme();
      await expect(scheme.parsePrice("$1.00", "eip155:99999")).rejects.toThrow(
        "No USDC address configured for network",
      );
    });

    it("should resolve BSC default to Binance-Peg USDC without setting assetTransferMethod", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice("$1.00", "eip155:56");

      expect(result.asset).toBe("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d");
      // BSC's Binance-Peg USDC has 18 decimals, so $1.00 = 1e18 base units.
      expect(result.amount).toBe("1000000000000000000");
      expect(result.extra).toEqual({ name: "USDC", version: "1" });
    });

    it("should resolve Tempo default to pathUSD without setting assetTransferMethod", async () => {
      const scheme = new AuthCaptureEvmScheme();
      const result = await scheme.parsePrice("$1.00", "eip155:4217");

      expect(result.asset).toBe("0x20c0000000000000000000000000000000000000");
      expect(result.amount).toBe("1000000");
      expect(result.extra).toEqual({ name: "pathUSD", version: "1" });
    });

    it("should never inject assetTransferMethod (merchant decides)", async () => {
      const scheme = new AuthCaptureEvmScheme();
      for (const network of ["eip155:8453", "eip155:56", "eip155:4217"] as const) {
        const result = await scheme.parsePrice("$1.00", network);
        expect(result.extra).not.toHaveProperty("assetTransferMethod");
      }
    });
  });

  describe("registerMoneyParser", () => {
    it("should use custom parser when it returns a result", async () => {
      const scheme = new AuthCaptureEvmScheme();
      scheme.registerMoneyParser(async (amount, _network) => ({
        asset: "0xCustomToken",
        amount: String(amount * 1e18),
        extra: { name: "Custom", version: "1" },
      }));

      const result = await scheme.parsePrice("$1.00", "eip155:84532");

      expect(result.asset).toBe("0xCustomToken");
      expect(result.amount).toBe(String(1e18));
      expect(result.extra).toEqual({ name: "Custom", version: "1" });
    });

    it("should fall through to default when custom parser returns null", async () => {
      const scheme = new AuthCaptureEvmScheme();
      scheme.registerMoneyParser(async () => null);

      const result = await scheme.parsePrice("$1.00", "eip155:84532");

      expect(result.asset).toBe(BASE_SEPOLIA_USDC);
      expect(result.amount).toBe("1000000");
      expect(result.extra).toEqual({ name: "USDC", version: "2" });
    });

    it("should try parsers in registration order", async () => {
      const scheme = new AuthCaptureEvmScheme();

      // First parser returns null
      scheme.registerMoneyParser(async () => null);

      // Second parser returns a result
      scheme.registerMoneyParser(async (amount, _network) => ({
        asset: "0xSecondParser",
        amount: String(amount * 100),
        extra: {},
      }));

      const result = await scheme.parsePrice("$1.00", "eip155:84532");

      expect(result.asset).toBe("0xSecondParser");
      expect(result.amount).toBe("100");
    });
  });

  describe("enhancePaymentRequirements", () => {
    it("should merge extra fields from supportedKind", async () => {
      const scheme = new AuthCaptureEvmScheme();

      const requirements = {
        scheme: "authCapture",
        network: "eip155:84532" as const,
        amount: "1000000",
        asset: BASE_SEPOLIA_USDC,
        payTo: "0x1234567890123456789012345678901234567890",
        maxTimeoutSeconds: 300,
        extra: {},
      };

      const supportedKind = {
        x402Version: 2,
        scheme: "authCapture",
        network: "eip155:84532" as const,
        extra: {
          fromSupported1: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          fromSupported2: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      };

      const result = await scheme.enhancePaymentRequirements(requirements, supportedKind, []);

      expect(result.extra).toEqual({
        fromSupported1: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        fromSupported2: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      });
    });

    it("should preserve existing extra fields from requirements", async () => {
      const scheme = new AuthCaptureEvmScheme();

      const requirements = {
        scheme: "authCapture",
        network: "eip155:84532" as const,
        amount: "1000000",
        asset: BASE_SEPOLIA_USDC,
        payTo: "0x1234567890123456789012345678901234567890",
        maxTimeoutSeconds: 300,
        extra: {
          customField: "custom-value",
        },
      };

      const supportedKind = {
        x402Version: 2,
        scheme: "authCapture",
        network: "eip155:84532" as const,
        extra: {
          fromSupported: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      };

      const result = await scheme.enhancePaymentRequirements(requirements, supportedKind, []);

      expect(result.extra).toEqual({
        fromSupported: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        customField: "custom-value",
      });
    });

    it("should let requirements extra override supportedKind extra", async () => {
      const scheme = new AuthCaptureEvmScheme();

      const requirements = {
        scheme: "authCapture",
        network: "eip155:84532" as const,
        amount: "1000000",
        asset: BASE_SEPOLIA_USDC,
        payTo: "0x1234567890123456789012345678901234567890",
        maxTimeoutSeconds: 300,
        extra: {
          sharedKey: "0xcccccccccccccccccccccccccccccccccccccccc",
        },
      };

      const supportedKind = {
        x402Version: 2,
        scheme: "authCapture",
        network: "eip155:84532" as const,
        extra: {
          sharedKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      };

      const result = await scheme.enhancePaymentRequirements(requirements, supportedKind, []);

      // Requirements extra should override supportedKind extra
      expect(result.extra?.sharedKey).toBe("0xcccccccccccccccccccccccccccccccccccccccc");
    });

    it("should preserve all original requirement fields", async () => {
      const scheme = new AuthCaptureEvmScheme();

      const requirements = {
        scheme: "authCapture",
        network: "eip155:84532" as const,
        amount: "1000000",
        asset: BASE_SEPOLIA_USDC,
        payTo: "0x1234567890123456789012345678901234567890",
        maxTimeoutSeconds: 300,
        extra: {},
      };

      const supportedKind = {
        x402Version: 2,
        scheme: "authCapture",
        network: "eip155:84532" as const,
      };

      const result = await scheme.enhancePaymentRequirements(requirements, supportedKind, []);

      expect(result.scheme).toBe("authCapture");
      expect(result.network).toBe("eip155:84532");
      expect(result.amount).toBe("1000000");
      expect(result.asset).toBe(BASE_SEPOLIA_USDC);
      expect(result.payTo).toBe("0x1234567890123456789012345678901234567890");
    });
  });

  describe("scheme property", () => {
    it('should have scheme set to "authCapture"', () => {
      const scheme = new AuthCaptureEvmScheme();
      expect(scheme.scheme).toBe("authCapture");
    });
  });
});
