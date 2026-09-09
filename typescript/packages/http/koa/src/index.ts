import type { Context, Next, Middleware } from "koa";
import type { Readable } from "stream";
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
  checkIfBazaarNeeded,
} from "@x402/core/server";
import { SchemeNetworkServer, Network } from "@x402/core/types";
import { KoaAdapter } from "./adapter";

/**
 * Checks if a value is a readable stream (duck typing, matching Koa's detection).
 *
 * @param body - The value to check
 * @returns True if the value is a readable stream
 */
function isReadableStream(body: unknown): body is Readable {
  return typeof (body as Readable)?.pipe === "function";
}

/**
 * Set settlement overrides on the response for partial settlement.
 * The middleware will extract these before settlement and strip the header from the client response.
 *
 * @param ctx - Koa context object
 * @param overrides - Settlement overrides (e.g., { amount: "500" } for partial settlement)
 */
export function setSettlementOverrides(ctx: Context, overrides: SettlementOverrides): void {
  ctx.set(SETTLEMENT_OVERRIDES_HEADER, JSON.stringify(overrides));
}

/**
 * Configuration for registering a payment scheme with a specific network
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
 * Sends a normalized 502 response for facilitator boundary failures.
 *
 * @param ctx - The Koa context to write to
 * @param error - The facilitator response error to surface
 */
function sendFacilitatorError(ctx: Context, error: FacilitatorResponseError): void {
  ctx.status = 502;
  ctx.body = { error: error.message };
}

/**
 * Koa payment middleware for x402 protocol (direct HTTP server instance).
 *
 * Use this when you need to configure HTTP-level hooks.
 *
 * @param httpServer - Pre-configured x402HTTPResourceServer instance
 * @param paywallConfig - Optional configuration for the built-in paywall UI
 * @param paywall - Optional custom paywall provider (overrides default)
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on startup (defaults to true)
 * @returns Koa middleware handler
 *
 * @example
 * ```typescript
 * import { paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from "@x402/koa";
 *
 * const resourceServer = new x402ResourceServer(facilitatorClient)
 *   .register(NETWORK, new ExactEvmScheme())
 *
 * const httpServer = new x402HTTPResourceServer(resourceServer, routes)
 *   .onProtectedRequest(requestHook);
 *
 * app.use(paymentMiddlewareFromHTTPServer(httpServer));
 * ```
 */
