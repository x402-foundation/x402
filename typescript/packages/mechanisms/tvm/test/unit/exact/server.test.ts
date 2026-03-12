import { describe, it, expect, beforeEach } from "vitest";
import { ExactTvmScheme } from "../../../src/exact/server/scheme";
import { TVM_MAINNET, USDT_MASTER, USDT_DECIMALS } from "../../../src/constants";

describe("ExactTvmScheme (Server)", () => {
  let server: ExactTvmScheme;

  beforeEach(() => {
    server = new ExactTvmScheme();
  });

  describe("Construction", () => {
    it("should create instance", () => {
      expect(server).toBeDefined();
      expect(server.scheme).toBe("exact");
    });
  });

  describe("parsePrice", () => {
    it("should parse USD string to USDT nano", async () => {
      const result = await server.parsePrice("$0.01", TVM_MAINNET);
      expect(result.amount).toBe("10000");
      expect(result.asset).toBe(USDT_MASTER);
    });

    it("should parse number to USDT nano", async () => {
      const result = await server.parsePrice(1.5, TVM_MAINNET);
      expect(result.amount).toBe("1500000");
      expect(result.asset).toBe(USDT_MASTER);
    });

    it("should parse plain string without $", async () => {
      const result = await server.parsePrice("0.10", TVM_MAINNET);
      expect(result.amount).toBe("100000");
    });

    it("should return AssetAmount directly", async () => {
      const result = await server.parsePrice(
        { amount: "50000", asset: "0:custom_token" },
        TVM_MAINNET,
      );
      expect(result.amount).toBe("50000");
      expect(result.asset).toBe("0:custom_token");
    });

    it("should throw on unknown network", async () => {
      await expect(server.parsePrice("$1.00", "tvm:999" as any)).rejects.toThrow(
        "No default asset configured",
      );
    });

    it("should throw on invalid money format", async () => {
      await expect(server.parsePrice("abc", TVM_MAINNET)).rejects.toThrow(
        "Invalid money format",
      );
    });
  });

  describe("enhancePaymentRequirements", () => {
    it("should pass through requirements unchanged", async () => {
      const requirements = {
        scheme: "exact",
        network: TVM_MAINNET as `${string}:${string}`,
        amount: "10000",
        asset: USDT_MASTER,
        payTo: "0:recipient",
        maxTimeoutSeconds: 300,
        extra: {},
      };

      const result = await server.enhancePaymentRequirements(
        requirements,
        { x402Version: 2, scheme: "exact", network: TVM_MAINNET as `${string}:${string}` },
        [],
      );

      expect(result).toEqual(requirements);
    });
  });

  describe("registerMoneyParser", () => {
    it("should use custom parser before default", async () => {
      server.registerMoneyParser(async (amount, _network) => {
        if (amount > 100) {
          return { amount: (amount * 1e9).toString(), asset: "0:custom_large_token" };
        }
        return null;
      });

      const result = await server.parsePrice(200, TVM_MAINNET);
      expect(result.asset).toBe("0:custom_large_token");
    });

    it("should fall back to default when custom parser returns null", async () => {
      server.registerMoneyParser(async () => null);

      const result = await server.parsePrice("$1.00", TVM_MAINNET);
      expect(result.asset).toBe(USDT_MASTER);
    });
  });
});
