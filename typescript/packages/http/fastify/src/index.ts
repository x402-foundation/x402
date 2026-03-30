import type { ServerResponse } from "http";
import {
  HTTPRequestContext,
  PaywallConfig,
  PaywallProvider,
  x402HTTPResourceServer,
  x402ResourceServer,
  RoutesConfig,
  FacilitatorClient,
  FacilitatorResponseError,
  getFacilitatorResponseError,
  SETTLEMENT_OVERRIDES_HEADER,
  SettlementOverrides,
} from "@x402/core/server";
import {
  SchemeNetworkServer,
  Network,
  PaymentPayload,
  PaymentRequirements,
} from "@x402/core/types";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { FastifyAdapter } from "./adapter";

/**
 * Sets settlement overrides on a Fastify reply for partial settlement (upto scheme).
 * The middleware extracts these before settlement and strips the header from the client response.
 *
 * @param reply - The Fastify reply object
 * @param overrides - Settlement overrides (e.g., { amount: "500" } for partial settlement)
 */
export function setSettlementOverrides(reply: FastifyReply, overrides: SettlementOverrides): void {
  reply.header(SETTLEMENT_OVERRIDES_HEADER, JSON.stringify(overrides));
}

interface X402PaymentContext {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
  declaredExtensions?: Record<string, unknown>;
  requestContext: HTTPRequestContext;
}

interface BufferedWriteHead {
  method: "writeHead";
  statusCode: number;
  headers?: Record<string, unknown>;
}

interface BufferedWrite {
  method: "write";
  data: string | Buffer;
}

interface BufferedEnd {
  method: "end";
  data?: string | Buffer;
}

interface BufferedFlushHeaders {
  method: "flushHeaders";
}

type BufferedRawCall = BufferedWriteHead | BufferedWrite | BufferedEnd | BufferedFlushHeaders;

interface RawGuard {
  triggered: boolean;
  buffer: BufferedRawCall[];
  deactivate: () => void;
}

declare module "fastify" {
  interface FastifyRequest {
    x402Context?: X402PaymentContext;
    x402RawGuard?: RawGuard;
  }
}

/**
 * Gets a header value from a plain header record using a case-insensitive lookup.
 *
 * @param headers - Headers to search
 * @param headerName - Header name to find
 * @returns Matching header value or undefined
 */
function getHeaderValue(headers: Record<string, string>, headerName: string): string | undefined {
  const target = headerName.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
}

/**
 * Converts a Fastify onSend payload into the byte representation used for settlement.
 *
 * @param payload - Fastify payload
 * @returns Buffer when the payload can be represented eagerly, otherwise undefined
 */
function getResponseBodyBuffer(payload: unknown): Buffer | undefined {
  if (typeof payload === "string") {
    return Buffer.from(payload);
  }

  if (Buffer.isBuffer(payload)) {
    return payload;
  }

  if (payload instanceof Uint8Array) {
    return Buffer.from(payload);
  }

  if (payload instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(payload));
  }

  if (payload && typeof payload === "object" && "pipe" in payload) {
    return undefined;
  }

  return Buffer.from(JSON.stringify(payload ?? {}));
}

/**
 * Check if any routes in the configuration declare bazaar extensions.
 *
 * @param routes - Route configuration
 * @returns True if any route has extensions.bazaar defined
 */
function checkIfBazaarNeeded(routes: RoutesConfig): boolean {
  if ("accepts" in routes) {
    return !!(routes.extensions && "bazaar" in routes.extensions);
  }

  return Object.values(routes).some(routeConfig => {
    return !!(routeConfig.extensions && "bazaar" in routeConfig.extensions);
  });
}

/**
 * Buffers reply.raw method calls on a protected route so that settlement
 * can inspect the response body before anything reaches the client.
 *
 * Fastify's normal reply flow (return value / reply.send) goes through the
 * onSend hook where settlement runs before data reaches the client.  However,
 * reply.raw gives direct access to the underlying Node.js ServerResponse,
 * allowing data to be flushed without triggering onSend.
 *
 * This guard intercepts writeHead/write/end/flushHeaders, stores them in a
 * buffer, and ensures Fastify's lifecycle still fires (via reply.send on end)
 * so that onSend can reconstruct the response, settle, then replay the calls.
 *
 * The guard is deactivated at the start of onSend so that Fastify's own
 * internal reply.raw usage (which happens after onSend) is unaffected.
 *
 * @param reply - Fastify reply whose raw ServerResponse is wrapped for buffering.
 * @returns Guard state and buffer used to replay raw writes after settlement.
 */
