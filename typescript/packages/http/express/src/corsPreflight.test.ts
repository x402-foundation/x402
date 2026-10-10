import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import http from "node:http";
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
 * Issue a single HTTP request and return the response status.
 *
 * @param port - The local server port.
 * @param method - The HTTP method.
 * @param path - The request path.
 * @returns The response status code.
 */
async function statusFor(port: number, method: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path }, res => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("express end-to-end: CORS preflight on a paid route", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const app = express();
    const resourceServer = await buildTestResourceServer();
    const accepts = {
      scheme: "exact",
      payTo: "0xabc",
      price: "$1.00",
      network: TEST_NETWORK,
    };
    app.use(
      paymentMiddleware(
        {
          "/api/premium": { accepts },
          "OPTIONS /api/options-paid": { accepts },
        },
        resourceServer,
        undefined,
        undefined,
        // syncFacilitatorOnStart=false so the test does not try to call a real facilitator
        false,
      ),
    );
    // Stands in for the app's CORS layer: preflights get 204, everything else 200.
    app.use((req, res) => res.sendStatus(req.method === "OPTIONS" ? 204 : 200));

    server = app.listen(0);
    await new Promise<void>(resolve => server.once("listening", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("passes OPTIONS on a method-less route through to the app", async () => {
    expect(await statusFor(port, "OPTIONS", "/api/premium")).toBe(204);
  });

  it("still returns 402 for other methods on a method-less route", async () => {
    expect(await statusFor(port, "GET", "/api/premium")).toBe(402);
    expect(await statusFor(port, "POST", "/api/premium")).toBe(402);
  });

  it("returns 402 for an explicit OPTIONS route", async () => {
    expect(await statusFor(port, "OPTIONS", "/api/options-paid")).toBe(402);
  });
});
