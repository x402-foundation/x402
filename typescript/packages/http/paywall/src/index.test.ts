import { describe, expect, it } from "vitest";
import { avmPaywall, createPaywall, evmPaywall, PaywallBuilder, svmPaywall } from "./index";
import type { PaywallNetworkHandler, PaymentRequired, PaymentRequirements } from "./index";

describe("@x402/paywall entrypoint", () => {
  it("exports the paywall builder helpers", () => {
    expect(createPaywall()).toBeInstanceOf(PaywallBuilder);
    expect(typeof PaywallBuilder).toBe("function");
  });

  it("exports network handlers with their CAIP-2 support checks", () => {
    const evmRequirement = createRequirement("eip155:8453");
    const svmRequirement = createRequirement("solana:mainnet");
    const avmRequirement = createRequirement("algorand:mainnet");

    expect(evmPaywall.supports(evmRequirement)).toBe(true);
    expect(evmPaywall.supports(svmRequirement)).toBe(false);

    expect(svmPaywall.supports(svmRequirement)).toBe(true);
    expect(svmPaywall.supports(avmRequirement)).toBe(false);

    expect(avmPaywall.supports(avmRequirement)).toBe(true);
    expect(avmPaywall.supports(evmRequirement)).toBe(false);
  });

  it("builds a provider from the exported factory", () => {
    const handler: PaywallNetworkHandler = {
      supports: requirement => requirement.network === "test:network",
      generateHtml: (requirement, paymentRequired, config) =>
        `${requirement.network}:${paymentRequired.x402Version}:${config.appName ?? ""}`,
    };

    const provider = createPaywall()
      .withConfig({ appName: "builder app" })
      .withNetwork(handler)
      .build();

    expect(provider.generateHtml(createPaymentRequired("test:network"))).toBe(
      "test:network:2:builder app",
    );
    expect(
      provider.generateHtml(createPaymentRequired("test:network"), { appName: "runtime app" }),
    ).toBe("test:network:2:runtime app");
  });
});

function createRequirement(network: string): PaymentRequirements {
  return {
    scheme: "exact",
    network,
    asset: "USDC",
    amount: "100000",
    payTo: "0x209693Bc6afc0C5328bA36FaF04C514EF312287C",
    maxTimeoutSeconds: 60,
  };
}

function createPaymentRequired(network: string): PaymentRequired {
  return {
    x402Version: 2,
    error: "Payment required",
    accepts: [createRequirement(network)],
  };
}
