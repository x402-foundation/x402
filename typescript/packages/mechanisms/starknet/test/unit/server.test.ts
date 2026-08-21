import { describe, it, expect, beforeEach } from "vitest";
import type { AssetAmount, MoneyParser, PaymentRequirements } from "@x402/core/types";
import { ExactStarknetScheme } from "../../src/exact/server/scheme";
import {
  STARKNET_MAINNET_CAIP2,
  STARKNET_SEPOLIA_CAIP2,
  USDC_MAINNET,
  USDC_SEPOLIA,
} from "../../src/constants";

const ASSET = "0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343";
const FEE_PAYER = "0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81";
/** A value a merchant might put in resource config; must never reach the wire. */
const MERCHANT_SUPPLIED = "0x0611223344556677889900aabbccddeeff112233445566778899aabbccddeeff";
const PAY_TO = "0x02dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57";

function requirements(overrides?: Partial<PaymentRequirements>): PaymentRequirements {
  return {
    scheme: "exact",
    network: STARKNET_SEPOLIA_CAIP2,
    asset: ASSET,
    amount: "10000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: {},
    ...overrides,
  };
}

describe("ExactStarknetScheme (server)", () => {
  let server: ExactStarknetScheme;

  beforeEach(() => {
    server = new ExactStarknetScheme();
  });

  it("has scheme property set to exact", () => {
    expect(server.scheme).toBe("exact");
  });

  describe("parsePrice - AssetAmount passthrough", () => {
    it("passes an AssetAmount through unchanged, preserving extra", async () => {
      const price: AssetAmount = { amount: "1000", asset: ASSET, extra: { foo: "bar" } };
      const result = await server.parsePrice(price, STARKNET_SEPOLIA_CAIP2);
      expect(result).toEqual({ amount: "1000", asset: ASSET, extra: { foo: "bar" } });
    });

    it("defaults extra to {} when the AssetAmount omits it", async () => {
      const price = { amount: "1000", asset: ASSET } as AssetAmount;
      const result = await server.parsePrice(price, STARKNET_SEPOLIA_CAIP2);
      expect(result).toEqual({ amount: "1000", asset: ASSET, extra: {} });
    });

    it("throws when the AssetAmount has no asset", async () => {
      const price = { amount: "1000", asset: "" } as AssetAmount;
      await expect(server.parsePrice(price, STARKNET_SEPOLIA_CAIP2)).rejects.toThrow(
        /Asset address must be specified/,
      );
    });

    it("throws when the AssetAmount asset is malformed", async () => {
      const price = { amount: "1000", asset: "not-an-address" } as AssetAmount;
      await expect(server.parsePrice(price, STARKNET_SEPOLIA_CAIP2)).rejects.toThrow(
        /Invalid asset address format/,
      );
    });
  });

  describe("parsePrice - Money to USDC atomic units", () => {
    it("converts a dollar string to 6-decimal USDC atomic units", async () => {
      const result = await server.parsePrice("$0.10", STARKNET_MAINNET_CAIP2);
      expect(result.amount).toBe("100000");
      expect(result.asset).toBe(USDC_MAINNET);
      expect(result.extra).toEqual({});
    });

    it("converts a numeric price to 6-decimal USDC atomic units", async () => {
      const result = await server.parsePrice(0.1, STARKNET_SEPOLIA_CAIP2);
      expect(result.amount).toBe("100000");
      expect(result.asset).toBe(USDC_SEPOLIA);
    });

    it("converts a whole-dollar amount", async () => {
      const result = await server.parsePrice("$1", STARKNET_SEPOLIA_CAIP2);
      expect(result.amount).toBe("1000000");
    });

    it("defaults to USDC_MAINNET on the mainnet network", async () => {
      const result = await server.parsePrice(1, STARKNET_MAINNET_CAIP2);
      expect(result.asset).toBe(USDC_MAINNET);
    });

    it("defaults to USDC_SEPOLIA on the sepolia network", async () => {
      const result = await server.parsePrice(1, STARKNET_SEPOLIA_CAIP2);
      expect(result.asset).toBe(USDC_SEPOLIA);
    });

    // Silently pricing an unknown network in another network's token would
    // produce a 402 nobody can settle; the caller must be explicit instead.
    it("refuses to default the asset on a network with no known default", async () => {
      await expect(server.parsePrice(1, "starknet:SN_DEVNET")).rejects.toThrow(
        /No default asset configured for network/,
      );
    });

    it("resolves a ticker-suffixed price through the default-asset table", async () => {
      const result = await server.parsePrice("0.10 USDC", STARKNET_SEPOLIA_CAIP2);
      expect(result.amount).toBe("100000");
      expect(result.asset).toBe(USDC_SEPOLIA);
    });

    it("rejects a ticker the network has no default asset for", async () => {
      await expect(server.parsePrice("$0.10 USDT", STARKNET_SEPOLIA_CAIP2)).rejects.toThrow(
        /No USDT default asset configured for network/,
      );
    });
  });

  describe("getAssetDecimals", () => {
    it("reports 6 for the default USDC asset, however the address is written", () => {
      expect(server.getAssetDecimals(USDC_SEPOLIA, STARKNET_SEPOLIA_CAIP2)).toBe(6);
      expect(server.getAssetDecimals(USDC_SEPOLIA.toLowerCase(), STARKNET_SEPOLIA_CAIP2)).toBe(6);
      expect(server.getAssetDecimals(USDC_MAINNET, STARKNET_MAINNET_CAIP2)).toBe(6);
    });

    // Core refuses a `$…` settlement override when decimals are unknown; a
    // guessed 6 here would silently mis-scale an override for any other token.
    it("returns undefined for a token outside the default-asset table", () => {
      expect(server.getAssetDecimals(PAY_TO, STARKNET_SEPOLIA_CAIP2)).toBeUndefined();
      expect(server.getAssetDecimals(USDC_MAINNET, STARKNET_SEPOLIA_CAIP2)).toBeUndefined();
    });
  });

  describe("parsePrice - custom money parsers", () => {
    it("uses a registered parser result over the default conversion", async () => {
      const custom: MoneyParser = async () => ({
        amount: "42",
        asset: "0xdeadbeef",
        extra: { source: "custom" },
      });
      server.registerMoneyParser(custom);
      const result = await server.parsePrice("$0.10", STARKNET_MAINNET_CAIP2);
      expect(result).toEqual({ amount: "42", asset: "0xdeadbeef", extra: { source: "custom" } });
    });

    it("falls through to the default conversion when a parser returns null", async () => {
      const skip: MoneyParser = async () => null;
      server.registerMoneyParser(skip);
      const result = await server.parsePrice("$0.10", STARKNET_MAINNET_CAIP2);
      expect(result.amount).toBe("100000");
      expect(result.asset).toBe(USDC_MAINNET);
    });

    it("passes the decimal amount string and network to the parser", async () => {
      let seenAmount: string | number | undefined;
      let seenNetwork: string | undefined;
      const custom: MoneyParser = async (amount, network) => {
        seenAmount = amount;
        seenNetwork = network;
        return { amount: "1", asset: ASSET, extra: {} };
      };
      server.registerMoneyParser(custom);
      await server.parsePrice("$2.50", STARKNET_SEPOLIA_CAIP2);
      expect(seenAmount).toBe("2.50");
      expect(seenNetwork).toBe(STARKNET_SEPOLIA_CAIP2);
    });

    it("returns the scheme instance from registerMoneyParser for chaining", () => {
      const skip: MoneyParser = async () => null;
      expect(server.registerMoneyParser(skip)).toBe(server);
    });
  });

  describe("validateFacilitatorSupport", () => {
    const kind = (extra?: Record<string, unknown>) => ({
      x402Version: 2,
      scheme: "exact",
      network: STARKNET_SEPOLIA_CAIP2,
      ...(extra ? { extra } : {}),
    });

    it("accepts a facilitator that advertises a valid feePayer", () => {
      expect(
        server.validateFacilitatorSupport(
          STARKNET_SEPOLIA_CAIP2,
          kind({ feePayer: FEE_PAYER }),
          [],
        ),
      ).toBeUndefined();
    });

    // Every Starknet payment is sponsored by the advertised feePayer, so a kind
    // without a usable one could never produce a payable 402: refuse it at
    // initialize() rather than at the first client.
    it("refuses a facilitator without a usable feePayer", () => {
      for (const extra of [
        undefined,
        {},
        { feePayer: "not-an-address" },
        { feePayer: "0x0" },
        { feePayer: "0x414e595f43414c4c4552" },
      ]) {
        expect(server.validateFacilitatorSupport(STARKNET_SEPOLIA_CAIP2, kind(extra), [])).toMatch(
          /feePayer/,
        );
      }
    });
  });

  describe("enhancePaymentRequirements", () => {
    it("copies a string feePayer from supportedKind.extra into requirements.extra", async () => {
      const enhanced = await server.enhancePaymentRequirements(
        requirements(),
        {
          x402Version: 2,
          scheme: "exact",
          network: STARKNET_SEPOLIA_CAIP2,
          extra: { feePayer: FEE_PAYER },
        },
        [],
      );
      expect(enhanced.extra?.feePayer).toBe(FEE_PAYER);
    });

    it("does not add feePayer when supportedKind.extra has none", async () => {
      const enhanced = await server.enhancePaymentRequirements(
        requirements(),
        { x402Version: 2, scheme: "exact", network: STARKNET_SEPOLIA_CAIP2, extra: {} },
        [],
      );
      expect(enhanced.extra?.feePayer).toBeUndefined();
    });

    // The facilitator's value is copied VERBATIM (spec rule 1): a merchant-set
    // extra.feePayer must never survive into the served requirements, or the
    // resource server could advertise a sponsor its facilitator cannot settle
    // through. Overwriting with a non-string leaves the facilitator to reject it.
    it("overwrites a locally configured feePayer with the facilitator's value", async () => {
      const enhanced = await server.enhancePaymentRequirements(
        requirements({ extra: { feePayer: MERCHANT_SUPPLIED } }),
        {
          x402Version: 2,
          scheme: "exact",
          network: STARKNET_SEPOLIA_CAIP2,
          extra: { feePayer: FEE_PAYER },
        },
        [],
      );
      expect(enhanced.extra?.feePayer).toBe(FEE_PAYER);
    });

    it("does not let a merchant-supplied feePayer survive when the facilitator advertises none", async () => {
      const enhanced = await server.enhancePaymentRequirements(
        requirements({ extra: { feePayer: MERCHANT_SUPPLIED } }),
        { x402Version: 2, scheme: "exact", network: STARKNET_SEPOLIA_CAIP2, extra: {} },
        [],
      );
      expect(enhanced.extra?.feePayer).toBeUndefined();
    });

    it("preserves existing extra keys while adding feePayer", async () => {
      const enhanced = await server.enhancePaymentRequirements(
        requirements({ extra: { existing: "kept" } }),
        {
          x402Version: 2,
          scheme: "exact",
          network: STARKNET_SEPOLIA_CAIP2,
          extra: { feePayer: FEE_PAYER },
        },
        [],
      );
      expect(enhanced.extra).toEqual({ existing: "kept", feePayer: FEE_PAYER });
    });
  });
});

// Core resolves the ATM and flow from this table on every 402, and rejects a
// combination the scheme does not declare, so the declaration is load-bearing.
describe("ExactStarknetScheme (server) - declared payment flow", () => {
  it("declares the SDK default ATM with the authorization flow only", () => {
    const scheme = new ExactStarknetScheme();
    expect(scheme.defaultAssetTransferMethod).toBe("default");
    expect(scheme.paymentFlows).toEqual({
      default: { supported: ["authorization"], default: "authorization" },
    });
  });

  it("keeps the sentinel off the wire", async () => {
    const scheme = new ExactStarknetScheme();
    const enhanced = await scheme.enhancePaymentRequirements(
      {
        scheme: "exact",
        network: STARKNET_SEPOLIA_CAIP2,
        amount: "10000",
        payTo: "0x2dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57",
        asset: USDC_SEPOLIA,
        maxTimeoutSeconds: 300,
        extra: {},
      },
      {
        x402Version: 2,
        scheme: "exact",
        network: STARKNET_SEPOLIA_CAIP2,
        extra: { feePayer: "0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81" },
      },
      [],
    );
    expect(enhanced.extra?.assetTransferMethod).toBeUndefined();
    expect(enhanced.extra?.paymentFlow).toBeUndefined();
  });
});