function guardReplyRaw(reply: FastifyReply): RawGuard {
  const raw = reply.raw;
  const origWrite = raw.write;
  const origEnd = raw.end;
  const origWriteHead = raw.writeHead;
  const origFlushHeaders = raw.flushHeaders;

  let active = true;
  const guard: RawGuard = {
    triggered: false,
    buffer: [],
    deactivate() {
      if (!active) return;
      active = false;
      raw.write = origWrite;
      raw.end = origEnd;
      raw.writeHead = origWriteHead;
      raw.flushHeaders = origFlushHeaders;
    },
  };

  raw.writeHead = function (this: ServerResponse, ...args: unknown[]) {
    if (active) {
      guard.triggered = true;
      const statusCode = args[0] as number;
      const headers = (typeof args[1] === "string" ? args[2] : args[1]) as
        | Record<string, unknown>
        | undefined;
      guard.buffer.push({ method: "writeHead", statusCode, headers });
      return this;
    }
    return Reflect.apply(origWriteHead, this, args) as ServerResponse;
  } as ServerResponse["writeHead"];

  raw.write = function (this: ServerResponse, ...args: unknown[]) {
    if (active) {
      guard.triggered = true;
      guard.buffer.push({ method: "write", data: args[0] as string | Buffer });
      return true;
    }
    return Reflect.apply(origWrite, this, args) as boolean;
  } as ServerResponse["write"];

  raw.end = function (this: ServerResponse, ...args: unknown[]) {
    if (active) {
      guard.triggered = true;
      const data =
        typeof args[0] === "function" ? undefined : (args[0] as string | Buffer | undefined);
      guard.buffer.push({ method: "end", data });
      return this;
    }
    return Reflect.apply(origEnd, this, args) as ServerResponse;
  } as ServerResponse["end"];

  raw.flushHeaders = function (this: ServerResponse) {
    if (active) {
      guard.triggered = true;
      guard.buffer.push({ method: "flushHeaders" });
    } else {
      origFlushHeaders.call(this);
    }
  };

  return guard;
}

/**
 * Sends a normalized 502 response for facilitator boundary failures.
 *
 * @param reply - The Fastify reply to write to
 * @param error - The facilitator response error to surface
 */
function sendFacilitatorError(reply: FastifyReply, error: FacilitatorResponseError): void {
  reply.status(502).send({ error: error.message });
}

/**
 * Configuration for registering a payment scheme with a specific network.
 */
export interface SchemeRegistration {
  /**
   * The network identifier (e.g., 'eip155:84532', 'solana:mainnet')
   */
  network: Network;

  /**
   * The scheme server implementation for this network
   */
  server: SchemeNetworkServer;
}

/**
 * Registers x402 payment middleware on a Fastify instance using a pre-configured HTTP server.
 *
 * Use this when you need to configure HTTP-level hooks.
 *
 * @param app - The Fastify instance
 * @param httpServer - Pre-configured x402HTTPResourceServer instance
 * @param paywallConfig - Optional configuration for the built-in paywall UI
 * @param paywall - Optional custom paywall provider (overrides default)
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on startup (defaults to true)
 *
 * @example
 * ```typescript
 * import { paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from "@x402/fastify";
 *
 * const resourceServer = new x402ResourceServer(facilitatorClient)
 *   .register(NETWORK, new ExactEvmScheme());
 *
 * const httpServer = new x402HTTPResourceServer(resourceServer, routes)
 *   .onProtectedRequest(requestHook);
 *
 * paymentMiddlewareFromHTTPServer(app, httpServer);
 * ```
 */
