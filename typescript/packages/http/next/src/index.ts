import {
  PaywallConfig,
  PaywallProvider,
  x402ResourceServer,
  x402HTTPResourceServer,
  RoutesConfig,
  RouteConfig,
  FacilitatorClient,
  FacilitatorResponseError,
  checkIfBazaarNeeded,
  SETTLEMENT_OVERRIDES_HEADER,
  SettlementOverrides,
} from "@x402/core/server";
import { SchemeNetworkServer, Network } from "@x402/core/types";
import { NextRequest, NextResponse } from "next/server";
import {
  prepareHttpServer,
  createRequestContext,
  handlePaymentError,
  handleSettlement,
  createFacilitatorErrorResponse,
  getFacilitatorResponseError,
} from "./utils";

/**
 * Set settlement overrides on the response for partial settlement.
 * `withX402` reads this header before settlement and strips it from the client response.
 *
 * @param res - Next.js `NextResponse` from your route handler
 * @param overrides - Settlement overrides (for example `{ amount: "50%" }` for partial settlement)
 */
export function setSettlementOverrides(res: NextResponse, overrides: SettlementOverrides): void {
  res.headers.set(SETTLEMENT_OVERRIDES_HEADER, JSON.stringify(overrides));
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
 * Next.js payment proxy for x402 protocol (direct HTTP server instance).
 *
 * Use this when you need to configure HTTP-level hooks.
 *
 * @param httpServer - Pre-configured x402HTTPResourceServer instance
 * @param paywallConfig - Optional configuration for the built-in paywall UI
 * @param paywall - Optional custom paywall provider (overrides default)
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on startup (defaults to true)
 * @returns Next.js proxy handler
 *
 * @example
 * ```typescript
 * import { paymentProxyFromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from "@x402/next";
 *
 * const resourceServer = new x402ResourceServer(facilitatorClient)
 *   .register(NETWORK, new ExactEvmScheme());
 *
 * const httpServer = new x402HTTPResourceServer(resourceServer, routes)
 *   .onProtectedRequest(requestHook);
 *
 * export const proxy = paymentProxyFromHTTPServer(httpServer);
 * ```
 */
export function paymentProxyFromHTTPServer(
  httpServer: x402HTTPResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart: boolean = true,
) {
  const { init } = prepareHttpServer(httpServer, paywall, syncFacilitatorOnStart);

  // Dynamically register bazaar extension if routes declare it and not already registered
  // Skip if pre-registered (e.g., in serverless environments where static imports are used)
  let bazaarPromise: Promise<void> | null = null;
  if (checkIfBazaarNeeded(httpServer.routes) && !httpServer.server.hasExtension("bazaar")) {
    bazaarPromise = import(/* webpackIgnore: true */ "@x402/extensions/bazaar")
      .then(({ bazaarResourceServerExtension }) => {
        httpServer.server.registerExtension(bazaarResourceServerExtension);
      })
      .catch(err => {
        console.error("Failed to load bazaar extension:", err);
      });
  }

  return async (req: NextRequest) => {
    const context = createRequestContext(req);

    // Check if route requires payment before initializing facilitator
    if (!httpServer.requiresPayment(context)) {
      return NextResponse.next();
    }

    // Only initialize when processing a protected route
    try {
      await init();
    } catch (error) {
      const facilitatorError = getFacilitatorResponseError(error);
      if (facilitatorError) {
        return createFacilitatorErrorResponse(facilitatorError);
      }
      throw error;
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
        return createFacilitatorErrorResponse(error);
      }
      throw error;
    }

    // Handle the different result types
    switch (result.type) {
      case "no-payment-required":
        // No payment needed, proceed directly to the route handler
        return NextResponse.next();

      case "payment-error":
        return handlePaymentError(result.response);

      case "payment-verified": {
        // Payment is valid, need to wrap response for settlement
        // Proceed to the next proxy or route handler
        const nextResponse = NextResponse.next();
        return handleSettlement(
          httpServer,
          nextResponse,
          result.paymentPayload,
          result.paymentRequirements,
          result.declaredExtensions,
          result.cancellationDispatcher,
          context,
        );
      }
    }
  };
}

