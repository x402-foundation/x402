import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  x402HTTPResourceServer,
  HTTPAdapter,
  PaywallProvider,
  RouteConfig,
} from "../../../src/http/x402HTTPResourceServer";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildSupportedResponse,
} from "../../mocks";
import { Network, PaymentRequirements, Price } from "../../../src/types";

// Stands in for an installed @x402/paywall. Without this mock the package is
// not resolvable from core, which the fallback tests in
// x402HTTPResourceService.test.ts rely on.
const paywall = vi.hoisted(() => {
  const handler = (prefix: string) => ({
    supports: (requirement: PaymentRequirements) => requirement.network.startsWith(prefix),
    generateHtml: vi.fn(() => `<html>${prefix} paywall</html>`),
  });
  return {
    evmPaywall: handler("eip155:"),
    svmPaywall: handler("solana:"),
    avmPaywall: handler("algorand:"),
  };
});

vi.mock("@x402/paywall", () => paywall);

const evm = "eip155:8453" as Network;
const stellar = "stellar:testnet" as Network;

const browserAdapter: HTTPAdapter = {
  getHeader: () => undefined,
  getMethod: () => "GET",
  getPath: () => "/api/protected",
  getUrl: () => "https://example.com/api/protected",
  getAcceptHeader: () => "text/html,application/xhtml+xml",
  getUserAgent: () => "Mozilla/5.0",
};

/**
 * Builds a payment option for the protected route.
 *
 * @param scheme - Payment scheme
 * @param network - Payment network
 * @returns Route payment option
 */
function option(scheme: string, network: Network) {
  return { scheme, payTo: "0xabc", price: "$1.00" as Price, network };
}

describe("x402HTTPResourceServer paywall", () => {
  let resourceServer: x402ResourceServer;

  beforeEach(async () => {
    vi.clearAllMocks();

    const kinds = [
      { x402Version: 2, scheme: "exact", network: evm },
      { x402Version: 2, scheme: "upto", network: evm },
      { x402Version: 2, scheme: "exact", network: stellar },
    ];
    resourceServer = new x402ResourceServer(
      new MockFacilitatorClient(buildSupportedResponse({ kinds })),
    );
    for (const { scheme, network } of kinds) {
      resourceServer.register(network, new MockSchemeNetworkServer(scheme));
    }
    await resourceServer.initialize();
  });

  /**
   * Sends an unpaid browser request and returns the HTML body.
   *
   * @param accepts - Payment options for the protected route
   * @param provider - Optional paywall provider to register
   * @returns The paywall HTML
   */
  async function renderPaywall(
    accepts: RouteConfig["accepts"],
    provider?: PaywallProvider,
  ): Promise<string> {
    const httpServer = new x402HTTPResourceServer(resourceServer, {
      "/api/protected": { accepts },
    });
    if (provider) {
      httpServer.registerPaywallProvider(provider);
    }
    const result = await httpServer.processHTTPRequest(
      { adapter: browserAdapter, path: "/api/protected", method: "GET" },
      { appName: "Test App", testnet: true },
    );
    if (result.type !== "payment-error" || !result.response.isHtml) {
      throw new Error(`expected HTML payment-error, got ${JSON.stringify(result)}`);
    }
    return String(result.response.body);
  }

  it("renders @x402/paywall when it is installed and no provider is registered", async () => {
    const html = await renderPaywall(option("exact", evm));

    expect(html).toBe("<html>eip155: paywall</html>");
    const requirement = expect.objectContaining({ scheme: "exact", network: evm });
    expect(paywall.evmPaywall.generateHtml).toHaveBeenCalledWith(
      requirement,
      expect.objectContaining({ accepts: [requirement] }),
      { appName: "Test App", testnet: true },
    );
  });

  it("prefers a registered paywall provider over @x402/paywall", async () => {
    const html = await renderPaywall(option("exact", evm), {
      generateHtml: () => "<html>custom</html>",
    });

    expect(html).toBe("<html>custom</html>");
    expect(paywall.evmPaywall.generateHtml).not.toHaveBeenCalled();
  });

  it.each([
    ["the first option's network has no handler", [option("exact", stellar), option("exact", evm)]],
    ["the first option's scheme is not exact", [option("upto", evm), option("exact", evm)]],
  ])("serves the static page when %s", async (_, accepts) => {
    const html = await renderPaywall(accepts);

    expect(html).toContain("install <code>@x402/paywall</code>");
    expect(paywall.evmPaywall.generateHtml).not.toHaveBeenCalled();
  });
});
