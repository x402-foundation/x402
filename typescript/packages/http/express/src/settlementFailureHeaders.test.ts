import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FacilitatorResponseError, x402ResourceServer } from "@x402/core/server";
import type { SettleResponse } from "@x402/core/types";
import { paymentMiddleware } from "./index";

const TEST_NETWORK = "eip155:84532";

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/**
 * Starts an app whose paid handler sets headers, then settles with `settle`.
 *
 * @param settle - Facilitator settle implementation
 * @returns Base URL of the running app
 */
async function startApp(settle: () => Promise<SettleResponse>): Promise<string> {
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

  const app = express();
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "https://app.example");
    next();
  });
  app.use(
    paymentMiddleware(
      {
        "GET /paid": {
          accepts: { scheme: "exact", payTo: "0xabc", price: "$1", network: TEST_NETWORK },
        },
      },
      resourceServer,
      undefined,
      undefined,
      false,
    ),
  );
  app.get("/paid", (_req, res) => {
    res.cookie("session", "paid-access");
    res.attachment("report.pdf");
    res.send("paid content");
  });

  server = app.listen(0);
  await new Promise<void>(resolve => server!.once("listening", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

describe("express end-to-end: settlement failure after the handler ran", () => {
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
});
