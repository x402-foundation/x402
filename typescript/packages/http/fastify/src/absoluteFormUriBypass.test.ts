import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "./index";

/** Network the routing tests price their protected routes on. */
const TEST_NETWORK = "eip155:84532";

/**
 * Builds an initialized resource server with the `exact` scheme registered and
 * a stub facilitator advertising it, so a matched route answers 402 instead of
 * failing to build payment requirements.
 *
 * @returns A resource server that serves a real 402 for a matched route.
 */
async function buildTestResourceServer(): Promise<x402ResourceServer> {
  const resourceServer = new x402ResourceServer({
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network: TEST_NETWORK }],
      extensions: [],
      signers: {},
    }),
    verify: async () => ({ isValid: true }),
    settle: async () => ({ success: true, transaction: "", network: TEST_NETWORK }),
  });
  resourceServer.register(TEST_NETWORK, {
    scheme: "exact",
    parsePrice: async () => ({
      amount: "1000000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      extra: {},
    }),
    enhancePaymentRequirements: async paymentRequirements => paymentRequirements,
    defaultAssetTransferMethod: "default",
    paymentFlows: { default: { supported: ["upfront"], default: "upfront" } },
  });
  await resourceServer.initialize();
  return resourceServer;
}

/**
 * Sends a raw HTTP/1.1 request line over a plain socket and returns the
 * response status. Node's `http.request` normalizes/validates the `path`
 * option and won't let us put an absolute-form request-target on the wire,
 * so this talks to the socket directly the way a real HTTP client (or an
 * attacker) can.
 *
 * @param port - The local server port.
 * @param requestTarget - The raw HTTP request-target, sent verbatim.
 * @returns The response status code.
 */
async function statusForRawTarget(port: number, requestTarget: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${requestTarget} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
    });
    let data = "";
    socket.on("data", chunk => (data += chunk.toString()));
    socket.on("end", () => {
      const statusLine = data.split("\r\n")[0] ?? "";
      const match = statusLine.match(/^HTTP\/1\.[01] (\d{3})/);
      resolve(match ? Number(match[1]) : 0);
    });
    socket.on("error", reject);
  });
}

/**
 * Reproduces HackerOne report 4016470: an HTTP/1.1 request using absolute-form
 * request-target (RFC 7230 5.3.2), e.g. `GET https://attacker.com/protected-route
 * HTTP/1.1`, bypasses the payment gate. Fastify's `request.url` is the raw,
 * unparsed request-target, so it keeps the scheme+authority. The gate's route
 * matching then fails against the configured pattern and skips payment
 * verification entirely — while find-my-way (Fastify's router) strips the
 * scheme+authority before routing and dispatches straight to the protected
 * handler, resulting in a complete paywall bypass.
 */
describe("fastify end-to-end: absolute-form request-target bypass", () => {
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    app = Fastify();
    const resourceServer = await buildTestResourceServer();
    paymentMiddleware(
      app,
      {
        "GET /protected-route": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00",
            network: TEST_NETWORK,
          },
        },
      },
      resourceServer,
      undefined,
      undefined,
      // syncFacilitatorOnStart=false so the test does not try to call a real facilitator
      false,
    );
    app.get("/protected-route", async () => "paid content");
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 402 for the baseline origin-form request", async () => {
    expect(await statusForRawTarget(port, "/protected-route")).toBe(402);
  });

  it("returns 402 for an absolute-form https:// request-target", async () => {
    expect(await statusForRawTarget(port, "https://attacker.com/protected-route")).toBe(402);
  });

  it("returns 402 for an absolute-form http:// request-target", async () => {
    expect(await statusForRawTarget(port, "http://attacker.com/protected-route")).toBe(402);
  });

  it("returns 402 for an absolute-form request-target with a different port", async () => {
    expect(await statusForRawTarget(port, "https://attacker.com:1337/protected-route")).toBe(402);
  });

  it("returns 402 for an absolute-form request-target carrying a query string", async () => {
    expect(await statusForRawTarget(port, "https://attacker.com/protected-route?x=1")).toBe(402);
  });
});
