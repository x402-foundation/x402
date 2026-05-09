/**
 * Server-side ResourceServerExtension for SIWX
 *
 * Provides enrichPaymentRequiredResponse hook to:
 * - Derive missing fields from request context (network, resourceUri, domain)
 * - Refresh time-based fields per request (nonce, issuedAt, expirationTime)
 */

import type { ResourceServerExtension, PaymentRequiredContext } from "@x402/core/types";
import type { SIWxExtension, SIWxExtensionInfo, SupportedChain, DeclareSIWxOptions } from "./types";
import { SIGN_IN_WITH_X } from "./types";
import { getSignatureType, type SIWxDeclaration } from "./declare";
import { buildSIWxSchema } from "./schema";

/**
 * SIWX Resource Server Extension.
 *
 * Implements enrichPaymentRequiredResponse hook to:
 * 1. Derive missing fields from context (network from requirements, URL from resourceInfo)
 * 2. Refresh time-based fields (nonce, issuedAt, expirationTime) per request
 *
 * @example
 * ```typescript
 * import { siwxResourceServerExtension } from "@x402/extensions/sign-in-with-x";
 *
 * const resourceServer = new x402ResourceServer(facilitator)
 *   .registerExtension(siwxResourceServerExtension)
 *   .onAfterSettle(createSIWxSettleHook({ storage }));
 * ```
 */
export const siwxResourceServerExtension: ResourceServerExtension = {
  key: SIGN_IN_WITH_X,

  enrichPaymentRequiredResponse: async (
    declaration: unknown,
    context: PaymentRequiredContext,
  ): Promise<SIWxExtension> => {
    const decl = declaration as SIWxDeclaration;
    const opts: DeclareSIWxOptions = decl._options ?? {};

    // Derive resourceUri from context if not provided
    const resourceUri = opts.resourceUri ?? context.resourceInfo.url;

    // Derive domain from resourceUri
    let domain = opts.domain;
    if (!domain && resourceUri) {
      try {
        domain = new URL(resourceUri).hostname;
      } catch {
        // If URL parsing fails, leave domain undefined (will cause validation error)
      }
    }

    // Derive networks from payment requirements if not provided
    let networks: string[];
    if (opts.network) {
      networks = Array.isArray(opts.network) ? opts.network : [opts.network];
    } else {
      // Get unique networks from payment requirements
      networks = [...new Set(context.requirements.map(r => r.network))];
    }

    // Generate fresh time-based fields
    const nonce = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    const issuedAt = new Date().toISOString();

    // Calculate expirationTime based on configured duration
    const expirationSeconds = opts.expirationSeconds;
    const expirationTime =
      expirationSeconds !== undefined
        ? new Date(Date.now() + expirationSeconds * 1000).toISOString()
        : undefined;

    // Build complete info
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

    // Build supportedChains from networks
    const supportedChains: SupportedChain[] = networks.map(network => ({
      chainId: network,
      type: getSignatureType(network),
    }));

    return {
      info,
      supportedChains,
      schema: buildSIWxSchema(),
    };
  },
};
