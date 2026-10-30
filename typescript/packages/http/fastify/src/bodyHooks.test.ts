import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "./index";

describe("payment hooks and parsed request bodies", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify();
  });

  afterEach(async () => {
    await app?.close();
  });

  /**
   * Observes the body during payment processing without making a payment.
   *
   * @returns Bodies observed by the protected-request hook.
   */
  function observePaymentBody(): unknown[] {
    const bodies: unknown[] = [];
    const httpServer = new x402HTTPResourceServer(new x402ResourceServer(), {
      "POST /quote": {
        accepts: {
          scheme: "exact",
          network: "eip155:84532",
          payTo: "0x123",
          price: "$0.01",
        },
      },
    }).onProtectedRequest(async context => {
      bodies.push(structuredClone(await context.adapter.getBody?.()));
      return { grantAccess: true };
    });
    paymentMiddlewareFromHTTPServer(app, httpServer, undefined, undefined, false);
    return bodies;
  }

  it("makes the JSON body available to the payment hook and the route", async () => {
    const expected = { quantity: 2 };
    const bodies = observePaymentBody();
    const handler = vi.fn(async (request: FastifyRequest) => ({ body: request.body }));
    app.post("/quote", handler);

    const response = await app.inject({ method: "POST", url: "/quote", payload: expected });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ body: expected });
    expect(bodies).toEqual([expected]);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("uses custom content-type parsers without consuming the route body", async () => {
    app.addContentTypeParser(
      "application/x-quantity",
      { parseAs: "string" },
      (_req, body, done) => {
        done(null, { quantity: Number(body) });
      },
    );
    const bodies = observePaymentBody();
    app.post("/quote", async request => request.body);

    const response = await app.inject({
      method: "POST",
      url: "/quote",
      headers: { "content-type": "application/x-quantity" },
      payload: "2",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ quantity: 2 });
    expect(bodies).toEqual([{ quantity: 2 }]);
  });

  it("reads the parsed body before schema coercion, leaving validation to Fastify", async () => {
    const bodies = observePaymentBody();
    app.post(
      "/quote",
      {
        schema: {
          body: {
            type: "object",
            required: ["quantity"],
            properties: { quantity: { type: "integer", minimum: 1 } },
          },
        },
      },
      async request => request.body,
    );

    const response = await app.inject({
      method: "POST",
      url: "/quote",
      payload: { quantity: "2" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ quantity: 2 });
    expect(bodies).toEqual([{ quantity: "2" }]);
  });

  it.each([
    { name: "malformed JSON", payload: '{"quantity":', status: 400 },
    {
      name: "an oversized body",
      payload: JSON.stringify({ quantity: "x".repeat(32) }),
      status: 413,
    },
  ])(
    "rejects $name before payment processing or the route handler",
    async ({ payload, status }) => {
      const bodies = observePaymentBody();
      const handler = vi.fn(async () => "ok");
      app.post(
        "/quote",
        {
          bodyLimit: 16,
          schema: {
            body: {
              type: "object",
              required: ["quantity"],
              properties: { quantity: { type: "integer", minimum: 1 } },
            },
          },
        },
        handler,
      );

      const response = await app.inject({
        method: "POST",
        url: "/quote",
        headers: { "content-type": "application/json" },
        payload,
      });

      expect(response.statusCode).toBe(status);
      expect(bodies).toEqual([]);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("preserves payment headers before header-schema validation removes undeclared fields", async () => {
    const observed: unknown[] = [];
    const httpServer = new x402HTTPResourceServer(new x402ResourceServer(), {
      "POST /quote": {
        accepts: { scheme: "exact", network: "eip155:84532", payTo: "0x123", price: "$0.01" },
      },
    }).onProtectedRequest(async context => {
      observed.push({
        body: structuredClone(await context.adapter.getBody?.()),
        paymentHeader: context.paymentHeader,
        adapterHeader: context.adapter.getHeader("payment-signature"),
      });
      return { grantAccess: true };
    });
    paymentMiddlewareFromHTTPServer(app, httpServer, undefined, undefined, false);
    app.post(
      "/quote",
      {
        schema: {
          headers: {
            type: "object",
            properties: { "content-type": { type: "string" } },
            additionalProperties: false,
          },
        },
      },
      async request => ({
        body: request.body,
        hasPaymentHeader: "payment-signature" in request.headers,
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/quote",
      headers: { "payment-signature": "test-signature" },
      payload: { quantity: 2 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ body: { quantity: 2 }, hasPaymentHeader: false });
    expect(observed).toEqual([
      { body: { quantity: 2 }, paymentHeader: "test-signature", adapterHeader: "test-signature" },
    ]);
  });

  it("checks payment before a subsequently registered preValidation hook can serve content", async () => {
    const httpServer = new x402HTTPResourceServer(new x402ResourceServer(), {
      "POST /quote": {
        accepts: { scheme: "exact", network: "eip155:84532", payTo: "0x123", price: "$0.01" },
      },
    }).onProtectedRequest(async () => ({ abort: true, reason: "Payment access denied" }));
    paymentMiddlewareFromHTTPServer(app, httpServer, undefined, undefined, false);
    const cachedResponse = vi.fn(async (_request: FastifyRequest, reply: FastifyReply) =>
      reply.send({ cached: "paid content" }),
    );
    app.addHook("preValidation", cachedResponse);
    const handler = vi.fn(async () => "ok");
    app.post("/quote", handler);

    const response = await app.inject({ method: "POST", url: "/quote", payload: { quantity: 2 } });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Payment access denied" });
    expect(cachedResponse).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("builds payment requirements from the parsed body before returning 402", async () => {
    const network = "eip155:84532";
    const asset = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const verify = vi.fn();
    const settle = vi.fn();
    const resourceServer = new x402ResourceServer({
      getSupported: async () => ({
        kinds: [{ x402Version: 2, scheme: "exact", network }],
        extensions: [],
        signers: {},
      }),
      verify,
      settle,
    });
    resourceServer.register(network, {
      scheme: "exact",
      parsePrice: async price => ({ amount: String(price), asset, extra: {} }),
      enhancePaymentRequirements: async requirements => requirements,
      defaultAssetTransferMethod: "default",
      paymentFlows: { default: { supported: ["upfront"], default: "upfront" } },
    });
    await resourceServer.initialize();
    const httpServer = new x402HTTPResourceServer(resourceServer, {
      "POST /quote": {
        accepts: {
          scheme: "exact",
          network,
          payTo: "0x123",
          price: async context => {
            const body = (await context.adapter.getBody?.()) as { quantity: number };
            return body.quantity * 100;
          },
        },
      },
    });
    paymentMiddlewareFromHTTPServer(app, httpServer, undefined, undefined, false);
    const handler = vi.fn(async () => "ok");
    app.post("/quote", handler);

    const response = await app.inject({ method: "POST", url: "/quote", payload: { quantity: 2 } });

    expect(response.statusCode).toBe(402);
    const paymentRequired = JSON.parse(
      Buffer.from(String(response.headers["payment-required"]), "base64").toString("utf8"),
    );
    expect(paymentRequired.accepts[0]).toMatchObject({ amount: "200", asset });
    expect(handler).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
});
