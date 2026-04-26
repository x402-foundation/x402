import { describe, expect, it } from "vitest";
import { evmPaywall } from "./evm";
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

    it("scales the displayed amount by the network's token decimals (6 for USDC)", () => {
      const html = evmPaywall.generateHtml(
        { ...evmRequirement, network: "eip155:8453", amount: "100000" },
        mockPaymentRequired,
        { appName: "Test", testnet: false },
      );
      // 100000 / 10^6 = 0.1
      expect(html).toContain("amount: 0.1,");
    });

    it("scales the displayed amount for 18-decimal tokens (e.g. MegaUSD on MegaETH)", () => {
      const html = evmPaywall.generateHtml(
        {
          ...evmRequirement,
          network: "eip155:4326",
          asset: "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7", // MegaUSD (18 decimals)
          amount: "100000000000000000",
        },
        mockPaymentRequired,
        { appName: "Test", testnet: false },
      );
      // 10^17 / 10^18 = 0.1; previously hardcoded /1e6 produced 100000000000.
      expect(html).toContain("amount: 0.1,");
    });

    it("falls back to 6 decimals when the asset is not the network's default token", () => {
      // Some custom 6-decimal token on MegaETH whose default is MegaUSD (18 decimals).
      const html = evmPaywall.generateHtml(
        {
          ...evmRequirement,
          network: "eip155:4326",
          asset: "0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef",
          amount: "100000",
        },
        mockPaymentRequired,
        { appName: "Test", testnet: false },
      );
      // Without asset-default match the divisor falls back to 1e6, so 100000 → 0.1.
      expect(html).toContain("amount: 0.1,");
    });

    it("falls back to 6 decimals for networks without a default asset", () => {
      const html = evmPaywall.generateHtml(
        { ...evmRequirement, network: "eip155:99999999", amount: "100000" },
        mockPaymentRequired,
        { appName: "Test", testnet: false },
      );
      // 100000 / 10^6 = 0.1 via fallback
      expect(html).toContain("amount: 0.1,");
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
