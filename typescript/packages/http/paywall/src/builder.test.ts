import { describe, expect, it } from "vitest";
import { createPaywall, PaywallBuilder } from "./builder";
import type { PaymentRequired } from "./types";
import { evmPaywall } from "./evm";
import { svmPaywall } from "./svm";

const mockPaymentRequired: PaymentRequired = {
  x402Version: 2,
  error: "Payment required",
  resource: {
    url: "https://example.com/api/data",
    description: "Test Resource",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "100000",
      payTo: "0x209693Bc6afc0C5328bA36FaF04C514EF312287C",
      maxTimeoutSeconds: 60,
    },
  ],
};

describe("PaywallBuilder", () => {
  describe("createPaywall", () => {
    it("creates a new PaywallBuilder instance", () => {
      const builder = createPaywall();
      expect(builder).toBeInstanceOf(PaywallBuilder);
    });
  });

  describe("withConfig", () => {
    it("sets configuration and returns builder for chaining", () => {
      const builder = createPaywall();
      const result = builder.withConfig({
        appName: "Test App",
        appLogo: "/test-logo.png",
      });
      expect(result).toBe(builder); // Same instance (chainable)
    });

    it("merges multiple config calls", () => {
      const paywall = createPaywall()
        .withNetwork(evmPaywall)
        .withConfig({ appName: "App 1" })
        .withConfig({ appLogo: "/logo-1.png" })
        .build();

      const html = paywall.generateHtml(mockPaymentRequired);
      expect(html).toContain("App 1");
      expect(html).toContain("/logo-1.png");
    });

    it("later configs override earlier ones", () => {
      const paywall = createPaywall()
        .withNetwork(evmPaywall)
        .withConfig({ appName: "First App" })
        .withConfig({ appName: "Second App" })
        .build();

      const html = paywall.generateHtml(mockPaymentRequired);
      expect(html).toContain("Second App");
      expect(html).not.toContain("First App");
    });
  });

  describe("build", () => {
    it("returns a PaywallProvider", () => {
      const provider = createPaywall().build();
      expect(provider).toHaveProperty("generateHtml");
      expect(typeof provider.generateHtml).toBe("function");
    });

    it("generates HTML with builder config", () => {
      const paywall = createPaywall()
        .withNetwork(evmPaywall)
        .withConfig({
          appName: "Builder Test",
          testnet: true,
        })
        .build();

      const html = paywall.generateHtml(mockPaymentRequired);
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("Builder Test");
    });

    it("runtime config overrides builder config", () => {
      const paywall = createPaywall()
        .withNetwork(evmPaywall)
        .withConfig({
          appName: "Builder Config",
        })
        .build();

      const html = paywall.generateHtml(mockPaymentRequired, {
        appName: "Runtime Config",
      });

      expect(html).toContain("Runtime Config");
      expect(html).not.toContain("Builder Config");
    });

    it("merges builder config with runtime config", () => {
      const paywall = createPaywall()
        .withNetwork(evmPaywall)
        .withConfig({
          appName: "Test App",
          testnet: true,
        })
        .build();

      const html = paywall.generateHtml(mockPaymentRequired, {
        appLogo: "/runtime-logo.png",
      });

      expect(html).toContain("Test App");
      expect(html).toContain("/runtime-logo.png");
    });
  });

  describe("generateHtml", () => {
    it("extracts amount from v2 payment requirements", () => {
      const paywall = createPaywall().withNetwork(evmPaywall).build();
      const html = paywall.generateHtml(mockPaymentRequired);

      expect(html).toContain("window.x402");
      expect(html).toContain("0.1");
    });

    it("uses resource URL as currentUrl when not provided", () => {
      const paywall = createPaywall().withNetwork(evmPaywall).build();
      const html = paywall.generateHtml(mockPaymentRequired);

      expect(html).toContain("https://example.com/api/data");
    });

    it("defaults to testnet when not specified", () => {
      const paywall = createPaywall().withNetwork(evmPaywall).build();
      const html = paywall.generateHtml(mockPaymentRequired);

      expect(html).toContain("testnet: true");
    });
  });

  describe("withNetwork", () => {
    it("registers network handler and returns builder for chaining", () => {
      const builder = createPaywall();
      const result = builder.withNetwork(evmPaywall);
      expect(result).toBe(builder); // Same instance (chainable)
    });

    it("uses first-match selection from accepts array", () => {
      const multiNetworkPaymentRequired: PaymentRequired = {
        ...mockPaymentRequired,
        accepts: [
          // Solana is first in accepts array
          {
            scheme: "exact",
            network: "solana:5eykt",
            asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            amount: "100000",
            payTo: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHEBg4",
            maxTimeoutSeconds: 60,
          },
          {
            scheme: "exact",
            network: "eip155:8453",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            amount: "100000",
            payTo: "0x209693Bc6afc0C5328bA36FaF04C514EF312287C",
            maxTimeoutSeconds: 60,
          },
        ],
      };

      const paywall = createPaywall().withNetwork(evmPaywall).withNetwork(svmPaywall).build();

      const html = paywall.generateHtml(multiNetworkPaymentRequired);

      // Should match first requirement in accepts array (Solana)
      expect(html).toMatch(/SVM Paywall/);
    });

    it("throws when no handler matches", () => {
      const customNetworkRequired: PaymentRequired = {
        ...mockPaymentRequired,
        accepts: [
          {
            scheme: "exact",
            network: "unknown:network",
            asset: "0x123",
            amount: "100000",
            payTo: "0x456",
            maxTimeoutSeconds: 60,
          },
        ],
      };

      const paywall = createPaywall().withNetwork(evmPaywall).withNetwork(svmPaywall).build();

      expect(() => paywall.generateHtml(customNetworkRequired)).toThrow(
        "No paywall handler supports networks: unknown:network",
      );
    });

    it("only uses network handler when registered", () => {
      const evmOnlyPaywall = createPaywall().withNetwork(evmPaywall).build();

      const html = evmOnlyPaywall.generateHtml(mockPaymentRequired);

      expect(html).toContain("<!DOCTYPE html>");
    });

    it("can chain multiple networks", () => {
      const paywall = createPaywall()
        .withNetwork(evmPaywall)
        .withNetwork(svmPaywall)
        .withConfig({ appName: "Multi-chain App" })
        .build();

      expect(paywall).toHaveProperty("generateHtml");
    });
  });
});
