import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { FacilitatorClient, HTTPResponseBody } from "@x402/core/server";
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "./index";

const network = "eip155:84532";
const bodies = [
  {
    name: "plain text",
    contentType: "text/plain",
    body: "Payment required",
    expected: "Payment required",
  },
  {
    name: "newlines and UTF-8",
    contentType: "text/plain; charset=utf-8",
    body: "Payment required.\n预览",
    expected: "Payment required.\n预览",
  },
  { name: "empty text", contentType: "text/plain", body: "", expected: "" },
  {
    name: "HTML",
    contentType: "text/html",
    body: "<p>Payment required</p>",
    expected: "<p>Payment required</p>",
  },
  {
    name: "mixed-case HTML",
    contentType: "Text/HTML; charset=utf-8",
    body: "<p>Payment required</p>",
    expected: "<p>Payment required</p>",
  },
  {
    name: "JSON object",
    contentType: "application/json",
    body: { error: "Payment required" },
    expected: '{"error":"Payment required"}',
  },
  {
    name: "JSON string",
    contentType: "application/json",
    body: "Payment required.\nPreview",
    expected: '"Payment required.\\nPreview"',
  },
  {
    name: "mixed-case JSON",
    contentType: "Application/JSON; charset=utf-8",
    body: "Payment required",
    expected: '"Payment required"',
  },
  {
    name: "JSON suffix",
    contentType: "application/problem+json",
    body: "Payment required",
    expected: '"Payment required"',
  },
] satisfies (HTTPResponseBody & { name: string; expected: string })[];

/**
 * Builds a real core server and Hono middleware with local payment fixtures.
 *
 * @param customBody - Optional custom payment error body.
 * @returns App and spies for the protected handler and facilitator calls.
 */
async function buildApp(customBody?: HTTPResponseBody) {
  const verify = vi.fn<FacilitatorClient["verify"]>(async () => ({
    isValid: true,
    payer: "fixture-payer",
  }));
  const settle = vi.fn<FacilitatorClient["settle"]>(async () => ({
    success: false,
    errorReason: "fixture_settlement_failed",
    transaction: "",
    network,
  }));
  const server = new x402ResourceServer({
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network }],
      extensions: [],
      signers: {},
    }),
    verify,
    settle,
  }).register(network, {
    scheme: "exact",
    defaultAssetTransferMethod: "default",
    paymentFlows: { default: { supported: ["authorization"], default: "authorization" } },
    parsePrice: async () => ({ amount: "1", asset: "fixture-asset", extra: {} }),
    enhancePaymentRequirements: async requirements => requirements,
  });
  const httpServer = new x402HTTPResourceServer(server, {
    "GET /paid": {
      accepts: { scheme: "exact", network, payTo: "fixture-recipient", price: "$0.01" },
      unpaidResponseBody: customBody ? () => customBody : undefined,
      settlementFailedResponseBody: customBody ? () => customBody : undefined,
    },
  });
  await httpServer.initialize();
  const app = new Hono();
  app.use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));
  const handler = vi.fn(() => new Response("protected resource"));
  app.get("/paid", handler);
  return { app, verify, settle, handler };
}

describe.each(["unpaid", "settlement failure"] as const)("custom %s response body", mode => {
  it.each([...bodies, { name: "default body", contentType: "application/json", expected: "{}" }])(
    "preserves $name serialization through the Hono fetch handler",
    async fixture => {
      const { app, verify, settle, handler } = await buildApp(
        "body" in fixture ? fixture : undefined,
      );
      let response = await app.request("/paid");
      const paymentRequired = decodePaymentRequiredHeader(
        response.headers.get("PAYMENT-REQUIRED")!,
      );
      expect(paymentRequired.accepts[0].amount).toBe("1");
      expect(handler).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();

      if (mode === "settlement failure") {
        response = await app.request("/paid", {
          headers: {
            "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({
              x402Version: 2,
              resource: paymentRequired.resource,
              accepted: paymentRequired.accepts[0],
              payload: {},
            }),
          },
        });
        expect(handler).toHaveBeenCalledOnce();
        expect(verify).toHaveBeenCalledOnce();
        expect(settle).toHaveBeenCalledOnce();
        const receipt = decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE")!);
        expect(receipt.success).toBe(false);
        expect(receipt.errorReason).toBe("fixture_settlement_failed");
      }

      expect(response.status).toBe(402);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(response.headers.get("Content-Type")).toBe(fixture.contentType);
      expect(await response.text()).toBe(fixture.expected);
    },
  );
});
