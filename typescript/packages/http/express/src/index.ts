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
import { NextFunction, Request, Response } from "express";
import { ExpressAdapter } from "./adapter";

/**
 * Set settlement overrides on the response for partial settlement.
 * The middleware will extract these before settlement and strip the header from the client response.
 *
 * @param res - Express response object
 * @param overrides - Settlement overrides (e.g., { amount: "500" } for partial settlement)
 */
export function setSettlementOverrides(res: Response, overrides: SettlementOverrides): void {
  res.setHeader(SETTLEMENT_OVERRIDES_HEADER, JSON.stringify(overrides));
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
 * Sends a normalized 502 response for facilitator boundary failures.
 *
 * @param res - The Express response to write to
 * @param error - The facilitator response error to surface
 */
function sendFacilitatorError(res: Response, error: FacilitatorResponseError): void {
  res.status(502).json({ error: error.message });
}

/**
 * Express payment middleware for x402 protocol (direct HTTP server instance).
 *
 * Use this when you need to configure HTTP-level hooks.
 *
 * @param httpServer - Pre-configured x402HTTPResourceServer instance
 * @param paywallConfig - Optional configuration for the built-in paywall UI
 * @param paywall - Optional custom paywall provider (overrides default)
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on startup (defaults to true)
 * @returns Express middleware handler
 *
 * @example
 * ```typescript
 * import { paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from "@x402/express";
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
) {
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

  return async (req: Request, res: Response, next: NextFunction) => {
    // Create adapter and context
    const adapter = new ExpressAdapter(req);
    const context: HTTPRequestContext = {
      adapter,
      path: req.path,
      method: req.method,
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
          sendFacilitatorError(res, facilitatorError);
          return;
        }
        return next(error);
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
        sendFacilitatorError(res, error);
        return;
      }
      return next(error);
    }

    // Handle the different result types
    switch (result.type) {
      case "no-payment-required":
        // No payment needed, proceed directly to the route handler
        return next();

      case "payment-error":
        // Payment required but not provided or invalid
        const { response } = result;
        res.status(response.status);
        Object.entries(response.headers).forEach(([key, value]) => {
          res.setHeader(key, value);
        });
        if (response.isHtml) {
          res.send(response.body);
        } else {
          res.json(response.body || {});
        }
        return;

      case "payment-verified":
        // Payment is valid, need to wrap response for settlement
        const { paymentPayload, paymentRequirements, declaredExtensions } = result;

        // Intercept and buffer all core methods that can commit response to client
        const originalWriteHead = res.writeHead.bind(res);
        const originalWrite = res.write.bind(res);
        const originalEnd = res.end.bind(res);
        const originalFlushHeaders = res.flushHeaders.bind(res);

        type BufferedCall =
          | ["writeHead", Parameters<typeof originalWriteHead>]
          | ["write", Parameters<typeof originalWrite>]
          | ["end", Parameters<typeof originalEnd>]
          | ["flushHeaders", []];
        let bufferedCalls: BufferedCall[] = [];
        let settled = false;

        // Create a promise that resolves when the handler finishes and calls res.end()
        let endCalled: () => void;
        const endPromise = new Promise<void>(resolve => {
          endCalled = resolve;
        });

        res.writeHead = function (...args: Parameters<typeof originalWriteHead>) {
          if (!settled) {
            bufferedCalls.push(["writeHead", args]);
            return res;
          }
          return originalWriteHead(...args);
        } as typeof originalWriteHead;

        res.write = function (...args: Parameters<typeof originalWrite>) {
          if (!settled) {
            bufferedCalls.push(["write", args]);
            return true;
          }
          return originalWrite(...args);
        } as typeof originalWrite;

        res.end = function (...args: Parameters<typeof originalEnd>) {
          if (!settled) {
            bufferedCalls.push(["end", args]);
            // Signal that the handler has finished
            endCalled();
            return res;
          }
          return originalEnd(...args);
        } as typeof originalEnd;

        res.flushHeaders = function () {
          if (!settled) {
            bufferedCalls.push(["flushHeaders", []]);
            return;
          }
          return originalFlushHeaders();
        };

        // Proceed to the next middleware or route handler
        next();

        // Wait for the handler to actually call res.end() before checking status
        await endPromise;

        // If the response from the protected route is >= 400, do not settle payment
        if (res.statusCode >= 400) {
          settled = true;
          res.writeHead = originalWriteHead;
          res.write = originalWrite;
          res.end = originalEnd;
          res.flushHeaders = originalFlushHeaders;
          // Replay all buffered calls in order
          for (const [method, args] of bufferedCalls) {
            if (method === "writeHead")
              originalWriteHead(...(args as Parameters<typeof originalWriteHead>));
            else if (method === "write")
              originalWrite(...(args as Parameters<typeof originalWrite>));
            else if (method === "end") originalEnd(...(args as Parameters<typeof originalEnd>));
            else if (method === "flushHeaders") originalFlushHeaders();
          }
          bufferedCalls = [];
          return;
        }

        try {
          // Build response body buffer from buffered write/end calls
          const responseBody = Buffer.concat(
            bufferedCalls.flatMap(([m, args]) =>
              (m === "write" || m === "end") && args[0] ? [Buffer.from(args[0])] : [],
            ),
          );

          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.getHeaders())) {
            if (value != null) {
              responseHeaders[key] = String(value);
            }
          }

          const settleResult = await httpServer.processSettlement(
            paymentPayload,
            paymentRequirements,
            declaredExtensions,
            { request: context, responseBody, responseHeaders },
          );

          // If settlement fails, return an error and do not send the buffered response
          if (!settleResult.success) {
            bufferedCalls = [];
            const { response } = settleResult;
            Object.entries(response.headers).forEach(([key, value]) => {
              res.setHeader(key, value);
            });
            if (response.isHtml) {
              res.status(response.status).send(response.body);
            } else {
              res.status(response.status).json(response.body ?? {});
            }
            return;
          }

          // Settlement succeeded - add headers to response
          Object.entries(settleResult.headers).forEach(([key, value]) => {
            res.setHeader(key, value);
          });
        } catch (error) {
          if (error instanceof FacilitatorResponseError) {
            bufferedCalls = [];
            sendFacilitatorError(res, error);
            return;
          }
          console.error(error);
          // If settlement fails, don't send the buffered response
          bufferedCalls = [];
          res.status(402).json({});
          return;
        } finally {
          settled = true;
          res.writeHead = originalWriteHead;
          res.write = originalWrite;
          res.end = originalEnd;
          res.flushHeaders = originalFlushHeaders;

          // Replay all buffered calls in order
          for (const [method, args] of bufferedCalls) {
            if (method === "writeHead")
              originalWriteHead(...(args as Parameters<typeof originalWriteHead>));
            else if (method === "write")
              originalWrite(...(args as Parameters<typeof originalWrite>));
            else if (method === "end") originalEnd(...(args as Parameters<typeof originalEnd>));
            else if (method === "flushHeaders") originalFlushHeaders();
          }
          bufferedCalls = [];
        }
        return;
    }
  };
}

/**
 * Express payment middleware for x402 protocol (direct server instance).
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
 * @returns Express middleware handler
 *
 * @example
 * ```typescript
 * import { paymentMiddleware } from "@x402/express";
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
) {
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
 * Express payment middleware for x402 protocol (configuration-based).
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
 * @returns Express middleware handler
 *
 * @example
 * ```typescript
 * import { paymentMiddlewareFromConfig } from "@x402/express";
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
) {
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

export { ExpressAdapter } from "./adapter";