export function paymentMiddlewareFromHTTPServer(
  httpServer: x402HTTPResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart: boolean = true,
): Middleware {
  // Register custom paywall provider if provided
  if (paywall) {
    httpServer.registerPaywallProvider(paywall);
  }

  // Store initialization promise (not the result)
  // httpServer.initialize() fetches facilitator support and validates routes
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
  if (checkIfBazaarNeeded(httpServer.routes)) {
    if (!httpServer.server.hasExtension("bazaar")) {
      bazaarPromise = import("@x402/extensions/bazaar").then(
        ({ bazaarResourceServerExtension }) => {
          httpServer.server.registerExtension(bazaarResourceServerExtension);
        },
      );
    }
    bazaarPromise = (bazaarPromise ?? Promise.resolve())
      .then(() => import("@x402/extensions/bazaar"))
      .then(({ validateBazaarRouteExtensions }) => {
        validateBazaarRouteExtensions(httpServer.routes);
      })
      .catch(err => {
        console.error("Failed to load bazaar extension:", err);
      });
  }

  return async (ctx: Context, next: Next) => {
    // Create adapter and context
    const adapter = new KoaAdapter(ctx);
    const context: HTTPRequestContext = {
      adapter,
      path: ctx.path,
      method: ctx.method,
      paymentHeader: adapter.getHeader("payment-signature") || adapter.getHeader("x-payment"),
    };

    // Check if route requires payment before initializing facilitator
    if (!httpServer.requiresPayment(context)) {
      return next();
    }

    // Only initialize when processing a protected route
    if (syncFacilitatorOnStart && !isInitialized) {
      try {
        await initializeHttpServer();
      } catch (error) {
        const facilitatorError = getFacilitatorResponseError(error);
        if (facilitatorError) {
          sendFacilitatorError(ctx, facilitatorError);
          return;
        }
        throw error;
      }
    }

    // Await bazaar extension loading if needed
    if (bazaarPromise) {
      await bazaarPromise;
      bazaarPromise = null;
    }

    // Process payment requirement check
    let result: Awaited<ReturnType<x402HTTPResourceServer["processHTTPRequest"]>>;
    try {
      result = await httpServer.processHTTPRequest(context, paywallConfig);
    } catch (error) {
      if (error instanceof FacilitatorResponseError) {
        sendFacilitatorError(ctx, error);
        return;
      }
      throw error;
    }

    // Handle the different result types
    switch (result.type) {
      case "no-payment-required":
        // No payment needed, proceed directly to the route handler
        return next();

      case "payment-error":
        // Payment required but not provided or invalid
        const { response } = result;
        ctx.status = response.status;
        for (const [key, value] of Object.entries(response.headers)) {
          ctx.set(key, value);
        }
        if (response.isHtml) {
          ctx.body = response.body;
        } else {
          ctx.body = response.body || {};
        }
        return;

      case "payment-verified":
        // Payment is valid, need to wrap response for settlement
        const { cancellationDispatcher, paymentPayload, paymentRequirements, declaredExtensions } =
          result;

        try {
          await next();
        } catch (error) {
          // Handler threw - do not settle, rethrow
          ctx.remove(SETTLEMENT_OVERRIDES_HEADER);
          await cancellationDispatcher.cancel({
            reason: "handler_threw",
            error,
          });
          throw error;
        }

        // Check for unrecoverable cases where we cannot control the response
        if (ctx.respond === false) {
          // Handler bypassed Koa's response handling (e.g., direct res.write)
          throw new Error(
            `x402: Route "${ctx.method} ${ctx.path}" set ctx.respond = false, bypassing Koa response handling. Content was served without settlement.`,
          );
        }

        if (ctx.res.headersSent) {
          // Headers already flushed to client - cannot modify response
          throw new Error(
            `x402: Route "${ctx.method} ${ctx.path}" had headers flushed by a downstream middleware writing to ctx.res directly. Content was served without settlement.`,
          );
        }

        // Check status code - only settle on 2xx
        if (ctx.status < 200 || ctx.status >= 300) {
          // Non-2xx response - do not settle
          ctx.remove(SETTLEMENT_OVERRIDES_HEADER);
          await cancellationDispatcher.cancel({
            reason: "handler_failed",
            responseStatus: ctx.status,
          });
          return;
        }

        // Read settlement overrides from response header before removing it
        // (set by handler via setSettlementOverrides)
        const overridesRaw = ctx.response.get(SETTLEMENT_OVERRIDES_HEADER);
        let settlementOverrides: SettlementOverrides | undefined;
        if (overridesRaw) {
          settlementOverrides = JSON.parse(overridesRaw);
        }
        // Remove the header so it's not sent to client
        ctx.remove(SETTLEMENT_OVERRIDES_HEADER);

        // Check for stream body
        if (isReadableStream(ctx.body)) {
          // Stream body - settle before sending
          // We settle first, and if it fails, destroy the stream and replace with 402
          const streamResponseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(ctx.response.headers)) {
            if (value != null) {
              streamResponseHeaders[key] = Array.isArray(value) ? value.join(", ") : String(value);
            }
          }

          try {
            const settleResult = await httpServer.processSettlement(
              paymentPayload,
              paymentRequirements,
              declaredExtensions,
              { request: context, responseHeaders: streamResponseHeaders },
              settlementOverrides,
            );

            if (!settleResult.success) {
              // Settlement failed - destroy stream and return 402
              (ctx.body as Readable).destroy();
              const { response } = settleResult;
              ctx.status = response.status;
              for (const [key, value] of Object.entries(response.headers)) {
                ctx.set(key, value);
              }
              ctx.body = response.isHtml ? response.body : response.body || {};
              return;
            }

            // Settlement succeeded - add headers
            for (const [key, value] of Object.entries(settleResult.headers)) {
              ctx.set(key, value);
            }
          } catch (error) {
            // Settlement threw - destroy stream and return error
            (ctx.body as Readable).destroy();
            if (error instanceof FacilitatorResponseError) {
              sendFacilitatorError(ctx, error);
              return;
            }
            console.error(error);
            ctx.status = 402;
            ctx.body = {};
            return;
          }

          return;
        }

        // Non-stream body - settle without buffering
        // ctx.body is left untouched; Koa handles serialization after middleware completes
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(ctx.response.headers)) {
          if (value != null) {
            responseHeaders[key] = Array.isArray(value) ? value.join(", ") : String(value);
          }
        }

        try {
          const settleResult = await httpServer.processSettlement(
            paymentPayload,
            paymentRequirements,
            declaredExtensions,
            { request: context, responseHeaders },
            settlementOverrides,
          );

          if (!settleResult.success) {
            // Settlement failed - discard body and return 402
            const { response } = settleResult;
            ctx.status = response.status;
            for (const [key, value] of Object.entries(response.headers)) {
              ctx.set(key, value);
            }
            ctx.body = response.isHtml ? response.body : response.body || {};
            return;
          }

          // Settlement succeeded - add headers to response
          for (const [key, value] of Object.entries(settleResult.headers)) {
            ctx.set(key, value);
          }
        } catch (error) {
          if (error instanceof FacilitatorResponseError) {
            sendFacilitatorError(ctx, error);
            return;
          }
          console.error(error);
          ctx.status = 402;
          ctx.body = {};
          return;
        }

        return;
    }
  };
}

