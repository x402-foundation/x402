import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  FacilitatorResponseError,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import type { SettleResponse } from "@x402/core/types";
import { paymentMiddlewareFromHTTPServer } from "./index";

const TEST_NETWORK = "eip155:84532";

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (!app) {
    return;
  }
  app.server.closeAllConnections();
  await app.close();
  app = undefined;
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
 * Listens with a pre-handler CORS header and a paid route that sets response headers.
 *
 * @param httpServer - Server installed as the payment middleware
 * @param prepare - Optional setup that runs before the payment middleware
 * @returns Base URL of the running app
 */
async function listen(
  httpServer: x402HTTPResourceServer,
  prepare?: (instance: FastifyInstance) => void,
): Promise<string> {
  app = Fastify();
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Access-Control-Allow-Origin", "https://app.example");
  });
  prepare?.(app);
  paymentMiddlewareFromHTTPServer(app, httpServer, undefined, undefined, false);
  app.get("/paid", (_request, reply) => {
    reply.header("Set-Cookie", "session=paid-access");
    reply.header("Content-Disposition", 'attachment; filename="report.pdf"');
    reply.send("paid content");
  });

  return app.listen({ port: 0, host: "127.0.0.1" });
}

/**
 * Starts an app whose paid handler sets headers, then settles with `settle`.
 *
 * @param settle - Facilitator settle implementation
 * @returns Base URL of the running app
 */
async function startApp(settle: () => Promise<SettleResponse>): Promise<string> {
  return listen(await createHttpServer(settle));
}

/**
 * Starts an app whose processSettlement throws after the handler runs.
 *
 * @returns Base URL of the running app
 */
async function startAppWithThrowingSettlement(): Promise<string> {
  const httpServer = await createHttpServer(async () => ({
    success: true,
    transaction: "",
    network: TEST_NETWORK,
  }));
  httpServer.processSettlement = async () => {
    throw new Error("settlement boom");
  };
  return listen(httpServer);
}

/**
 * Requests the paid route with a payment built from its 402.
 *
 * @param baseUrl - Base URL of the running app
 * @returns The paid response
 */
async function payAndFetch(baseUrl: string): Promise<Response> {
  const unpaid = await fetch(`${baseUrl}/paid`);
  const paymentRequired = JSON.parse(
    Buffer.from(unpaid.headers.get("PAYMENT-REQUIRED")!, "base64").toString(),
  );
  const payload = {
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted: paymentRequired.accepts[0],
    payload: {},
  };
  return fetch(`${baseUrl}/paid`, {
    headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") },
  });
}

describe("fastify end-to-end: settlement failure after the handler ran", () => {
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
    const response = await payAndFetch(await startApp(settle));

    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("paid content");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Content-Disposition")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");
  });

  it("keeps earlier cookies and drops the handler cookie when settlement fails", async () => {
    const response = await payAndFetch(
      await listen(
        await createHttpServer(async () => ({
          success: false,
          errorReason: "insufficient_funds",
          transaction: "",
          network: TEST_NETWORK,
        })),
        instance => {
          instance.addHook("onRequest", async (_request, reply) => {
            reply.header("Set-Cookie", "csrf=token");
            reply.header("Set-Cookie", "sid=abc");
          });
        },
      ),
    );

    expect(response.status).toBe(402);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toEqual(expect.arrayContaining(["csrf=token", "sid=abc"]));
    expect(cookies.some(cookie => cookie.startsWith("session="))).toBe(false);
  });

  it("drops headers set by the handler when settlement throws", async () => {
    const response = await payAndFetch(await startAppWithThrowingSettlement());

    expect(response.status).toBe(402);
    expect(await response.text()).not.toContain("paid content");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Content-Disposition")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");
  });
});
