import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { x402ResourceServer } from "@x402/core/server";
import type { SettleResponse } from "@x402/core/types";
import { paymentMiddleware } from "./index";

const network = "eip155:84532";
const asset = "test-asset";
const payTo = "test-payee";

describe("raw responses through the Fastify lifecycle", () => {
  let app: FastifyInstance;
  const settle = vi.fn(
    async (): Promise<SettleResponse> => ({
      success: true,
      transaction: "test-tx",
      network,
    }),
  );

  beforeEach(async () => {
    settle.mockReset();
    settle.mockResolvedValue({ success: true, transaction: "test-tx", network });
    const server = new x402ResourceServer({
      getSupported: async () => ({
        kinds: [{ x402Version: 2, scheme: "exact", network }],
        extensions: [],
        signers: {},
      }),
      verify: async () => ({ isValid: true }),
      settle,
    }).register(network, {
      scheme: "exact",
      defaultAssetTransferMethod: "default",
      paymentFlows: {
        default: { supported: ["authorization", "upfront"], default: "authorization" },
      },
      parsePrice: async () => ({ amount: "1", asset, extra: {} }),
      enhancePaymentRequirements: async requirements => requirements,
    });
    await server.initialize();
    app = Fastify();
    paymentMiddleware(
      app,
      {
        "/paid": { accepts: { scheme: "exact", network, payTo, price: { amount: "1", asset } } },
        "/upfront": {
          accepts: {
            scheme: "exact",
            network,
            payTo,
            price: { amount: "1", asset },
            extra: { paymentFlow: "upfront" },
          },
        },
      },
      server,
      undefined,
      undefined,
      false,
    );
  });

  afterEach(async () => {
    app.server.closeAllConnections();
    await app.close();
  });

  /**
   * Makes a paid request using advertised requirements and a test facilitator.
   *
   * @param path - Protected route to request.
   * @returns The paid HTTP response.
   */
  async function request(path = "/paid"): Promise<Response> {
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const challenge = await fetch(`${url}${path}`);
    expect(challenge.status).toBe(402);
    const required = decodePaymentRequiredHeader(challenge.headers.get("payment-required")!);
    await challenge.text();
    return fetch(`${url}${path}`, {
      headers: {
        "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({
          x402Version: 2,
          resource: required.resource,
          accepted: required.accepts[0],
          payload: {},
        }),
      },
      signal: AbortSignal.timeout(2000),
    });
  }

  it("completes raw writes with a settlement receipt", async () => {
    app.get("/paid", (_request, reply) => {
      reply.raw.writeHead(201, { "Content-Type": "text/plain", "X-From-Raw": "yes" });
      reply.raw.write("hello ");
      reply.raw.end("world");
    });

    const response = await request();
    expect(response.status).toBe(201);
    expect(response.headers.get("x-from-raw")).toBe("yes");
    expect(await response.text()).toBe("hello world");
    expect(decodePaymentResponseHeader(response.headers.get("payment-response")!)).toMatchObject({
      success: true,
      transaction: "test-tx",
    });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("withholds buffered raw content when settlement fails", async () => {
    settle.mockResolvedValue({ success: false, transaction: "", network });
    app.get("/paid", (_request, reply) => {
      reply.raw.writeHead(200, { "Content-Type": "text/plain" });
      reply.raw.write("private content");
      reply.raw.flushHeaders();
      reply.raw.end();
    });

    const response = await request();
    expect(response.status).toBe(402);
    expect(await response.text()).not.toContain("private content");
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("completes an empty raw response without settling an upfront payment twice", async () => {
    app.get("/upfront", async (_request, reply) => {
      reply.raw.end();
      return reply;
    });

    const response = await request("/upfront");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(decodePaymentResponseHeader(response.headers.get("payment-response")!)).toMatchObject({
      success: true,
      transaction: "test-tx",
    });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("returns an error without replaying raw content when a later onSend hook fails", async () => {
    app.addHook("onSend", async (_request, reply, payload) => {
      if (reply.statusCode === 200) throw new Error("response hook failed");
      return payload;
    });
    app.get("/paid", (_request, reply) => {
      reply.raw.writeHead(200, { "Content-Type": "text/plain" });
      reply.raw.end("private content");
    });

    const response = await request();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private content");
    expect(settle).toHaveBeenCalledTimes(1);
  });
});