/**
 * Koa payment middleware for x402 protocol (direct server instance).
 *
 * Use this when you want to pass a pre-configured x402ResourceServer instance.
 * This provides more flexibility for testing, custom configuration, and reusing
 * server instances across multiple middlewares.
 *
 * @param routes - Route configurations for protected endpoints
 * @param server - Pre-configured x402ResourceServer instance
 * @param paywallConfig - Optional configuration for the built-in paywall UI
 * @param paywall - Optional custom paywall provider (overrides default)
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on startup (defaults to true)
 * @returns Koa middleware handler
 *
 * @example
 * ```typescript
 * import { paymentMiddleware } from "@x402/koa";
 *
 * const server = new x402ResourceServer(myFacilitatorClient)
 *   .register(NETWORK, new ExactEvmScheme());
 *
 * app.use(paymentMiddleware(routes, server, paywallConfig));
 * ```
 */
export function paymentMiddleware(
  routes: RoutesConfig,
  server: x402ResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart: boolean = true,
): Middleware {
  // Create the x402 HTTP server instance with the resource server
  const httpServer = new x402HTTPResourceServer(server, routes);

  return paymentMiddlewareFromHTTPServer(
    httpServer,
    paywallConfig,
    paywall,
    syncFacilitatorOnStart,
  );
}

/**
 * Koa payment middleware for x402 protocol (configuration-based).
 *
 * Use this when you want to quickly set up middleware with simple configuration.
 * This function creates and configures the x402ResourceServer internally.
 *
 * @param routes - Route configurations for protected endpoints
 * @param facilitatorClients - Optional facilitator client(s) for payment processing
 * @param schemes - Optional array of scheme registrations for server-side payment processing
 * @param paywallConfig - Optional configuration for the built-in paywall UI
 * @param paywall - Optional custom paywall provider (overrides default)
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on startup (defaults to true)
 * @returns Koa middleware handler
 *
 * @example
 * ```typescript
 * import { paymentMiddlewareFromConfig } from "@x402/koa";
 *
 * app.use(paymentMiddlewareFromConfig(
 *   routes,
 *   myFacilitatorClient,
 *   [{ network: "eip155:8453", server: evmSchemeServer }],
 *   paywallConfig
 * ));
 * ```
 */
export function paymentMiddlewareFromConfig(
  routes: RoutesConfig,
  facilitatorClients?: FacilitatorClient | FacilitatorClient[],
  schemes?: SchemeRegistration[],
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart: boolean = true,
): Middleware {
  const ResourceServer = new x402ResourceServer(facilitatorClients);

  if (schemes) {
    schemes.forEach(({ network, server: schemeServer }) => {
      ResourceServer.register(network, schemeServer);
    });
  }

  // Use the direct paymentMiddleware with the configured server
  // Note: paymentMiddleware handles dynamic bazaar registration
  return paymentMiddleware(routes, ResourceServer, paywallConfig, paywall, syncFacilitatorOnStart);
}

// Adapter
export { KoaAdapter } from "./adapter";

// Re-exports from @x402/core (matching express's pattern)
export { x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";

export type {
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
  Network,
  SchemeNetworkServer,
} from "@x402/core/types";

export type { PaywallProvider, PaywallConfig, SettlementOverrides } from "@x402/core/server";

export { RouteConfigurationError, SETTLEMENT_OVERRIDES_HEADER } from "@x402/core/server";

export type { RouteValidationError } from "@x402/core/server";
