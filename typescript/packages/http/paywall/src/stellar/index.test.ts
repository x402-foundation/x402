import { describe, expect, it } from "vitest";
import { stellarPaywall, stroopsToDisplayAmount, type StellarPaywallConfig } from "./index";
import { jsonForScript } from "./paywall";
import type { PaymentRequired, PaymentRequirements } from "../types";

const USDC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function makeRequirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: USDC_TESTNET,
    payTo: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    maxTimeoutSeconds: 60,
    amount: "10000000",
    ...overrides,
  };
}

function makePaymentRequired(req: PaymentRequirements): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: "https://example.com/premium", description: "Premium" },
    accepts: [req],
  };
}

function extractAmount(html: string): number {
  const match = html.match(/window\.x402\s*=\s*\{[^}]*amount:\s*([\d.eE+-]+)/);
  if (!match) throw new Error("Could not find amount in HTML");
  return parseFloat(match[1]);
}

describe("stellarPaywall", () => {
  it("supports CAIP-2 Stellar networks", () => {
    expect(stellarPaywall.supports(makeRequirement({ network: "stellar:pubnet" }))).toBe(true);
    expect(stellarPaywall.supports(makeRequirement({ network: "stellar:testnet" }))).toBe(true);
  });

  it("rejects non-Stellar networks", () => {
    expect(stellarPaywall.supports(makeRequirement({ network: "eip155:8453" }))).toBe(false);
    expect(stellarPaywall.supports(makeRequirement({ network: "solana:5eykt" }))).toBe(false);
    expect(stellarPaywall.supports(makeRequirement({ network: "stellar" }))).toBe(false);
  });

  it("generates HTML with the injected config", () => {
    const req = makeRequirement();
    const html = stellarPaywall.generateHtml(req, makePaymentRequired(req), {
      appName: "Stellar Test",
      testnet: true,
    });

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Stellar Paywall");
    expect(html).toContain('appName: "Stellar Test"');
    expect(html).toContain("testnet: true");
    expect(html).toContain('currentUrl: "https://example.com/premium"');
    expect(html).toContain(`"usdcAddress":"${USDC_TESTNET}"`);
  });

  describe("amount conversion (7 decimals)", () => {
    it("renders 10_000_000 stroops as 1 USDC", () => {
      const req = makeRequirement({ amount: "10000000" });
      const html = stellarPaywall.generateHtml(req, makePaymentRequired(req), {});
      expect(extractAmount(html)).toBe(1);
    });

    it("renders 5_100_000 stroops as 0.51 USDC (the x402-stellar#55 case)", () => {
      // A 6-decimal formatter would show 5.1 here.
      const req = makeRequirement({ amount: "5100000" });
      const html = stellarPaywall.generateHtml(req, makePaymentRequired(req), {});
      expect(extractAmount(html)).toBe(0.51);
    });

    it("renders 100_000 stroops as 0.01 USDC", () => {
      const req = makeRequirement({ amount: "100000" });
      const html = stellarPaywall.generateHtml(req, makePaymentRequired(req), {});
      expect(extractAmount(html)).toBe(0.01);
    });

    it("keeps the whole-unit part exact beyond 2^53 stroops", () => {
      // 10_000_000_000_000_000 stroops = 1_000_000_000 USDC
      const req = makeRequirement({ amount: "10000000000000000" });
      const html = stellarPaywall.generateHtml(req, makePaymentRequired(req), {});
      expect(extractAmount(html)).toBe(1000000000);
    });

    it("uses maxAmountRequired (v1) when amount is absent", () => {
      const req = makeRequirement({ amount: undefined, maxAmountRequired: "20000000" });
      const html = stellarPaywall.generateHtml(req, makePaymentRequired(req), {});
      expect(extractAmount(html)).toBe(2);
    });

    it("renders 0 when neither amount nor maxAmountRequired is present", () => {
      const req = makeRequirement({ amount: undefined, maxAmountRequired: undefined });
      const html = stellarPaywall.generateHtml(req, makePaymentRequired(req), {});
      expect(extractAmount(html)).toBe(0);
    });

    it("rejects non-integer atomic amount strings (BigInt strictness)", () => {
      const req = makeRequirement({ amount: "1.5" });
      expect(() => stellarPaywall.generateHtml(req, makePaymentRequired(req), {})).toThrow();
    });
  });

  describe("stroopsToDisplayAmount", () => {
    it("splits integer and fraction with BigInt", () => {
      expect(stroopsToDisplayAmount("0")).toBe(0);
      expect(stroopsToDisplayAmount("1")).toBe(1e-7);
      expect(stroopsToDisplayAmount("12345678")).toBe(1.2345678);
    });
  });

  describe("config injection", () => {
    it("injects stellarRpcUrl as config.rpcUrl when provided", () => {
      const req = makeRequirement();
      const config: StellarPaywallConfig = { stellarRpcUrl: "https://rpc.example.org" };
      const html = stellarPaywall.generateHtml(req, makePaymentRequired(req), config);
      expect(html).toContain('rpcUrl: "https://rpc.example.org"');
    });

    it("omits rpcUrl when stellarRpcUrl is not provided", () => {
      const req = makeRequirement();
      const html = stellarPaywall.generateHtml(req, makePaymentRequired(req), {});
      expect(html).not.toContain("rpcUrl:");
    });

    it("passes faucetUrls through to the browser config", () => {
      const req = makeRequirement();
      const html = stellarPaywall.generateHtml(req, makePaymentRequired(req), {
        faucetUrls: { "stellar:testnet": "https://faucet.example.org/" },
      });
      expect(html).toContain('faucetUrls: {"stellar:testnet":"https://faucet.example.org/"}');
    });

    it("escapes </script> inside injected JSON so the script block cannot be closed early", () => {
      const req = makeRequirement();
      const paymentRequired = makePaymentRequired(req);
      paymentRequired.resource = {
        url: "https://example.com/premium",
        description: "</script><script>alert(1)</script>",
      };
      const html = stellarPaywall.generateHtml(req, paymentRequired, { appName: "</script>" });
      expect(html).not.toContain("</script><script>alert(1)</script>");
      expect(html).toContain("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>");
    });
  });
});

describe("jsonForScript", () => {
  it("escapes < but stays valid JSON/JS", () => {
    const out = jsonForScript({ a: "</script>" });
    expect(out).toBe('{"a":"\\u003c/script>"}');
    expect(JSON.parse(out)).toEqual({ a: "</script>" });
  });
});

describe("chainConfig USDC addresses", () => {
  it("match the @x402/stellar constants (guards against drift)", async () => {
    const stellar = await import("@x402/stellar");
    const req = makeRequirement();
    const html = stellarPaywall.generateHtml(req, makePaymentRequired(req), {});
    expect(html).toContain(`"pubnet":{"usdcAddress":"${stellar.USDC_PUBNET_ADDRESS}"`);
    expect(html).toContain(`"testnet":{"usdcAddress":"${stellar.USDC_TESTNET_ADDRESS}"`);
  });
});