export function paymentMiddlewareFromHTTPServer(
  app: FastifyInstance,
  httpServer: x402HTTPResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart: boolean = true,
): void {
  if (paywall) {
    httpServer.registerPaywallProvider(paywall);
  }

  app.decorateRequest("x402Context", undefined);
  app.decorateRequest("x402RawGuard", undefined);

  let initPromise: Promise<void> | null = syncFacilitatorOnStart ? httpServer.initialize() : null;
  let isInitialized = false;

  /**
   * Ensures facilitator initialization succeeds once, while allowing retries after failures.
   */
  async function initializeHttpServer(): Promise<void> {
    if (!syncFacilitatorOnStart || isInitialized) {
      return;
    }

    if (!initPromise) {
      initPromise = httpServer.initialize();
    }

    try {
      await initPromise;
      isInitialized = true;
    } catch (error) {
      initPromise = null;
      throw error;
    }
  }

  let bazaarPromise: Promise<void> | null = null;
  if (checkIfBazaarNeeded(httpServer.routes) && !httpServer.server.hasExtension("bazaar")) {
    bazaarPromise = import("@x402/extensions/bazaar")
      .then(({ bazaarResourceServerExtension }) => {
        httpServer.server.registerExtension(bazaarResourceServerExtension);
      })
      .catch(err => {
        console.error("Failed to load bazaar extension:", err);
      });
  }

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split("?")[0];
    const adapter = new FastifyAdapter(request);
    const context: HTTPRequestContext = {
      adapter,
      path,
      method: request.method,
      paymentHeader:
        (request.headers["payment-signature"] as string | undefined) ||
        (request.headers["x-payment"] as string | undefined),
    };

    if (!httpServer.requiresPayment(context)) {
      return;
    }

    if (syncFacilitatorOnStart && !isInitialized) {
      try {
        await initializeHttpServer();
      } catch (error) {
        const facilitatorError = getFacilitatorResponseError(error);
        if (facilitatorError) {
          return sendFacilitatorError(reply, facilitatorError);
        }
        throw error;
      }
    }

    if (bazaarPromise) {
      await bazaarPromise;
      bazaarPromise = null;
    }

    let result: Awaited<ReturnType<x402HTTPResourceServer["processHTTPRequest"]>>;
    try {
      result = await httpServer.processHTTPRequest(context, paywallConfig);
    } catch (error) {
      if (error instanceof FacilitatorResponseError) {
        return sendFacilitatorError(reply, error);
      }
      throw error;
    }

    switch (result.type) {
      case "no-payment-required":
        return;

      case "payment-error": {
        const { response } = result;
        for (const [key, value] of Object.entries(response.headers)) {
          reply.header(key, value);
        }
        if (response.isHtml) {
          return reply.status(response.status).type("text/html").send(response.body);
        } else {
          return reply.status(response.status).send(response.body || {});
        }
      }

      case "payment-verified": {
        request.x402Context = {
          paymentPayload: result.paymentPayload,
          paymentRequirements: result.paymentRequirements,
          declaredExtensions: result.declaredExtensions,
          requestContext: context,
        };
        request.x402RawGuard = guardReplyRaw(reply);
        return;
      }
    }
  });

  app.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const rawGuard = request.x402RawGuard;
    if (rawGuard) {
      rawGuard.deactivate();
    }

    const x402Context = request.x402Context;
    if (!x402Context) {
      return payload;
    }

    let effectivePayload: unknown = payload;
    if (rawGuard?.triggered && rawGuard.buffer.length > 0) {
      const writeHeadCall = rawGuard.buffer.find(
        (c): c is BufferedWriteHead => c.method === "writeHead",
      );
      if (writeHeadCall) {
        reply.status(writeHeadCall.statusCode);
        if (writeHeadCall.headers) {
          for (const [key, value] of Object.entries(writeHeadCall.headers)) {
            if (value != null) reply.header(key, String(value));
          }
        }
      }

      const bodyChunks: Buffer[] = [];
      for (const call of rawGuard.buffer) {
        if (call.method === "write") {
          bodyChunks.push(Buffer.from(call.data));
        } else if (call.method === "end" && call.data != null) {
          bodyChunks.push(Buffer.from(call.data));
        }
      }
      if (bodyChunks.length > 0) {
        effectivePayload = Buffer.concat(bodyChunks);
      }
    }

    if (reply.statusCode >= 400) {
      return effectivePayload;
    }

    try {
      const responseBody = getResponseBodyBuffer(effectivePayload);

      const responseHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(reply.getHeaders())) {
        if (value != null) {
          responseHeaders[key] = String(value);
        }
      }

      const settleResult = await httpServer.processSettlement(
        x402Context.paymentPayload,
        x402Context.paymentRequirements,
        x402Context.declaredExtensions,
        { request: x402Context.requestContext, responseBody, responseHeaders },
      );

      if (!settleResult.success) {
        const { response } = settleResult;
        for (const [key, value] of Object.entries(response.headers)) {
          reply.header(key, value);
        }
        reply.status(response.status);
        reply.type(
          getHeaderValue(response.headers, "content-type") ||
            (response.isHtml ? "text/html" : "application/json"),
        );
        return response.isHtml ? String(response.body ?? "") : JSON.stringify(response.body ?? {});
      }

      for (const [key, value] of Object.entries(settleResult.headers)) {
        reply.header(key, value);
      }
      return effectivePayload;
    } catch (error) {
      if (error instanceof FacilitatorResponseError) {
        reply.status(502);
        reply.type("application/json");
        return JSON.stringify({ error: error.message });
      }
      console.error(error);
      reply.status(402);
      reply.type("application/json");
      return JSON.stringify({});
    }
  });
}