/**
 * Next.js payment proxy for x402 protocol (direct server instance).
 *
 * Use this when you want to pass a pre-configured x402ResourceServer instance.
 * This provides more flexibility for testing, custom configuration, and reusing
 * server instances across multiple proxies.
 *
 * @param routes - Route configurations for protected endpoints
 * @param server - Pre-configured x402ResourceServer instance
 * @param paywallConfig - Optional configuration for the built-in paywall UI
 * @param paywall - Optional custom paywall provider (overrides default)
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on startup (defaults to true)
 * @returns Next.js proxy handler
 *
 * @example
 * ```typescript
 * import { paymentProxy } from "@x402/next";
 *
 * const server = new x402ResourceServer(myFacilitatorClient)
 *   .register(NETWORK, new ExactEvmScheme());
 *
 * export const proxy = paymentProxy(routes, server, paywallConfig);
 * ```
 */
export function paymentProxy(
  routes: RoutesConfig,
  server: x402ResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart: boolean = true,
) {
  // Create the x402 HTTP server instance with the resource server
  const httpServer = new x402HTTPResourceServer(server, routes);

  return paymentProxyFromHTTPServer(httpServer, paywallConfig, paywall, syncFacilitatorOnStart);
}

/**
 * Next.js payment proxy for x402 protocol (configuration-based).
 *
 * Use this when you want to quickly set up proxy with simple configuration.
 * This function creates and configures the x402ResourceServer internally.
 *
 * @param routes - Route configurations for protected endpoints
 * @param facilitatorClients - Optional facilitator client(s) for payment processing
 * @param schemes - Optional array of scheme registrations for server-side payment processing
 * @param paywallConfig - Optional configuration for the built-in paywall UI
 * @param paywall - Optional custom paywall provider (overrides default)
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on startup (defaults to true)
 * @returns Next.js proxy handler
 *
 * @example
 * ```typescript
 * import { paymentProxyFromConfig } from "@x402/next";
 *
 * export const proxy = paymentProxyFromConfig(
 *   routes,
 *   myFacilitatorClient,
 *   [{ network: "eip155:8453", server: evmSchemeServer }],
 *   paywallConfig
 * );
 * ```
 */
export function paymentProxyFromConfig(
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

  // Use the direct paymentProxy with the configured server
  // Note: paymentProxy handles dynamic bazaar registration
  return paymentProxy(routes, ResourceServer, paywallConfig, paywall, syncFacilitatorOnStart);
}

/**
 * Wraps a Next.js App Router API route handler with x402 payment protection (HTTP server instance).
 *
 * Use this when you need to configure HTTP-level hooks.
 *
 * @param routeHandler - The API route handler function to wrap
 * @param httpServer - Pre-configured x402HTTPResourceServer instance
 * @param paywallConfig - Optional configuration for the built-in paywall UI
 * @param paywall - Optional custom paywall provider (overrides default)
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on startup (defaults to true)
 * @returns A wrapped Next.js route handler
 *
 * @example
 * ```typescript
 * import { NextRequest, NextResponse } from "next/server";
 * import { withX402FromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from "@x402/next";
 *
 * const resourceServer = new x402ResourceServer(facilitatorClient)
 *   .register(NETWORK, new ExactEvmScheme());
 *
 * const httpServer = new x402HTTPResourceServer(resourceServer, { "*": routeConfig })
 *   .onProtectedRequest(requestHook);
 *
 * const handler = async (request: NextRequest) => {
 *   return NextResponse.json({ data: "protected content" });
 * };
 *
 * export const GET = withX402FromHTTPServer(handler, httpServer);
 * ```
 */
