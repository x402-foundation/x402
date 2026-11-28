import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import {
  FacilitatorResponseError,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import type { SettleResponse } from "@x402/core/types";
import { paymentMiddlewareFromHTTPServer } from "./index";

const TEST_NETWORK = "eip155:84532";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Builds the paid HTTP server that settles with `settle`.
 *
 * @param settle - Facilitator settle implementation
 * @returns Server whose authorization flow runs the handler before settlement
 */
async function createHttpServer(
  settle: () => Promise<SettleResponse>,
): Promise<x402HTTPResourceServer> {
  const resourceServer = new x402ResourceServer({
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network: TEST_NETWORK }],
      extensions: [],
      signers: {},
    }),
    verify: async () => ({ isValid: true, payer: "0xpayer" }),
    settle,
  });
  resourceServer.register(TEST_NETWORK, {
    scheme: "exact",
    parsePrice: async () => ({ amount: "1", asset: "0xasset", extra: {} }),
    enhancePaymentRequirements: async requirements => requirements,
    defaultAssetTransferMethod: "default",
    paymentFlows: { default: { supported: ["authorization"], default: "authorization" } },
  });
  await resourceServer.initialize();

  return new x402HTTPResourceServer(resourceServer, {
    "GET /paid": {
      accepts: { scheme: "exact", payTo: "0xabc", price: "$1", network: TEST_NETWORK },
    },
  });
}

/**
 * Builds an app whose paid route sets response headers.
 *
 * @param httpServer - Server installed as the payment middleware
 * @returns The Hono app
 */
function createApp(httpServer: x402HTTPResourceServer): Hono {
  const app = new Hono();
  app.use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));
  app.get("/paid", c => {
    c.header("Set-Cookie", "session=paid-access");
    c.header("Content-Disposition", 'attachment; filename="report.pdf"');
    return c.text("paid content");
  });
  return app;
}

/**
 * Requests the paid route with a payment built from its 402.
 *
 * @param app - The Hono app
 * @returns The paid response
 */
async function payAndFetch(app: Hono): Promise<Response> {
  const unpaid = await app.request("/paid");
  const paymentRequired = JSON.parse(
    Buffer.from(unpaid.headers.get("PAYMENT-REQUIRED")!, "base64").toString(),
  );
  const payload = {
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted: paymentRequired.accepts[0],
    payload: {},
  };
  return app.request("/paid", {
    headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") },
  });
}

describe("hono: settlement failure after the handler ran", () => {
  it.each([
    [
      "settlement fails",
      402,
      async (): Promise<SettleResponse> => ({
        success: false,
        errorReason: "insufficient_funds",
        transaction: "",
        network: TEST_NETWORK,
      }),
    ],
    [
      "the facilitator response is invalid",
      502,
      async (): Promise<SettleResponse> => {
        throw new FacilitatorResponseError("Facilitator settle returned invalid data");
      },
    ],
  ])("drops headers set by the handler when %s", async (_, status, settle) => {
    const response = await payAndFetch(createApp(await createHttpServer(settle)));

    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("paid content");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Content-Disposition")).toBeNull();
  });

  it("drops headers set by the handler when settlement throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const httpServer = await createHttpServer(async () => ({
      success: true,
      transaction: "",
      network: TEST_NETWORK,
    }));
    httpServer.processSettlement = async () => {
      throw new Error("settlement boom");
    };
    const response = await payAndFetch(createApp(httpServer));

    expect(response.status).toBe(402);
    expect(await response.text()).not.toContain("paid content");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Content-Disposition")).toBeNull();
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });
});
