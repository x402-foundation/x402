import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { ExactKeetaScheme } from "../../src/exact/server/scheme";
import { KEETA_TESTNET_CAIP2 } from "../../src/constants";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { getNewKeetaAccount } from "./utils";
import { getUsdcAddress } from "../../src/utils";

const KEETA_ACCOUNT = getNewKeetaAccount().publicKeyString.toString();

describe("ExactKeetaServer", () => {
  let server: ExactKeetaScheme;
  let usdcTestnetAddress: string;

  beforeAll(async () => {
    usdcTestnetAddress = await getUsdcAddress(KEETA_TESTNET_CAIP2);
  });

  beforeEach(() => {
    server = new ExactKeetaScheme();
    vi.clearAllMocks();
  });

  it("has scheme set to exact", () => {
    expect(server.scheme).toBe("exact");
  });

  describe("parsePrice - Money (string/number)", () => {
    it("parses '$1.50' to USDC testnet amount", async () => {
      const result = await server.parsePrice("$1.50", KEETA_TESTNET_CAIP2);
      expect(result).toEqual({ amount: "1500000", asset: usdcTestnetAddress, extra: {} });
    });

    it("parses '1.50' to USDC testnet amount", async () => {
      const result = await server.parsePrice("1.50", KEETA_TESTNET_CAIP2);
      expect(result).toEqual({ amount: "1500000", asset: usdcTestnetAddress, extra: {} });
    });

    it("parses number 1.5 to USDC testnet amount", async () => {
      const result = await server.parsePrice(1.5, KEETA_TESTNET_CAIP2);
      expect(result).toEqual({ amount: "1500000", asset: usdcTestnetAddress, extra: {} });
    });

    it("parses '0.01' to 10000 atomic units", async () => {
      const result = await server.parsePrice("0.01", KEETA_TESTNET_CAIP2);
      expect(result).toEqual({ amount: "10000", asset: usdcTestnetAddress, extra: {} });
    });

    it("parses '$0.000001' to 1 atomic unit", async () => {
      const result = await server.parsePrice("$0.000001", KEETA_TESTNET_CAIP2);
      expect(result).toEqual({ amount: "1", asset: usdcTestnetAddress, extra: {} });
    });

    it("parses number 0 to 0 atomic units", async () => {
      const result = await server.parsePrice(0, KEETA_TESTNET_CAIP2);
      expect(result).toEqual({ amount: "0", asset: usdcTestnetAddress, extra: {} });
    });

    it("throws for invalid money string", async () => {
      await expect(server.parsePrice("invalid", KEETA_TESTNET_CAIP2)).rejects.toThrow(
        "Invalid money format",
      );
    });

    it("throws for '$abc' invalid money string", async () => {
      await expect(server.parsePrice("$abc", KEETA_TESTNET_CAIP2)).rejects.toThrow(
        "Invalid money format",
      );
    });

    it("throws for unsupported network", async () => {
      await expect(server.parsePrice("1.00", "keeta:99999")).rejects.toThrow(
        "No USDC address configured for network",
      );
    });
  });

  describe("parsePrice - AssetAmount", () => {
    it("returns AssetAmount as-is with empty extra when extra is not set", async () => {
      const result = await server.parsePrice(
        { amount: "500000", asset: usdcTestnetAddress },
        KEETA_TESTNET_CAIP2,
      );
      expect(result).toEqual({ amount: "500000", asset: usdcTestnetAddress, extra: {} });
    });

    it("returns AssetAmount with provided extra", async () => {
      const extra = { external: "0123456789abcdef" };
      const result = await server.parsePrice(
        { amount: "500000", asset: usdcTestnetAddress, extra },
        KEETA_TESTNET_CAIP2,
      );
      expect(result).toEqual({ amount: "500000", asset: usdcTestnetAddress, extra });
    });

    it("throws when asset is missing from AssetAmount", async () => {
      await expect(
        server.parsePrice({ amount: "500000" } as any, KEETA_TESTNET_CAIP2),
      ).rejects.toThrow("Asset address must be specified");
    });

    it("throws when asset address is not a token", async () => {
      await expect(
        server.parsePrice(
          {
            amount: "500000",
            asset: KEETA_ACCOUNT,
          },
          KEETA_TESTNET_CAIP2,
        ),
      ).rejects.toThrow("Invalid asset address");
    });

    it("throws for invalid asset", async () => {
      await expect(
        server.parsePrice({ amount: "500000", asset: "invalid-address" }, KEETA_TESTNET_CAIP2),
      ).rejects.toThrow("Invalid asset address");
    });
  });

  describe("parsePrice - custom money parsers", () => {
    it("calls custom money parser and returns result if not null", async () => {
      const customResult = { amount: "999", asset: usdcTestnetAddress, extra: {} };
      const customParser = vi.fn().mockResolvedValue(customResult);
      server.registerMoneyParser(customParser);

      const result = await server.parsePrice("5.00", KEETA_TESTNET_CAIP2);
      expect(customParser).toHaveBeenCalledWith(5, KEETA_TESTNET_CAIP2);
      expect(result).toEqual(customResult);
    });

    it("falls through to default when custom parser returns null", async () => {
      const customParser = vi.fn().mockResolvedValue(null);
      server.registerMoneyParser(customParser);

      const result = await server.parsePrice("1.00", KEETA_TESTNET_CAIP2);
      expect(customParser).toHaveBeenCalled();
      expect(result).toEqual({ amount: "1000000", asset: usdcTestnetAddress, extra: {} });
    });

    it("chains multiple parsers and uses first non-null result", async () => {
      const firstParser = vi.fn().mockResolvedValue(null);
      const secondResult = { amount: "42", asset: usdcTestnetAddress, extra: {} };
      const secondParser = vi.fn().mockResolvedValue(secondResult);
      const thirdParser = vi
        .fn()
        .mockResolvedValue({ amount: "99", asset: usdcTestnetAddress, extra: {} });

      server.registerMoneyParser(firstParser);
      server.registerMoneyParser(secondParser);
      server.registerMoneyParser(thirdParser);

      const result = await server.parsePrice("1.00", KEETA_TESTNET_CAIP2);
      expect(firstParser).toHaveBeenCalled();
      expect(secondParser).toHaveBeenCalled();
      expect(thirdParser).not.toHaveBeenCalled();
      expect(result).toEqual(secondResult);
    });

    it("registerMoneyParser returns server instance for chaining", () => {
      const parser = vi.fn().mockResolvedValue(null);
      const result = server.registerMoneyParser(parser);
      expect(result).toBe(server);
    });
  });

  describe("enhancePaymentRequirements", () => {
    it("returns payment requirements unchanged", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: KEETA_TESTNET_CAIP2,
        asset: usdcTestnetAddress,
        amount: "1000000",
        payTo: KEETA_ACCOUNT,
        maxTimeoutSeconds: 60,
        extra: {},
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "exact",
        network: KEETA_TESTNET_CAIP2 as Network,
      };

      const result = await server.enhancePaymentRequirements(requirements, supportedKind, []);
      expect(result).toEqual(requirements);
    });
  });
});
