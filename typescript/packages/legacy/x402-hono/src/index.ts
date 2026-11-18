import type { Context } from "hono";
import { Address, getAddress } from "viem";
import { Address as SolanaAddress } from "@solana/kit";
import { exact } from "x402/schemes";
import {
  computeRoutePatterns,
  findMatchingPaymentRequirements,
  findMatchingRoute,
  processPriceToAtomicAmount,
  toJsonSafe,
} from "x402/shared";
import { getPaywallHtml } from "x402/paywall";
import {
  ERC20TokenAmount,
  FacilitatorConfig,
  moneySchema,
  PaymentPayload,
  PaymentRequirements,
  Resource,
  RoutesConfig,
  settleResponseHeader,
  PaywallConfig,
  SupportedEVMNetworks,
  SupportedSVMNetworks,
} from "x402/types";
import { useFacilitator } from "x402/verify";

/**
 * Creates a payment middleware factory for Hono
 *
 * @param payTo - The address to receive payments
 * @param routes - Configuration for protected routes and their payment requirements
 * @param facilitator - Optional configuration for the payment facilitator service
 * @param paywall - Optional configuration for the default paywall
 * @returns A Hono middleware handler
 *
 * @example
 * ```typescript
 * // Simple configuration - All endpoints are protected by $0.01 of USDC on base-sepolia
 * app.use(paymentMiddleware(
 *   '0x123...', // payTo address
 *   {
 *     price: '$0.01', // USDC amount in dollars
 *     network: 'base-sepolia'
 *   },
 *   // Optional facilitator configuration. Defaults to x402.org/facilitator for testnet usage
 * ));
 *
 * // Advanced configuration - Endpoint-specific payment requirements & custom facilitator
 * app.use(paymentMiddleware('0x123...', // payTo: The address to receive payments
 *   {
 *     '/weather/*': {
 *       price: '$0.001', // USDC amount in dollars
 *       network: 'base',
 *       config: {
 *         description: 'Access to weather data'
 *       }
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
 * ));
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

  return async function paymentMiddleware(c: Context, next: () => Promise<void>) {
    const method = c.req.method.toUpperCase();
    const matchingRoute = findMatchingRoute(routePatterns, c.req.path, method);
    if (!matchingRoute) {
      return next();
    }

    const { price, network, config = {} } = matchingRoute.config;
    const {
      description,
      mimeType,
      maxTimeoutSeconds,
      inputSchema,
      outputSchema,
      customPaywallHtml,
      resource,
      errorMessages,
      discoverable,
    } = config;

    const atomicAmountForAsset = processPriceToAtomicAmount(price, network);
    if ("error" in atomicAmountForAsset) {
      throw new Error(atomicAmountForAsset.error);
    }
    const { maxAmountRequired, asset } = atomicAmountForAsset;

    let resourceUrl = resource;
    if (!resourceUrl) {
      const forwardedProto = c.req.header("X-Forwarded-Proto");
      const forwardedHost = c.req.header("X-Forwarded-Host");

      if (forwardedProto && forwardedHost) {
        // Handle reverse proxy scenarios by reconstructing URL using forwarded headers from reverse proxy
        const url = new URL(c.req.url);
        resourceUrl =
          `${forwardedProto}://${forwardedHost}${url.pathname}${url.search}` as Resource;
      } else {
        // Fall back to default behavior when not behind a reverse proxy
        resourceUrl = c.req.url as Resource;
      }
    }

    let paymentRequirements: PaymentRequirements[] = [];

    // TODO: create a shared middleware function to build payment requirements
    // evm networks
    if (SupportedEVMNetworks.includes(network)) {
      paymentRequirements.push({
        scheme: "exact",
        network,
        maxAmountRequired,
        resource: resourceUrl,
        description: description ?? "",
        mimeType: mimeType ?? "application/json",
        payTo: getAddress(payTo),
        maxTimeoutSeconds: maxTimeoutSeconds ?? 300,
        asset: getAddress(asset.address),
        // TODO: Rename outputSchema to requestStructure
        outputSchema: {
          input: {
            type: "http",
            method,
            discoverable: discoverable ?? true,
            ...inputSchema,
          },
          output: outputSchema,
        },
        extra: (asset as ERC20TokenAmount["asset"]).eip712,
      });
    }
    // svm networks
    else if (SupportedSVMNetworks.includes(network)) {
      // network call to get the supported payments from the facilitator
      const paymentKinds = await supported();

      // find the payment kind that matches the network and scheme
      let feePayer: string | undefined;
      for (const kind of paymentKinds.kinds) {
        if (kind.network === network && kind.scheme === "exact") {
          feePayer = kind?.extra?.feePayer;
          break;
        }
      }

      // svm networks require a fee payer
      if (!feePayer) {
        throw new Error(`The facilitator did not provide a fee payer for network: ${network}.`);
      }

      // build the payment requirements for svm
      paymentRequirements.push({
        scheme: "exact",
        network,
        maxAmountRequired,
        resource: resourceUrl,
        description: description ?? "",
        mimeType: mimeType ?? "",
        payTo: payTo,
        maxTimeoutSeconds: maxTimeoutSeconds ?? 60,
        asset: asset.address,
        // TODO: Rename outputSchema to requestStructure
        outputSchema: {
          input: {
            type: "http",
            method,
            discoverable: discoverable ?? true,
            ...inputSchema,
          },
          output: outputSchema,
        },
        extra: {
          feePayer,
        },
      });
    } else {
      throw new Error(`Unsupported network: ${network}`);
    }

    const payment = c.req.header("X-PAYMENT");
    const userAgent = c.req.header("User-Agent") || "";
    const acceptHeader = c.req.header("Accept") || "";
    const isWebBrowser = acceptHeader.includes("text/html") && userAgent.includes("Mozilla");

    if (!payment) {
      // TODO: handle paywall html for solana
      if (isWebBrowser) {
        let displayAmount: number;
        if (typeof price === "string" || typeof price === "number") {
          const parsed = moneySchema.safeParse(price);
          if (parsed.success) {
            displayAmount = parsed.data;
          } else {
            displayAmount = Number.NaN;
          }
        } else {
          displayAmount = Number(price.amount) / 10 ** price.asset.decimals;
        }

        const currentUrl = new URL(c.req.url).pathname + new URL(c.req.url).search;
        const html =
          customPaywallHtml ??
          getPaywallHtml({
            amount: displayAmount,
            paymentRequirements: toJsonSafe(paymentRequirements) as Parameters<
              typeof getPaywallHtml
            >[0]["paymentRequirements"],
            currentUrl,
            testnet: network === "base-sepolia",
            cdpClientKey: paywall?.cdpClientKey,
            appName: paywall?.appName,
            appLogo: paywall?.appLogo,
            sessionTokenEndpoint: paywall?.sessionTokenEndpoint,
          });
        return c.html(html, 402);
      }
      return c.json(
        {
          error: errorMessages?.paymentRequired || "X-PAYMENT header is required",
          accepts: paymentRequirements,
          x402Version,
        },
        402,
      );
    }

    // Verify payment
    let decodedPayment: PaymentPayload;
    try {
      decodedPayment = exact.evm.decodePayment(payment);
      decodedPayment.x402Version = x402Version;
    } catch (error) {
      return c.json(
        {
          error:
            errorMessages?.invalidPayment ||
            (error instanceof Error ? error.message : "Invalid or malformed payment header"),
          accepts: paymentRequirements,
          x402Version,
        },
        402,
      );
    }

    const selectedPaymentRequirements = findMatchingPaymentRequirements(
      paymentRequirements,
      decodedPayment,
    );
    if (!selectedPaymentRequirements) {
      return c.json(
        {
          error:
            errorMessages?.noMatchingRequirements || "Unable to find matching payment requirements",
          accepts: toJsonSafe(paymentRequirements),
          x402Version,
        },
        402,
      );
    }

    try {
      const verification = await verify(decodedPayment, selectedPaymentRequirements);

      if (!verification.isValid) {
        return c.json(
          {
            error: errorMessages?.verificationFailed || verification.invalidReason,
            accepts: paymentRequirements,
            payer: verification.payer,
            x402Version,
          },
          402,
        );
      }
    } catch (error) {
      console.error("Payment verification failed:", error);
      return c.json(
        {
          error:
            errorMessages?.verificationFailed ||
            (error instanceof Error ? error.message : "Payment verification failed"),
          accepts: paymentRequirements,
          x402Version,
        },
        402,
      );
    }

    // Proceed with request
    await next();

    let res = c.res;

    // If the response from the protected route is >= 400, do not settle payment
    if (res.status >= 400) {
      return;
    }

    c.res = undefined;

    // Settle payment before processing the request, as Hono middleware does not allow us to set headers after the response has been sent
    try {
      const settlement = await settle(decodedPayment, selectedPaymentRequirements);
      if (settlement.success) {
        const responseHeader = settleResponseHeader(settlement);
        res.headers.set("X-PAYMENT-RESPONSE", responseHeader);
      } else {
        throw new Error(settlement.errorReason);
      }
    } catch (error) {
      res = c.json(
        {
          error:
            errorMessages?.settlementFailed ||
            (error instanceof Error ? error.message : "Failed to settle payment"),
          accepts: paymentRequirements,
          x402Version,
        },
        402,
      );
    }

    c.res = res;
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
