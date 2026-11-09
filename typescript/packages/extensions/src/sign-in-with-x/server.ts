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
import {
  createSIWxRequestHook,
  createSIWxSettleHook,
  normalizeConfiguredOrigin,
  type CreateSIWxRequestHookOptions,
} from "./hooks";

/**
 * Options for creating the SIWX resource server extension.
 */
export type CreateSIWxResourceServerExtensionOptions = CreateSIWxRequestHookOptions;

/**
 * Rebases a resource URL onto the configured public origin.
 *
 * Preserves the request path and query while replacing scheme and host so
 * SIWX domain/URI binding matches the server's public origin.
 *
 * @param resourceUrl - Request resource URL from PaymentRequired context
 * @param configuredOrigin - Normalized public origin for domain/URI binding
 * @returns Resource URI with configured origin and original path/query
 */
function rebaseResourcePath(resourceUrl: string, configuredOrigin: URL): string {
  const resource = new URL(resourceUrl);
  const rebased = new URL(configuredOrigin.origin);
  rebased.pathname = resource.pathname;
  rebased.search = resource.search;
  return rebased.toString();
}

/**
 * Builds the SIWX challenge fields included in PaymentRequired.extensions.
 *
 * Domain and URI are derived from the configured origin and request path.
 * Nonce and timestamp fields are refreshed for every response.
 *
 * @param declaration - SIWX route declaration from declareSIWxExtension()
 * @param context - PaymentRequired creation context
 * @param configuredOrigin - Normalized public origin for domain/URI binding
 * @returns Complete SIWX extension payload for the client
 */
async function enrichSIWxPaymentRequiredResponse(
  declaration: unknown,
  context: PaymentRequiredContext,
  configuredOrigin: URL,
): Promise<SIWxExtension> {
  const decl = declaration as SIWxDeclaration;
  const opts: DeclareSIWxOptions = decl._options ?? {};

  const resourceUri = rebaseResourcePath(context.resourceInfo.url, configuredOrigin);

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
    domain: configuredOrigin.host,
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
 * @param options - Storage, configured origin, verification, and event callback configuration
 * @returns Resource server extension for registration with x402ResourceServer
 *
 * @example
 * ```typescript
 * const storage = new InMemorySIWxStorage();
 * const resourceServer = new x402ResourceServer(facilitator)
 *   .registerExtension(createSIWxResourceServerExtension({
 *     storage,
 *     origin: "https://api.example.com",
 *   }));
 * ```
 */
export function createSIWxResourceServerExtension(
  options: CreateSIWxResourceServerExtensionOptions,
): ResourceServerExtension {
  const configuredOrigin = normalizeConfiguredOrigin(options.origin);
  const settleHook = createSIWxSettleHook(options);
  const requestHook = createSIWxRequestHook(options);

  return {
    key: SIGN_IN_WITH_X,
    dynamicInfoFields: ["nonce", "issuedAt", "expirationTime"],
    enrichPaymentRequiredResponse: (declaration, context) =>
      enrichSIWxPaymentRequiredResponse(declaration, context, configuredOrigin),
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
