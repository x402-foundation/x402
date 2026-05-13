import { describe, expect, it } from "vitest";
import { DEFAULT_STABLECOINS } from "@x402/evm";
import { evmPaywall, getDefaultTokenDecimals } from "./evm";
import { NETWORK_DECIMALS } from "./evm/gen/decimals";
import { svmPaywall } from "./svm";
import type { PaymentRequired, PaymentRequirements } from "./types";

const evmRequirement: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "100000",
  payTo: "0x209693Bc6afc0C5328bA36FaF04C514EF312287C",
  maxTimeoutSeconds: 60,
};

const svmRequirement: PaymentRequirements = {
  scheme: "exact",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: "100000",
  payTo: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHEBg4",
  maxTimeoutSeconds: 60,
};

const mockPaymentRequired: PaymentRequired = {
  x402Version: 2,
  resource: {
    url: "https://example.com/api/data",
    description: "Test",
    mimeType: "application/json",
  },
  accepts: [evmRequirement],
};

describe("Network Handlers", () => {
  describe("evmPaywall", () => {
    it("supports CAIP-2 EVM networks", () => {
      expect(evmPaywall.supports({ ...evmRequirement, network: "eip155:8453" })).toBe(true);
      expect(evmPaywall.supports({ ...evmRequirement, network: "eip155:84532" })).toBe(true);
      expect(evmPaywall.supports({ ...evmRequirement, network: "eip155:1" })).toBe(true);
      expect(evmPaywall.supports({ ...evmRequirement, network: "eip155:137" })).toBe(true);
    });

    it("rejects non-EVM networks", () => {
      expect(evmPaywall.supports({ ...evmRequirement, network: "solana:5eykt" })).toBe(false);
      expect(evmPaywall.supports({ ...evmRequirement, network: "base" })).toBe(false);
      expect(evmPaywall.supports({ ...evmRequirement, network: "unknown" })).toBe(false);
    });

    it("generates HTML for EVM networks", () => {
      const html = evmPaywall.generateHtml(evmRequirement, mockPaymentRequired, {
        appName: "Test App",
        testnet: true,
      });

      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toMatch(/Test App|EVM Paywall/);
    });

    it("renders 1e15-atomic Mezo mUSD as 0.001 (18-decimal end-to-end)", () => {
      // Mezo Testnet mUSD is 18-decimal in DEFAULT_STABLECOINS.
      // 1e15 atomic = 0.001 mUSD. A regression to the old `parseFloat / 1e6`
      // path would render this as 1_000_000_000 (the order-of-magnitude bug
      // this PR fixes).
      const req: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:31611",
        asset: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
        amount: "1000000000000000",
        payTo: "0x209693Bc6afc0C5328bA36FaF04C514EF312287C",
        maxTimeoutSeconds: 60,
      };
      const html = evmPaywall.generateHtml(
        req,
        { ...mockPaymentRequired, accepts: [req] },
        { appName: "Mezo Test", testnet: true },
      );
      expect(html).toContain("amount: 0.001,");
      expect(html).not.toMatch(/amount: 1000000000(?!\.)/);
    });

    it("rejects non-integer atomic amount strings (BigInt strictness)", () => {
      // The spec defines `amount` as an atomic integer string. The previous
      // parseFloat-based implementation silently coerced non-integer inputs
      // (e.g. "1.5", "1e15"); the BigInt-based implementation throws.
      // This test pins that strictness so a future revert to parseFloat fails.
      const req: PaymentRequirements = {
        ...evmRequirement,
        network: "eip155:8453",
        amount: "1.5",
      };
      expect(() =>
        evmPaywall.generateHtml(
          req,
          { ...mockPaymentRequired, accepts: [req] },
          {
            appName: "Strictness Test",
            testnet: true,
          },
        ),
      ).toThrow();
    });

    it("renders 1e6-atomic Base USDC as 1 (6-decimal end-to-end)", () => {
      // Base mainnet USDC is 6-decimal in DEFAULT_STABLECOINS.
      // 1e6 atomic = 1.00 USDC. Asserts the same dispatch behaves correctly
      // for the canonical 6-decimal case alongside the 18-decimal case above.
      const req: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "1000000",
        payTo: "0x209693Bc6afc0C5328bA36FaF04C514EF312287C",
        maxTimeoutSeconds: 60,
      };
      const html = evmPaywall.generateHtml(
        req,
        { ...mockPaymentRequired, accepts: [req] },
        { appName: "Base Test", testnet: false },
      );
      expect(html).toContain("amount: 1,");
    });
  });

  describe("getDefaultTokenDecimals", () => {
    it("reads non-default decimals from the @x402/evm registry", () => {
      // Mezo Testnet mUSD is 18-decimal in DEFAULT_STABLECOINS
      const req: PaymentRequirements = {
        ...evmRequirement,
        network: "eip155:31611",
        asset: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
      };
      expect(getDefaultTokenDecimals(req)).toBe(18);
    });

    it("reads the registry value (not the fallback) for a known 6-decimal chain", () => {
      // Base mainnet USDC is in the registry at 6 decimals. Asserting
      // alongside DEFAULT_STABLECOINS catches the case where the registry is
      // empty: the function would still return 6 via fallback, but the second
      // assertion would fail.
      const req: PaymentRequirements = { ...evmRequirement, network: "eip155:8453" };
      expect(getDefaultTokenDecimals(req)).toBe(6);
      expect(DEFAULT_STABLECOINS["eip155:8453"]?.decimals).toBe(6);
    });

    it("falls back to 6 (USDC default) for networks not in the registry", () => {
      const req: PaymentRequirements = {
        ...evmRequirement,
        network: "eip155:9999999", // unknown network
      };
      expect(getDefaultTokenDecimals(req)).toBe(6);
    });

    it("NETWORK_DECIMALS stays in sync with DEFAULT_STABLECOINS", () => {
      // The generated `src/evm/gen/decimals.ts` file is emitted by
      // `src/evm/build.ts` from `@x402/evm`'s `DEFAULT_STABLECOINS`. This
      // test pins the drift invariant in-process so a forgotten
      // `pnpm run build:paywall` after a `DEFAULT_STABLECOINS` change is
      // caught here (complements the CI regen-diff guard in #2054).
      for (const [network, info] of Object.entries(DEFAULT_STABLECOINS)) {
        expect(NETWORK_DECIMALS[network], `drift on ${network}`).toBe(info.decimals);
      }
      expect(Object.keys(NETWORK_DECIMALS).sort()).toStrictEqual(
        Object.keys(DEFAULT_STABLECOINS).sort(),
      );
    });
  });

  describe("svmPaywall", () => {
    it("supports CAIP-2 Solana networks", () => {
      expect(
        svmPaywall.supports({
          ...svmRequirement,
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        }),
      ).toBe(true);
      expect(
        svmPaywall.supports({
          ...svmRequirement,
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        }),
      ).toBe(true);
    });

    it("rejects non-Solana networks", () => {
      expect(svmPaywall.supports({ ...svmRequirement, network: "eip155:8453" })).toBe(false);
      expect(svmPaywall.supports({ ...svmRequirement, network: "base" })).toBe(false);
      expect(svmPaywall.supports({ ...svmRequirement, network: "unknown" })).toBe(false);
    });

    it("generates HTML for Solana networks", () => {
      const html = svmPaywall.generateHtml(svmRequirement, mockPaymentRequired, {
        appName: "Solana Test",
        testnet: true,
      });

      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toMatch(/Solana Test|SVM Paywall/);
    });
  });
});
