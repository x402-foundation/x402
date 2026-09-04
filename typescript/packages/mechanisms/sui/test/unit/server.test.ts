import { describe, expect, it } from "vitest";
import { ExactSuiScheme } from "../../src/exact/server/scheme";
import {
  SUI_MAINNET_CAIP2,
  SUI_TESTNET_CAIP2,
  USDC_MAINNET,
  USDC_TESTNET,
} from "../../src/constants";
import { testRequirements } from "./helpers";

const supportedKind = { x402Version: 2, scheme: "exact", network: SUI_TESTNET_CAIP2 };

describe("ExactSuiScheme server", () => {
  const scheme = new ExactSuiScheme();

  describe("parsePrice", () => {
    it("passes through an AssetAmount and converts money to USDC", async () => {
      await expect(
        scheme.parsePrice({ amount: "12345", asset: USDC_TESTNET }, SUI_TESTNET_CAIP2),
      ).resolves.toMatchObject({ amount: "12345", asset: USDC_TESTNET });
      await expect(scheme.parsePrice("$1.50", SUI_TESTNET_CAIP2)).resolves.toMatchObject({
        amount: "1500000",
        asset: USDC_TESTNET,
      });
      await expect(scheme.parsePrice(0.1, SUI_MAINNET_CAIP2)).resolves.toMatchObject({
        amount: "100000",
        asset: USDC_MAINNET,
      });
    });

    it("rejects malformed asset, devnet money, and non-positive amounts", async () => {
      await expect(
        scheme.parsePrice({ amount: "1", asset: "not-a-coin" }, SUI_TESTNET_CAIP2),
      ).rejects.toThrow();
      await expect(scheme.parsePrice("$1.00", "sui:devnet")).rejects.toThrow(
        "No default USDC coin type",
      );
      await expect(
        scheme.parsePrice({ amount: "0", asset: USDC_TESTNET }, SUI_TESTNET_CAIP2),
      ).rejects.toThrow("positive");
    });
  });

  describe("getAssetDecimals", () => {
    it("knows USDC and throws otherwise", () => {
      expect(scheme.getAssetDecimals(USDC_MAINNET, SUI_MAINNET_CAIP2)).toBe(6);
      expect(() => scheme.getAssetDecimals("0x2::sui::SUI", SUI_MAINNET_CAIP2)).toThrow(
        "Unknown decimals",
      );
    });
  });

  describe("enhancePaymentRequirements", () => {
    it("does NOT auto-generate a nonce", async () => {
      const enhanced = await scheme.enhancePaymentRequirements(
        testRequirements({ extra: {} }),
        supportedKind,
        [],
      );
      expect(enhanced.extra?.nonce).toBeUndefined();
    });

    it("passes through a stable nonce and facilitator feePayer", async () => {
      const enhanced = await scheme.enhancePaymentRequirements(
        testRequirements({ extra: { nonce: "3q2+7w==" } }),
        { ...supportedKind, extra: { feePayer: "0xspon" } },
        [],
      );
      expect(enhanced.extra).toMatchObject({ nonce: "3q2+7w==", feePayer: "0xspon" });
    });

    it("rejects a non-positive amount", async () => {
      await expect(
        scheme.enhancePaymentRequirements(testRequirements({ amount: "0" }), supportedKind, []),
      ).rejects.toThrow("invalid_payment_requirements");
    });
  });
});
