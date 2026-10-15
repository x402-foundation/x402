import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  x402HTTPResourceServer,
  x402ResourceServer,
  type HTTPResponseBody,
} from "@x402/core/server";
import { paymentProxyFromHTTPServer, withX402FromHTTPServer } from "./index";

const network = "eip155:84532";

/**
 * Creates a real HTTP server for unpaid requests using only local fixtures.
 *
 * @param unpaidBody - Configured unpaid response.
 * @returns An initialized HTTP server.
 */
async function createServer(unpaidBody?: HTTPResponseBody): Promise<x402HTTPResourceServer> {
  const resourceServer = new x402ResourceServer({
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network }],
      extensions: [],
      signers: {},
    }),
    verify: async () => {
      throw new Error("Unpaid requests must not verify payments");
    },
    settle: async () => {
      throw new Error("Unpaid requests must not settle payments");
    },
  }).register(network, {
    scheme: "exact",
    parsePrice: async () => ({ amount: "1", asset: "fixture-asset", extra: {} }),
    enhancePaymentRequirements: async requirements => requirements,
    defaultAssetTransferMethod: "default",
    paymentFlows: { default: { supported: ["upfront"], default: "upfront" } },
  });
  const httpServer = new x402HTTPResourceServer(resourceServer, {
    "GET /api/paid": {
      accepts: { scheme: "exact", network, payTo: "fixture-recipient", price: "$0.01" },
      unpaidResponseBody: unpaidBody ? () => unpaidBody : undefined,
    },
  });
  await httpServer.initialize();
  return httpServer;
}

describe.each([
  {
    name: "proxy",
    wrap: (server: x402HTTPResourceServer) =>
      paymentProxyFromHTTPServer(server, undefined, undefined, false),
  },
  {
    name: "route wrapper",
    wrap: (server: x402HTTPResourceServer) =>
      withX402FromHTTPServer(
        async () => {
          throw new Error("Unpaid requests must not run the protected handler");
        },
        server,
        undefined,
        undefined,
        false,
      ),
  },
])("custom unpaid response bodies: $name", ({ wrap }) => {
  it.each([
    { contentType: "text/plain; charset=utf-8", body: "Payment required.\nPreview: café." },
    { contentType: "text/html; charset=utf-8", body: "<p>Payment required.</p>\n<p>Preview.</p>" },
  ])("preserves $contentType bytes and headers", async ({ contentType, body }) => {
    const handler = wrap(await createServer({ contentType, body }));
    const response = await handler(new NextRequest("https://example.com/api/paid"));

    expect(await response.text()).toBe(body);
    expect(response.status).toBe(402);
    expect(response.headers.get("Content-Type")).toBe(contentType);
    expect(response.headers.has("PAYMENT-REQUIRED")).toBe(true);
  });

  it("keeps object bodies JSON-encoded", async () => {
    const body = { error: "Payment required", preview: { quantity: 2 } };
    const handler = wrap(await createServer({ contentType: "application/json", body }));
    const response = await handler(new NextRequest("https://example.com/api/paid"));

    expect(await response.json()).toEqual(body);
    expect(response.status).toBe(402);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.has("PAYMENT-REQUIRED")).toBe(true);
  });

  it.each(["application/json; charset=utf-8", "Application/JSON", "application/problem+json"])(
    "keeps string bodies JSON-encoded for %s",
    async contentType => {
      const body = "Payment required.\nPreview.";
      const handler = wrap(await createServer({ contentType, body }));
      const response = await handler(new NextRequest("https://example.com/api/paid"));

      expect(await response.text()).toBe(JSON.stringify(body));
      expect(response.headers.get("Content-Type")).toBe(contentType);
    },
  );

  it("preserves the default empty JSON response", async () => {
    const handler = wrap(await createServer());
    const response = await handler(new NextRequest("https://example.com/api/paid"));

    expect(await response.json()).toEqual({});
    expect(response.status).toBe(402);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.has("PAYMENT-REQUIRED")).toBe(true);
  });
});
