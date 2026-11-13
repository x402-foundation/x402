import { describe, expect, it } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  x402HTTPResourceServer,
  x402ResourceServer,
  type HTTPResponseBody,
} from "@x402/core/server";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { paymentProxyFromHTTPServer, withX402FromHTTPServer } from "./index";

const network = "eip155:84532";
const url = "https://example.com/api/paid";

/**
 * Creates a real HTTP server whose facilitator accepts every payment at verify
 * and rejects it at settle, using only local fixtures.
 *
 * @param failureBody - Configured settlement failure response.
 * @returns An initialized HTTP server.
 */
async function createServer(failureBody?: HTTPResponseBody): Promise<x402HTTPResourceServer> {
  const resourceServer = new x402ResourceServer({
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network }],
      extensions: [],
      signers: {},
    }),
    verify: async () => ({ isValid: true, payer: "fixture-payer" }),
    settle: async () => ({
      success: false,
      errorReason: "insufficient_funds",
      payer: "fixture-payer",
      transaction: "",
      network,
    }),
  }).register(network, {
    scheme: "exact",
    parsePrice: async () => ({ amount: "1", asset: "fixture-asset", extra: {} }),
    enhancePaymentRequirements: async requirements => requirements,
    defaultAssetTransferMethod: "default",
    paymentFlows: { default: { supported: ["authorization"], default: "authorization" } },
  });
  const httpServer = new x402HTTPResourceServer(resourceServer, {
    "GET /api/paid": {
      accepts: { scheme: "exact", network, payTo: "fixture-recipient", price: "$0.01" },
      settlementFailedResponseBody: failureBody ? () => failureBody : undefined,
    },
  });
  await httpServer.initialize();
  return httpServer;
}

/**
 * Builds a paid request the way a client does: reads the route's 402 challenge
 * and answers it with a payment for the offered requirements.
 *
 * @param handler - Next handler protecting {@link url}.
 * @returns A request carrying a PAYMENT-SIGNATURE header.
 */
async function createPaidRequest(
  handler: (request: NextRequest) => Promise<NextResponse>,
): Promise<NextRequest> {
  const challenge = await handler(new NextRequest(url));
  const paymentRequired = decodePaymentRequiredHeader(challenge.headers.get("PAYMENT-REQUIRED")!);
  const paymentSignature = encodePaymentSignatureHeader({
    x402Version: paymentRequired.x402Version,
    resource: paymentRequired.resource,
    accepted: paymentRequired.accepts[0],
    payload: { signature: "fixture-signature" },
  });
  return new NextRequest(url, { headers: { "PAYMENT-SIGNATURE": paymentSignature } });
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
        async () => new NextResponse("protected resource", { status: 200 }),
        server,
        undefined,
        undefined,
        false,
      ),
  },
])("custom settlement failure response bodies: $name", ({ wrap }) => {
  it.each([
    { contentType: "text/plain; charset=utf-8", body: "Settlement failed.\nRetry: café." },
    { contentType: "application/x-ndjson", body: '{"step":1}\n{"step":2}\n' },
    { contentType: "text/html; charset=utf-8", body: "<p>Settlement failed.</p>\n<p>Retry.</p>" },
  ])("preserves $contentType bytes and headers", async ({ contentType, body }) => {
    const handler = wrap(await createServer({ contentType, body }));
    const response = await handler(await createPaidRequest(handler));

    expect(await response.text()).toBe(body);
    expect(response.status).toBe(402);
    expect(response.headers.get("Content-Type")).toBe(contentType);
    expect(decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE")!)).toMatchObject({
      success: false,
      errorReason: "insufficient_funds",
    });
  });

  it.each(["application/json", "text/plain"])(
    "keeps object bodies JSON-encoded for %s",
    async contentType => {
      const body = { error: "Settlement failed", retry: { afterSeconds: 30 } };
      const handler = wrap(await createServer({ contentType, body }));
      const response = await handler(await createPaidRequest(handler));

      expect(await response.text()).toBe(
        '{"error":"Settlement failed","retry":{"afterSeconds":30}}',
      );
      expect(response.status).toBe(402);
      expect(response.headers.get("Content-Type")).toBe(contentType);
    },
  );

  it.each(["application/json; charset=utf-8", "Application/JSON", "application/problem+json"])(
    "keeps string bodies JSON-encoded for %s",
    async contentType => {
      const body = "Settlement failed.\nRetry.";
      const handler = wrap(await createServer({ contentType, body }));
      const response = await handler(await createPaidRequest(handler));

      expect(await response.text()).toBe('"Settlement failed.\\nRetry."');
      expect(response.headers.get("Content-Type")).toBe(contentType);
    },
  );

  it("preserves the default settlement failure JSON response", async () => {
    const handler = wrap(await createServer());
    const response = await handler(await createPaidRequest(handler));

    expect(await response.json()).toEqual({});
    expect(response.status).toBe(402);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.has("PAYMENT-RESPONSE")).toBe(true);
  });
});