/**
 * Registers x402 payment middleware on a Fastify instance using a pre-configured resource server.
 *
 * Use this when you want to pass a pre-configured x402ResourceServer instance.
 * This provides more flexibility for testing, custom configuration, and reusing
 * server instances across multiple middlewares.
 *
 * @param app - The Fastify instance
 * @param routes - Route configurations for protected endpoints
 * @param server - Pre-configured x402ResourceServer instance
 * @param paywallConfig - Optional configuration for the built-in paywall UI
 * @param paywall - Optional custom paywall provider (overrides default)
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on startup (defaults to true)
 *
 * @example
 * ```typescript
 * import { paymentMiddleware } from "@x402/fastify";
 *
 * const server = new x402ResourceServer(myFacilitatorClient)
 *   .register(NETWORK, new ExactEvmScheme());
 *
 * paymentMiddleware(app, routes, server, paywallConfig);
 * ```
 */
export function paymentMiddleware(
  app: FastifyInstance,
  routes: RoutesConfig,
  server: x402ResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart: boolean = true,
): void {
  const httpServer = new x402HTTPResourceServer(server, routes);

  paymentMiddlewareFromHTTPServer(app, httpServer, paywallConfig, paywall, syncFacilitatorOnStart);
}

/**
 * Registers x402 payment middleware on a Fastify instance using configuration.
 *
 * Use this when you want to quickly set up middleware with simple configuration.
 * This function creates and configures the x402ResourceServer internally.
 *
 * @param app - The Fastify instance
 * @param routes - Route configurations for protected endpoints
 * @param facilitatorClients - Optional facilitator client(s) for payment processing
 * @param schemes - Optional array of scheme registrations for server-side payment processing
 * @param paywallConfig - Optional configuration for the built-in paywall UI
 * @param paywall - Optional custom paywall provider (overrides default)
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on startup (defaults to true)
 *
 * @example
 * ```typescript
 * import { paymentMiddlewareFromConfig } from "@x402/fastify";
 *
 * paymentMiddlewareFromConfig(
 *   app,
 *   routes,
 *   myFacilitatorClient,
 *   [{ network: "eip155:8453", server: evmSchemeServer }],
 *   paywallConfig
 * );
 * ```
 */
export function paymentMiddlewareFromConfig(
  app: FastifyInstance,
  routes: RoutesConfig,
  facilitatorClients?: FacilitatorClient | FacilitatorClient[],
  schemes?: SchemeRegistration[],
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart: boolean = true,
): void {
  const ResourceServer = new x402ResourceServer(facilitatorClients);

  if (schemes) {
    for (const { network, server: schemeServer } of schemes) {
      ResourceServer.register(network, schemeServer);
    }
  }

  paymentMiddleware(app, routes, ResourceServer, paywallConfig, paywall, syncFacilitatorOnStart);
}

export { x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";

export type {
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
  Network,
  SchemeNetworkServer,
} from "@x402/core/types";

export type { PaywallProvider, PaywallConfig } from "@x402/core/server";

export { RouteConfigurationError, SETTLEMENT_OVERRIDES_HEADER } from "@x402/core/server";

export type { RouteValidationError } from "@x402/core/server";

export { FastifyAdapter } from "./adapter";
