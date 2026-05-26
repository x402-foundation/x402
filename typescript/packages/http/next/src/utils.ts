import { NextRequest, NextResponse } from "next/server";
import {
  HTTPRequestContext,
  HTTPResponseInstructions,
  PaywallProvider,
  x402HTTPResourceServer,
  x402ResourceServer,
  RoutesConfig,
  FacilitatorResponseError,
  getFacilitatorResponseError as getCoreFacilitatorResponseError,
  PaymentCancellationDispatcher,
} from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { NextAdapter } from "./adapter";

/**
 * Result of createHttpServer
 */
export interface HttpServerInstance {
  httpServer: x402HTTPResourceServer;
  init: () => Promise<void>;
}

export const getFacilitatorResponseError = getCoreFacilitatorResponseError;

/**
 * Builds a normalized 502 response for facilitator boundary failures.
 *
 * @param error - The facilitator response error to surface
 * @returns A JSON 502 response
 */
export function createFacilitatorErrorResponse(error: FacilitatorResponseError): NextResponse {
  return new NextResponse(JSON.stringify({ error: error.message }), {
    status: 502,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Prepares an existing x402HTTPResourceServer with initialization logic
 *
 * @param httpServer - Pre-configured x402HTTPResourceServer instance
 * @param paywall - Optional paywall provider for custom payment UI
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on start (defaults to true)
 * @returns The HTTP server instance with initialization function
 */
export function prepareHttpServer(
  httpServer: x402HTTPResourceServer,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart: boolean = true,
): HttpServerInstance {
  // Register custom paywall provider if provided
  if (paywall) {
    httpServer.registerPaywallProvider(paywall);
  }

  // Store initialization promise (not the result)
  // httpServer.initialize() fetches facilitator support and validates routes
  let initPromise: Promise<void> | null = syncFacilitatorOnStart ? httpServer.initialize() : null;
  let isInitialized = false;

  return {
    httpServer,
    /**
     * Ensures facilitator initialization succeeds once, while allowing retries after failures.
     */
    async init() {
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
    },
  };
}

/**
 * Creates and configures the x402 HTTP server with initialization logic
 *
 * @param routes - The route configuration for the server
 * @param server - The x402 resource server instance
 * @param paywall - Optional paywall provider for custom payment UI
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on start (defaults to true)
 * @returns The HTTP server instance with initialization function
 */
export function createHttpServer(
  routes: RoutesConfig,
  server: x402ResourceServer,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart: boolean = true,
): HttpServerInstance {
  // Create the x402 HTTP server instance with the resource server
  const httpServer = new x402HTTPResourceServer(server, routes);

  return prepareHttpServer(httpServer, paywall, syncFacilitatorOnStart);
}

/**
 * Creates HTTP request context from a Next.js request
 *
 * @param request - The Next.js request object
 * @returns The HTTP request context for x402 processing
 */
export function createRequestContext(request: NextRequest): HTTPRequestContext {
  // Create adapter and context
  const adapter = new NextAdapter(request);
  return {
    adapter,
    path: request.nextUrl.pathname,
    method: request.method,
    paymentHeader: adapter.getHeader("payment-signature") || adapter.getHeader("x-payment"),
  };
}

/**
 * Handles payment error result by creating a 402 response
 *
 * @param response - The HTTP response instructions from payment verification
 * @returns A Next.js response with the appropriate 402 status and headers
 */
export function handlePaymentError(response: HTTPResponseInstructions): NextResponse {
  // Payment required but not provided or invalid
  const headers = new Headers(response.headers);
  if (response.isHtml) {
    headers.set("Content-Type", "text/html");
    return new NextResponse(response.body as string, {
      status: response.status,
      headers,
    });
  }
  headers.set("Content-Type", "application/json");
  return new NextResponse(JSON.stringify(response.body || {}), {
    status: response.status,
    headers,
  });
}

/**
 * Handles settlement after a successful response
 *
 * @param httpServer - The x402 HTTP resource server instance
 * @param response - The Next.js response from the protected route
 * @param paymentPayload - The payment payload from the client
 * @param paymentRequirements - The payment requirements for the route
 * @param declaredExtensions - Optional declared extensions (for per-key enrichment)
 * @param cancellationDispatcher - Cancels verified payments that should not settle
 * @param httpContext - Optional HTTP request context for extensions
 * @returns The response with settlement headers or an error response if settlement fails
 */
export async function handleSettlement(
  httpServer: x402HTTPResourceServer,
  response: NextResponse,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  declaredExtensions: Record<string, unknown> | undefined,
  cancellationDispatcher: PaymentCancellationDispatcher,
  httpContext?: HTTPRequestContext,
): Promise<NextResponse> {
  // If the response from the protected route is >= 400, do not settle payment
  if (response.status >= 400) {
    await cancellationDispatcher.cancel({
      reason: "handler_failed",
      responseStatus: response.status,
    });
    return response;
  }

  try {
    // Get response body for extensions
    const responseBody = Buffer.from(await response.clone().arrayBuffer());

    const result = await httpServer.processSettlement(
      paymentPayload,
      paymentRequirements,
      declaredExtensions,
      httpContext ? { request: httpContext, responseBody } : undefined,
    );

    if (!result.success) {
      // Settlement failed - do not return the protected resource
      const { response } = result;
      const body = response.isHtml ? response.body : JSON.stringify(response.body ?? {});
      return new NextResponse(body, {
        status: response.status,
        headers: response.headers,
      });
    }

    // Settlement succeeded - add headers and return original response.
    Object.entries(result.headers).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    return response;
  } catch (error) {
    if (error instanceof FacilitatorResponseError) {
      return createFacilitatorErrorResponse(error);
    }
    console.error("Settlement failed:", error);
    // If settlement fails, return an error response
    return new NextResponse(JSON.stringify({}), {
      status: 402,
      headers: { "Content-Type": "application/json" },
    });
  }
}
