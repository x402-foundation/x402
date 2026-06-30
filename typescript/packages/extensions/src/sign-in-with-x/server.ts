/**
 * Server-side ResourceServerExtension factory for SIWX.
 *
 * The extension enriches PaymentRequired responses with fresh SIWX challenges,
 * records successful settlements, and validates HTTP SIWX proofs for routes
 * that declare the sign-in-with-x extension.
 */

import type { ResourceServerExtension, PaymentRequiredContext } from "@x402/core/types";
import type { SIWxExtension, SIWxExtensionInfo, SupportedChain, DeclareSIWxOptions } from "./types";
import { SIGN_IN_WITH_X } from "./types";
import { getSignatureType, type SIWxDeclaration } from "./declare";
import { buildSIWxSchema } from "./schema";
import { createSIWxRequestHook, createSIWxSettleHook, type CreateSIWxHookOptions } from "./hooks";

/**
 * Options for creating the SIWX resource server extension.
 *
 * Includes storage for paid wallet tracking, optional signature verification
 * settings, and an optional event callback.
 */
export type CreateSIWxResourceServerExtensionOptions = CreateSIWxHookOptions;

/**
 * Builds the SIWX challenge fields included in PaymentRequired.extensions.
 *
 * Missing network, URI, and domain values are derived from request context.
 * Nonce and timestamp fields are refreshed for every response.
 *
 * @param declaration - SIWX route declaration from declareSIWxExtension()
 * @param context - PaymentRequired creation context
 * @returns Complete SIWX extension payload for the client
 */
async function enrichSIWxPaymentRequiredResponse(
  declaration: unknown,
  context: PaymentRequiredContext,
): Promise<SIWxExtension> {
  const decl = declaration as SIWxDeclaration;
  const opts: DeclareSIWxOptions = decl._options ?? {};

  // Use the request URL when the route did not declare a fixed resource URI.
  const resourceUri = opts.resourceUri ?? context.resourceInfo.url;

  let domain = opts.domain;
  if (!domain && resourceUri) {
    try {
      domain = new URL(resourceUri).hostname;
    } catch {
      domain = undefined;
    }
  }

  let supportedNetworks: string[];
  if (opts.network) {
    supportedNetworks = Array.isArray(opts.network) ? opts.network : [opts.network];
  } else {
    // Paid routes derive supported chains from their payment requirements.
    supportedNetworks = [...new Set(context.requirements.map(r => r.network))];
  }

  // SIWX challenges need a fresh nonce and issuedAt on each response.
  const nonce = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  const issuedAt = new Date().toISOString();

  const expirationTime =
    opts.expirationSeconds !== undefined
      ? new Date(Date.now() + opts.expirationSeconds * 1000).toISOString()
      : undefined;

  const info: SIWxExtensionInfo = {
    domain: domain ?? "",
    uri: resourceUri,
    version: opts.version ?? "1",
    nonce,
    issuedAt,
    resources: [resourceUri],
  };

  if (expirationTime) {
    info.expirationTime = expirationTime;
  }
  if (opts.statement) {
    info.statement = opts.statement;
  }

  const supportedChains: SupportedChain[] = supportedNetworks.map(network => ({
    chainId: network,
    type: getSignatureType(network),
  }));

  return {
    info,
    supportedChains,
    schema: buildSIWxSchema(),
  };
}

/**
 * Creates a SIWX server extension that publishes challenges, records payments,
 * and validates HTTP SIWX proofs for declared routes.
 *
 * @param options - Storage, verification, and event callback configuration
 * @returns Resource server extension for registration with x402ResourceServer
 *
 * @example
 * ```typescript
 * const storage = new InMemorySIWxStorage();
 * const resourceServer = new x402ResourceServer(facilitator)
 *   .registerExtension(createSIWxResourceServerExtension({ storage }));
 * ```
 */
export function createSIWxResourceServerExtension(
  options: CreateSIWxResourceServerExtensionOptions,
): ResourceServerExtension {
  const settleHook = createSIWxSettleHook(options);
  const requestHook = createSIWxRequestHook(options);

  return {
    key: SIGN_IN_WITH_X,
    dynamicInfoFields: ["nonce", "issuedAt", "expirationTime"],
    enrichPaymentRequiredResponse: enrichSIWxPaymentRequiredResponse,
    transportHooks: {
      http: {
        onProtectedRequest: async (_declaration, context, routeConfig) =>
          requestHook(context, routeConfig),
      },
    },
    hooks: {
      onAfterSettle: async (_declaration, context) => settleHook(context),
    },
  };
}