export function withX402FromHTTPServer<T = unknown>(
  routeHandler: (request: NextRequest) => Promise<NextResponse<T>>,
  httpServer: x402HTTPResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart: boolean = true,
): (request: NextRequest) => Promise<NextResponse<T>> {
  const { init } = prepareHttpServer(httpServer, paywall, syncFacilitatorOnStart);

  // Dynamically register bazaar extension if route declares it and not already registered
  // Skip if pre-registered (e.g., in serverless environments where static imports are used)
  let bazaarPromise: Promise<void> | null = null;
  if (checkIfBazaarNeeded(httpServer.routes) && !httpServer.server.hasExtension("bazaar")) {
    bazaarPromise = import(/* webpackIgnore: true */ "@x402/extensions/bazaar")
      .then(({ bazaarResourceServerExtension }) => {
        httpServer.server.registerExtension(bazaarResourceServerExtension);
      })
      .catch(err => {
        console.error("Failed to load bazaar extension:", err);
      });
  }

  return async (request: NextRequest): Promise<NextResponse<T>> => {
    // Only initialize when processing a protected route
    await init();

    // Await bazaar extension loading if needed
    if (bazaarPromise) {
      await bazaarPromise;
      bazaarPromise = null;
    }

    const context = createRequestContext(request);

    // Process payment requirement check
    const result = await httpServer.processHTTPRequest(context, paywallConfig);

    // Handle the different result types
    switch (result.type) {
      case "no-payment-required":
        // No payment needed, proceed directly to the route handler
        return routeHandler(request);

      case "payment-error":
        return handlePaymentError(result.response) as NextResponse<T>;

      case "payment-verified": {
        // Payment is valid, need to wrap response for settlement
        let handlerResponse: NextResponse<T>;
        try {
          handlerResponse = await routeHandler(request);
        } catch (error) {
          await result.cancellationDispatcher.cancel({
            reason: "handler_threw",
            error,
          });
          throw error;
        }
        return handleSettlement(
          httpServer,
          handlerResponse,
          result.paymentPayload,
          result.paymentRequirements,
          result.declaredExtensions,
          result.cancellationDispatcher,
          context,
        ) as Promise<NextResponse<T>>;
      }
    }
  };
}

/**
 * Wraps a Next.js App Router API route handler with x402 payment protection.
 *
 * Unlike `paymentProxy` which works as middleware, `withX402` wraps individual route handlers
 * and guarantees that payment settlement only occurs after the handler returns a successful
 * response (status < 400). This provides more precise control over when payments are settled.
 *
 * @param routeHandler - The API route handler function to wrap
 * @param routeConfig - Payment configuration for this specific route
 * @param server - Pre-configured x402ResourceServer instance
 * @param paywallConfig - Optional configuration for the built-in paywall UI
 * @param paywall - Optional custom paywall provider (overrides default)
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on startup (defaults to true)
 * @returns A wrapped Next.js route handler
 *
 * @example
 * ```typescript
 * import { NextRequest, NextResponse } from "next/server";
 * import { withX402 } from "@x402/next";
 *
 * const server = new x402ResourceServer(myFacilitatorClient)
 *   .register(NETWORK, new ExactEvmScheme());
 *
 * const handler = async (request: NextRequest) => {
 *   return NextResponse.json({ data: "protected content" });
 * };
 *
 * export const GET = withX402(
 *   handler,
 *   {
 *     accepts: {
 *       scheme: "exact",
 *       payTo: "0x123...",
 *       price: "$0.01",
 *       network: "eip155:84532",
 *     },
 *     description: "Access to protected API",
 *   },
 *   server,
 * );
 * ```
 */
export function withX402<T = unknown>(
  routeHandler: (request: NextRequest) => Promise<NextResponse<T>>,
  routeConfig: RouteConfig,
  server: x402ResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart: boolean = true,
): (request: NextRequest) => Promise<NextResponse<T>> {
  const routes = { "*": routeConfig };
  // Create the x402 HTTP server instance with the resource server
  const httpServer = new x402HTTPResourceServer(server, routes);

  return withX402FromHTTPServer(
    routeHandler,
    httpServer,
    paywallConfig,
    paywall,
    syncFacilitatorOnStart,
  );
}

export type {
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
  Network,
  SchemeNetworkServer,
} from "@x402/core/types";

export type {
  PaywallProvider,
  PaywallConfig,
  RouteConfig,
  SettlementOverrides,
} from "@x402/core/server";

export {
  x402ResourceServer,
  x402HTTPResourceServer,
  RouteConfigurationError,
} from "@x402/core/server";

export type { RouteValidationError } from "@x402/core/server";

export { NextAdapter } from "./adapter";
