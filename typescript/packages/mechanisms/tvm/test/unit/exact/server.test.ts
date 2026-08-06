import { describe, it, expect, beforeEach } from "vitest";
import { ExactTvmScheme } from "../../../src/exact/server/scheme";
import {
  TVM_MAINNET,
  TVM_TESTNET,
  USDT_MAINNET_MINTER,
  USDT_TESTNET_MINTER,
} from "../../../src/constants";

const RECIPIENT = "0:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const CUSTOM_ASSET = "0:1111111111111111111111111111111111111111111111111111111111111111";

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
      expect(result.asset).toBe(USDT_MAINNET_MINTER);
    });

    it("should use the testnet USDT minter on testnet", async () => {
      const result = await server.parsePrice("$0.01", TVM_TESTNET);
      expect(result.amount).toBe("10000");
      expect(result.asset).toBe(USDT_TESTNET_MINTER);
    });

    it("should parse number to USDT nano", async () => {
      const result = await server.parsePrice(1.5, TVM_MAINNET);
      expect(result.amount).toBe("1500000");
      expect(result.asset).toBe(USDT_MAINNET_MINTER);
    });

    it("should parse plain string without $", async () => {
      const result = await server.parsePrice("0.10", TVM_MAINNET);
      expect(result.amount).toBe("100000");
    });

    it("should return AssetAmount directly", async () => {
      const result = await server.parsePrice({ amount: "50000", asset: CUSTOM_ASSET }, TVM_MAINNET);
      expect(result.amount).toBe("50000");
      expect(result.asset).toBe(CUSTOM_ASSET);
    });

    it("should throw on unknown network", async () => {
      await expect(server.parsePrice("$1.00", "tvm:999" as any)).rejects.toThrow(
        "No default stablecoin configured",
      );
    });

    it("should throw on invalid money format", async () => {
      await expect(server.parsePrice("abc", TVM_MAINNET)).rejects.toThrow("Invalid money format");
    });
  });

  describe("enhancePaymentRequirements", () => {
    it("should normalize TON fields and add TVM defaults", async () => {
      const requirements = {
        scheme: "exact",
        network: TVM_MAINNET as `${string}:${string}`,
        amount: "10000",
        asset: USDT_MAINNET_MINTER,
        payTo: RECIPIENT,
        maxTimeoutSeconds: 300,
        extra: {},
      };

      const result = await server.enhancePaymentRequirements(
        requirements,
        { x402Version: 2, scheme: "exact", network: TVM_MAINNET as `${string}:${string}` },
        [],
      );

      expect(result.asset).toBe(USDT_MAINNET_MINTER);
      expect(result.payTo).toBe(RECIPIENT);
      expect(result.extra?.areFeesSponsored).toBe(true);
      expect(result.extra?.forwardTonAmount).toBe("0");
      expect(result.extra?.forwardPayload).toEqual(expect.any(String));
    });

    it("should convert decimal atomic amounts when decimals are provided", async () => {
      const result = await server.enhancePaymentRequirements(
        {
          scheme: "exact",
          network: TVM_MAINNET as `${string}:${string}`,
          amount: "1.23",
          asset: CUSTOM_ASSET,
          payTo: RECIPIENT,
          maxTimeoutSeconds: 300,
          extra: { decimals: 9 },
        },
        { x402Version: 2, scheme: "exact", network: TVM_MAINNET as `${string}:${string}` },
        [],
      );

      expect(result.amount).toBe("1230000000");
    });
  });

  describe("registerMoneyParser", () => {
    it("should use custom parser before default", async () => {
      server.registerMoneyParser(async (amount, _network) => {
        if (amount > 100) {
          return { amount: (amount * 1e9).toString(), asset: CUSTOM_ASSET };
        }
        return null;
      });

      const result = await server.parsePrice(200, TVM_MAINNET);
      expect(result.asset).toBe(CUSTOM_ASSET);
    });

    it("should fall back to default when custom parser returns null", async () => {
      server.registerMoneyParser(async () => null);

      const result = await server.parsePrice("$1.00", TVM_MAINNET);
      expect(result.asset).toBe(USDT_MAINNET_MINTER);
    });
  });
});
