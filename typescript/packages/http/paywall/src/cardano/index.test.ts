import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCardanoPaywallHandler } from "./handler";
import { cardanoPaywall, createCardanoPaywall } from "./index";
import { cardanoPaywall as rootCardanoPaywall, createPaywall } from "../index";
import { CARDANO_FAUCET_URLS, cardanoFaucetUrl } from "./format";
import type { PaymentRequired, PaymentRequirements } from "../types";
import fixture from "./fixtures/koios-epoch-params-preprod.json";

const PAY_TO = "addr_test1vz0h3dcsalq2g0ef3lmxjvhw7v3h6e5ze7xxa3ul3pjlrwq8kqjv2";

const requirement: PaymentRequirements = {
  scheme: "exact",
  network: "cardano:preprod",
  asset: "lovelace",
  amount: "2000000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 600,
};

/**
 * Wraps requirements in a 402 body.
 *
 * @param accepts - Requirements.
 * @param description - Resource description.
 * @returns PaymentRequired.
 */
function required(accepts: PaymentRequirements[], description = "Premium report"): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: "https://api.example.com/premium", description },
    accepts,
  };
}

/**
 * Extracts the injected `window.x402` object from generated HTML.
 *
 * @param html - Generated page.
 * @returns Parsed config.
 */
function injected(html: string): Record<string, unknown> {
  const match = html.match(/window\.x402 = (.*);\n/);
  if (!match) throw new Error("no injected config");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

beforeEach(() => {
  // Handlers here are fed an empty Koios answer on purpose; its warning is expected.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("cardanoPaywall.supports", () => {
  it.each([
    [{}, true],
    [{ network: "cip34:0-1" }, true],
    [{ network: "cardano:mainnet" }, true],
    [{ extra: { assetTransferMethod: "default" } }, true],
    [{ extra: { assetTransferMethod: "masumi" } }, false],
    [{ extra: { assetTransferMethod: "script" } }, false],
    [{ extra: { assetTransferMethod: "Default" } }, false],
    [{ scheme: "upto" }, false],
    [{ network: "eip155:8453" }, false],
    [{ network: "cardano:unknown" }, false],
    [{ amount: undefined, maxAmountRequired: "2000000" }, false],
    [{ amount: "1.5" }, false],
    [{ amount: "0" }, false],
  ])("%j → %s", (patch, expected) => {
    const handler = createCardanoPaywall({
      fetch: vi.fn(async () => new Response(JSON.stringify(fixture))),
    });
    expect(handler.supports({ ...requirement, ...patch } as PaymentRequirements)).toBe(expected);
  });

  it("refuses to render a requirement without a v2 amount", () => {
    const handler = createCardanoPaywall({
      fetch: vi.fn(async () => new Response(JSON.stringify(fixture))),
    });
    const v1 = { ...requirement, amount: undefined, maxAmountRequired: "2000000" };
    expect(() => handler.generateHtml(v1, required([v1]), {})).toThrow(/integer amount/);
  });

  it("starts warming the parameter cache only for supported requirements", () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(fixture)));
    const handler = createCardanoPaywall({ fetch });
    handler.supports({ ...requirement, network: "eip155:8453" });
    expect(fetch).not.toHaveBeenCalled();
    handler.supports(requirement);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("cardanoPaywall.generateHtml", () => {
  it("injects the selected requirement, server time and warm parameters", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(fixture)));
    const handler = createCardanoPaywallHandler({
      fetch,
      now: () => 42_000,
      koiosToken: "secret-token",
    });
    await handler.prefetch(["cardano:preprod"]);
    const masumi = { ...requirement, extra: { assetTransferMethod: "masumi" } };
    const html = handler.generateHtml(requirement, required([masumi, requirement]), {
      appName: "Demo",
      testnet: true,
    });
    const x402 = injected(html);
    const cardano = x402.cardano as Record<string, unknown>;
    expect(cardano.selectedRequirement).toEqual(requirement);
    expect(cardano.network).toBe("cardano:preprod");
    expect(cardano.serverTimeMs).toBe(42_000);
    expect((cardano.protocolParameters as { minFeeA: number }).minFeeA).toBe(44);
    expect(x402.currentUrl).toBe("https://api.example.com/premium");
    expect(x402.appName).toBe("Demo");
    expect(html).not.toContain("secret-token");
  });

  it("injects null parameters while the cache is cold and canonicalises CIP-34 ids", () => {
    const handler = createCardanoPaywall({
      fetch: vi.fn(async () => new Response(JSON.stringify(fixture))),
    });
    const alias = { ...requirement, network: "cip34:0-1" };
    const x402 = injected(handler.generateHtml(alias, required([alias]), {}));
    const cardano = x402.cardano as Record<string, unknown>;
    expect(cardano.protocolParameters).toBeNull();
    expect(cardano.network).toBe("cardano:preprod");
    expect(x402.testnet).toBe(true);
    expect(x402.currentUrl).toBe("https://api.example.com/premium");
  });

  it("escapes seller strings so they cannot close the script element", () => {
    const handler = createCardanoPaywall({
      fetch: vi.fn(async () => new Response(JSON.stringify(fixture))),
    });
    const html = handler.generateHtml(
      requirement,
      required([requirement], "</script><script>alert(1)</script>"),
      { currentUrl: "https://fallback.example" },
    );
    expect(html).not.toContain("</script><script>alert(1)");
    expect(injected(html).paymentRequired).toBeDefined();
  });

  it("falls back to config.currentUrl when the 402 has no resource", () => {
    const handler = createCardanoPaywall({
      fetch: vi.fn(async () => new Response(JSON.stringify(fixture))),
    });
    const html = handler.generateHtml(
      requirement,
      { x402Version: 2, accepts: [requirement] },
      {
        currentUrl: "https://fallback.example/x",
      },
    );
    expect(injected(html).currentUrl).toBe("https://fallback.example/x");
  });

  it("is selected by the builder for Cardano and re-exported from the package root", () => {
    expect(rootCardanoPaywall).toBe(cardanoPaywall);
    vi.spyOn(cardanoPaywall, "supports");
    const paywall = createPaywall()
      .withNetwork(
        createCardanoPaywall({ fetch: vi.fn(async () => new Response(JSON.stringify(fixture))) }),
      )
      .build();
    expect(paywall.generateHtml(required([requirement]))).toContain("window.x402");
    expect(() =>
      paywall.generateHtml(required([{ ...requirement, network: "eip155:8453" }])),
    ).toThrow(/No paywall handler supports networks/);
  });
});

describe("Cardano faucet", () => {
  it("links the faucet on testnets only, honouring server overrides", () => {
    expect(CARDANO_FAUCET_URLS["cardano:preprod"]).toMatch(/^https:\/\/docs\.cardano\.org\//);
    expect(cardanoFaucetUrl("cardano:preview")).toBe(CARDANO_FAUCET_URLS["cardano:preview"]);
    expect(cardanoFaucetUrl("cardano:preprod", { "cardano:preprod": "https://mine.example" })).toBe(
      "https://mine.example",
    );
    expect(cardanoFaucetUrl("cardano:mainnet")).toBeUndefined();
  });
});
