import { describe, it, expect } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactBsvScheme } from "../../src/exact/server/scheme";
import { BSV_TESTNET_CAIP2 } from "../../src/constants";

describe("ExactBsvScheme (server)", () => {
  it("has scheme 'exact'", () => {
    expect(new ExactBsvScheme().scheme).toBe("exact");
  });

  describe("parsePrice", () => {
    it("passes through an AssetAmount in satoshis", async () => {
      const scheme = new ExactBsvScheme();
      const result = await scheme.parsePrice({ amount: "1000", asset: "BSV" }, BSV_TESTNET_CAIP2);
      expect(result).toEqual({ amount: "1000", asset: "BSV", extra: {} });
    });

    it("preserves extra on AssetAmount", async () => {
      const scheme = new ExactBsvScheme();
      const result = await scheme.parsePrice(
        { amount: "1", asset: "BSV", extra: { note: "hi" } },
        BSV_TESTNET_CAIP2,
      );
      expect(result.extra).toEqual({ note: "hi" });
    });

    it("accepts the BSV asset case-insensitively", async () => {
      const scheme = new ExactBsvScheme();
      const result = await scheme.parsePrice({ amount: "5", asset: "bsv" }, BSV_TESTNET_CAIP2);
      expect(result.amount).toBe("5");
    });

    it("throws for a non-BSV asset the scheme cannot fulfill", async () => {
      const scheme = new ExactBsvScheme();
      await expect(
        scheme.parsePrice({ amount: "1000", asset: "USDC" }, BSV_TESTNET_CAIP2),
      ).rejects.toThrow(/Unsupported asset/);
    });

    it("throws for an AssetAmount without asset", async () => {
      const scheme = new ExactBsvScheme();
      await expect(
        scheme.parsePrice({ amount: "1000", asset: "" }, BSV_TESTNET_CAIP2),
      ).rejects.toThrow(/asset/i);
    });

    it.each(["1.5", "0", "-1", "abc", "2100000000000001"])(
      "throws for an invalid satoshi amount %j",
      async amount => {
        const scheme = new ExactBsvScheme();
        await expect(
          scheme.parsePrice({ amount, asset: "BSV" }, BSV_TESTNET_CAIP2),
        ).rejects.toThrow(/amount|range/i);
      },
    );

    it("accepts the maximum representable satoshi amount", async () => {
      const scheme = new ExactBsvScheme();
      const result = await scheme.parsePrice(
        { amount: "2100000000000000", asset: "BSV" },
        BSV_TESTNET_CAIP2,
      );
      expect(result.amount).toBe("2100000000000000");
    });

    it("throws for Money when no parser is registered", async () => {
      const scheme = new ExactBsvScheme();
      await expect(scheme.parsePrice("$0.10", BSV_TESTNET_CAIP2)).rejects.toThrow(
        /registerMoneyParser/,
      );
    });

    it("uses a registered money parser", async () => {
      const scheme = new ExactBsvScheme().registerMoneyParser(async (usd, network) => ({
        amount: String(Math.round(usd * 2000)),
        asset: "BSV",
        extra: { network },
      }));
      const result = await scheme.parsePrice(0.5, BSV_TESTNET_CAIP2);
      expect(result.amount).toBe("1000");
      expect(result.asset).toBe("BSV");
    });

    it("falls through null-returning parsers in order", async () => {
      const scheme = new ExactBsvScheme()
        .registerMoneyParser(async () => null)
        .registerMoneyParser(async () => ({ amount: "42", asset: "BSV", extra: {} }));
      const result = await scheme.parsePrice(1, BSV_TESTNET_CAIP2);
      expect(result.amount).toBe("42");
    });
  });

  it("reports 8 decimals for native BSV", () => {
    expect(new ExactBsvScheme().getAssetDecimals("BSV", BSV_TESTNET_CAIP2)).toBe(8);
  });

  describe("enhancePaymentRequirements", () => {
    const base: PaymentRequirements = {
      scheme: "exact",
      network: BSV_TESTNET_CAIP2,
      asset: "",
      amount: "1000",
      payTo: "02".padEnd(66, "a"),
      maxTimeoutSeconds: 300,
      extra: { keep: true },
    };
    const kind = { x402Version: 2, scheme: "exact", network: BSV_TESTNET_CAIP2 };

    it("defaults an empty asset to BSV", async () => {
      const scheme = new ExactBsvScheme();
      const result = await scheme.enhancePaymentRequirements(base, kind, []);
      expect(result.asset).toBe("BSV");
    });

    it("preserves an explicit asset and extra", async () => {
      const scheme = new ExactBsvScheme();
      const result = await scheme.enhancePaymentRequirements({ ...base, asset: "BSV" }, kind, []);
      expect(result.asset).toBe("BSV");
      expect(result.extra).toEqual({ keep: true });
    });
  });
});
