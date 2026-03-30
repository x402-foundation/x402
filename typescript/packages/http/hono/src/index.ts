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
import { SchemeNetworkServer, Network } from "@x402/core/types";
import { Context, MiddlewareHandler } from "hono";
import { HonoAdapter } from "./adapter";

/**
 * Set settlement overrides on the response for partial settlement.
 * The middleware will extract these before settlement and strip the header from the client response.
 *
 * @param c - Hono context
 * @param overrides - Settlement overrides (e.g., { amount: "500" } for partial settlement)
 */
export function setSettlementOverrides(c: Context, overrides: SettlementOverrides): void {
  c.header(SETTLEMENT_OVERRIDES_HEADER, JSON.stringify(overrides));
}

/**
 * Check if any routes in the configuration declare bazaar extensions
 *
 * @param routes - Route configuration
 * @returns True if any route has extensions.bazaar defined
 */
function checkIfBazaarNeeded(routes: RoutesConfig): boolean {
  // Handle single route config
  if ("accepts" in routes) {
    return !!(routes.extensions && "bazaar" in routes.extensions);
  }

  // Handle multiple routes
  return Object.values(routes).some(routeConfig => {
    return !!(routeConfig.extensions && "bazaar" in routeConfig.extensions);
  });
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
 * Builds a normalized 502 response for facilitator boundary failures.
 *
 * @param c - The current Hono context
 * @param error - The facilitator response error to surface
 * @returns A JSON 502 response
 */
function facilitatorErrorResponse(c: Context, error: FacilitatorResponseError): Response {
  return c.json({ error: error.message }, 502);
}

/**
 * Hono payment middleware for x402 protocol (direct HTTP server instance).
 *
 * Use this when you need to configure HTTP-level hooks.
 *
 * @param httpServer - Pre-configured x402HTTPResourceServer instance
 * @param paywallConfig - Optional configuration for the built-in paywall UI
 * @param paywall - Optional custom paywall provider (overrides default)
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on startup (defaults to true)
 * @returns Hono middleware handler
 *
 * @example
 * ```typescript
 * import { paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from "@x402/hono";
 *
 * const resourceServer = new x402ResourceServer(facilitatorClient)
 *   .register(NETWORK, new ExactEvmScheme());
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
): MiddlewareHandler {
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

  // Dynamically register bazaar extension if routes declare it and not already registered
  // Skip if pre-registered (e.g., in serverless environments where static imports are used)
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

  return async (c: Context, next: () => Promise<void>) => {
    // Create adapter and context
    const adapter = new HonoAdapter(c);
    const context: HTTPRequestContext = {
      adapter,
      path: c.req.path,
      method: c.req.method,
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
          return facilitatorErrorResponse(c, facilitatorError);
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
        return facilitatorErrorResponse(c, error);
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
        Object.entries(response.headers).forEach(([key, value]) => {
          c.header(key, value);
        });
        if (response.isHtml) {
          return c.html(response.body as string, response.status as 402);
        } else {
          return c.json(response.body || {}, response.status as 402);
        }

      case "payment-verified":
        // Payment is valid, need to wrap response for settlement
        const { paymentPayload, paymentRequirements, declaredExtensions } = result;

        // Proceed to the next middleware or route handler
        await next();

        // Get the current response
        let res = c.res;

        // If the response from the protected route is >= 400, do not settle payment
        if (res.status >= 400) {
          return;
        }

        // Get response body for extensions
        const responseBody = Buffer.from(await res.clone().arrayBuffer());

        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        // Clear the response so we can modify headers
        c.res = undefined;

        try {
          const settleResult = await httpServer.processSettlement(
            paymentPayload,
            paymentRequirements,
            declaredExtensions,
            { request: context, responseBody, responseHeaders },
          );

          if (!settleResult.success) {
            // Settlement failed - do not return the protected resource
            const { response } = settleResult;
            const body = response.isHtml
              ? String(response.body ?? "")
              : JSON.stringify(response.body ?? {});
            res = new Response(body, {
              status: response.status,
              headers: response.headers,
            });
          } else {
            // Settlement succeeded - add headers to response
            Object.entries(settleResult.headers).forEach(([key, value]) => {
              res.headers.set(key, value);
            });
          }
        } catch (error) {
          if (error instanceof FacilitatorResponseError) {
            res = facilitatorErrorResponse(c, error);
            c.res = res;
            return;
          }
          console.error(error);
          // If settlement fails, return an error response
          res = c.json({}, 402);
        }

        // Restore the response (potentially modified with settlement headers)
        c.res = res;
        return;
    }
  };
}

/**
 * Hono payment middleware for x402 protocol (direct server instance).
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
 * @returns Hono middleware handler
 *
 * @example
 * ```typescript
 * import { paymentMiddleware } from "@x402/hono";
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
): MiddlewareHandler {
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
 * Hono payment middleware for x402 protocol (configuration-based).
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
 * @returns Hono middleware handler
 *
 * @example
 * ```typescript
 * import { paymentMiddlewareFromConfig } from "@x402/hono";
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
): MiddlewareHandler {
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

export { HonoAdapter } from "./adapter";
