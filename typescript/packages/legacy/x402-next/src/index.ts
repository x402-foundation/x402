import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { Address } from "viem";
import type { Address as SolanaAddress } from "@solana/kit";
import { computeRoutePatterns, findMatchingRoute } from "x402/shared";
import { FacilitatorConfig, Resource, RoutesConfig, RouteConfig, PaywallConfig } from "x402/types";
import { useFacilitator } from "x402/verify";

import { POST } from "./api/session-token";
import {
  buildPaymentRequirements,
  handleMissingPaymentHeader,
  verifyPayment,
  settlePayment,
} from "./utils";

/**
 * Creates a payment middleware factory for Next.js
 *
 * @param payTo - The address to receive payments
 * @param routes - Configuration for protected routes and their payment requirements
 * @param facilitator - Optional configuration for the payment facilitator service
 * @param paywall - Optional configuration for the default paywall
 * @returns A Next.js middleware handler
 *
 * @example
 * ```typescript
 * // Simple configuration - All endpoints are protected by $0.01 of USDC on base-sepolia
 * export const middleware = paymentMiddleware(
 *   '0x123...', // payTo address
 *   {
 *     price: '$0.01', // USDC amount in dollars
 *     network: 'base-sepolia'
 *   },
 *   // Optional facilitator configuration. Defaults to x402.org/facilitator for testnet usage
 * );
 *
 * // Advanced configuration - Endpoint-specific payment requirements & custom facilitator
 * export const middleware = paymentMiddleware(
 *   '0x123...', // payTo: The address to receive payments
 *   {
 *     '/protected/*': {
 *       price: '$0.001', // USDC amount in dollars
 *       network: 'base',
 *       config: {
 *         description: 'Access to protected content'
 *       }
 *     },
 *     '/api/premium/*': {
 *       price: {
 *         amount: '100000',
 *         asset: {
 *           address: '0xabc',
 *           decimals: 18,
 *           eip712: {
 *             name: 'WETH',
 *             version: '1'
 *           }
 *         }
 *       },
 *       network: 'base'
 *     }
 *   },
 *   {
 *     url: 'https://facilitator.example.com',
 *     createAuthHeaders: async () => ({
 *       verify: { "Authorization": "Bearer token" },
 *       settle: { "Authorization": "Bearer token" }
 *     })
 *   },
 *   {
 *     cdpClientKey: 'your-cdp-client-key',
 *     appLogo: '/images/logo.svg',
 *     appName: 'My App',
 *   }
 * );
 * ```
 */
export function paymentMiddleware(
  payTo: Address | SolanaAddress,
  routes: RoutesConfig,
  facilitator?: FacilitatorConfig,
  paywall?: PaywallConfig,
) {
  const { verify, settle, supported } = useFacilitator(facilitator);
  const x402Version = 1;

  // Pre-compile route patterns to regex and extract verbs
  const routePatterns = computeRoutePatterns(routes);

  return async function middleware(request: NextRequest) {
    const pathname = request.nextUrl.pathname;
    const method = request.method.toUpperCase();

    // Find matching route configuration
    const matchingRoute = findMatchingRoute(routePatterns, pathname, method);

    if (!matchingRoute) {
      return NextResponse.next();
    }

    const { price, network, config = {} } = matchingRoute.config;
    const { customPaywallHtml, resource, errorMessages } = config;

    const resourceUrl =
      resource || (`${request.nextUrl.protocol}//${request.nextUrl.host}${pathname}` as Resource);

    // Build payment requirements
    const paymentRequirements = await buildPaymentRequirements(
      payTo,
      price,
      network,
      config,
      resourceUrl,
      method,
      supported,
    );

    // Check for payment header
    const paymentHeader = request.headers.get("X-PAYMENT");
    if (!paymentHeader) {
      return handleMissingPaymentHeader(
        request,
        price,
        network,
        paymentRequirements,
        x402Version,
        errorMessages,
        customPaywallHtml,
        paywall,
      );
    }

    // Verify payment
    const verificationResult = await verifyPayment(
      paymentHeader,
      paymentRequirements,
      x402Version,
      verify,
      errorMessages,
    );

    if ("error" in verificationResult) {
      return verificationResult.error;
    }

    const { decodedPayment, selectedRequirements } = verificationResult;

    // Proceed with request
    const response = await NextResponse.next();

    // if the response from the protected route is >= 400, do not settle the payment
    // NOTE: This check is ineffective in Next.js middleware as NextResponse.next() does not provide access to the actual route handler's response
    // For API routes, use withX402 instead to guarantee payment settlement only after successful responses (status < 400)
    if (response.status >= 400) {
      return response;
    }

    // Settle payment after response
    return await settlePayment(
      response,
      decodedPayment,
      selectedRequirements,
      settle,
      x402Version,
      errorMessages,
      paymentRequirements,
    );
  };
}

/**
 * Creates a payment wrapper for Next.js App Router API routes
 *
 * This is the recommended approach for protecting API routes. Unlike paymentMiddleware,
 * this wrapper guarantees payment settlement only after successful API responses (status < 400).
 *
 * @param handler - The API route handler function
 * @param payTo - The address to receive payments
 * @param routeConfig - Payment configuration for this specific route
 * @param facilitator - Optional configuration for the payment facilitator service
 * @param paywall - Optional configuration for the default paywall
 * @returns A wrapped Next.js route handler
 *
 * @example
 * ```typescript
 * // Simple configuration - Protected route with $0.01 USDC on base-sepolia
 * import { NextRequest, NextResponse } from "next/server";
 * import { withX402 } from "x402-next";
 *
 * const handler = async (request: NextRequest) => {
 *   return NextResponse.json({ message: "Success" });
 * };
 *
 * export const GET = withX402(
 *   handler,
 *   '0x123...', // payTo address
 *   {
 *     price: '$0.01', // USDC amount in dollars
 *     network: 'base-sepolia'
 *   },
 *   // Optional facilitator configuration. Defaults to x402.org/facilitator for testnet usage
 * );
 *
 * // Advanced configuration - Custom payment settings & facilitator
 * export const POST = withX402(
 *   handler,
 *   '0x123...', // payTo: The address to receive payments
 *   {
 *     price: {
 *       amount: '100000',
 *       asset: {
 *         address: '0xabc',
 *         decimals: 18,
 *         eip712: {
 *           name: 'WETH',
 *           version: '1'
 *         }
 *       }
 *     },
 *     network: 'base',
 *     config: {
 *       description: 'Access to premium content'
 *     }
 *   },
 *   {
 *     url: 'https://facilitator.example.com',
 *     createAuthHeaders: async () => ({
 *       verify: { "Authorization": "Bearer token" },
 *       settle: { "Authorization": "Bearer token" }
 *     })
 *   },
 *   {
 *     cdpClientKey: 'your-cdp-client-key',
 *     appLogo: '/images/logo.svg',
 *     appName: 'My App',
 *   }
 * );
 * ```
 */
export function withX402<T = unknown>(
  handler: (request: NextRequest) => Promise<NextResponse<T>>,
  payTo: Address | SolanaAddress,
  routeConfig: RouteConfig | ((req: NextRequest) => Promise<RouteConfig>),
  facilitator?: FacilitatorConfig,
  paywall?: PaywallConfig,
): (request: NextRequest) => Promise<NextResponse<T | unknown>> {
  const { verify, settle, supported } = useFacilitator(facilitator);
  const x402Version = 1;

  return async function wrappedHandler(request: NextRequest) {
    const method = request.method.toUpperCase();
    const pathname = request.nextUrl.pathname;

    const resolvedConfig =
      typeof routeConfig === "function" ? await routeConfig(request) : routeConfig;

    const { price, network, config = {} } = resolvedConfig;
    const { customPaywallHtml, resource, errorMessages } = config;

    const resourceUrl =
      resource || (`${request.nextUrl.protocol}//${request.nextUrl.host}${pathname}` as Resource);

    // Build payment requirements
    const paymentRequirements = await buildPaymentRequirements(
      payTo,
      price,
      network,
      config,
      resourceUrl,
      method,
      supported,
    );

    // Check for payment header
    const paymentHeader = request.headers.get("X-PAYMENT");
    if (!paymentHeader) {
      return handleMissingPaymentHeader(
        request,
        price,
        network,
        paymentRequirements,
        x402Version,
        errorMessages,
        customPaywallHtml,
        paywall,
      ) as NextResponse<T>;
    }

    // Verify payment
    const verificationResult = await verifyPayment(
      paymentHeader,
      paymentRequirements,
      x402Version,
      verify,
      errorMessages,
    );

    if ("error" in verificationResult) {
      return verificationResult.error as NextResponse<T>;
    }

    const { decodedPayment, selectedRequirements } = verificationResult;

    // Execute the actual route handler
    const response = await handler(request);

    // if the response from the route is >= 400, do not settle the payment
    if (response.status >= 400) {
      return response;
    }

    // Settle payment after successful response
    return (await settlePayment(
      response,
      decodedPayment,
      selectedRequirements,
      settle,
      x402Version,
      errorMessages,
      paymentRequirements,
    )) as NextResponse<T>;
  };
}

export type {
  Money,
  Network,
  PaymentMiddlewareConfig,
  Resource,
  RouteConfig,
  RoutesConfig,
} from "x402/types";
export type { Address as SolanaAddress } from "@solana/kit";

// Export session token API handlers for Onramp
export { POST };
