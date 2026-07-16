/**
 * SIWX Lifecycle Hooks
 *
 * Pre-built hooks for integrating SIWX authentication with x402 servers and clients.
 */

import type { SIWxStorage } from "./storage";
import type { SIWxExtension, SIWxVerifyOptions, SignatureType } from "./types";
import type { SIWxSigner } from "./sign";
import type { ClientExtension } from "@x402/core/client";
import type { PaymentRequiredContext } from "@x402/core/http";
import type { ProtectedRequestHook } from "@x402/core/http";
import { SIGN_IN_WITH_X } from "./types";
import { parseSIWxHeader } from "./parse";
import { validateSIWxMessage } from "./validate";
import { verifySIWxSignature } from "./verify";
import { createSIWxPayload } from "./client";
import { encodeSIWxHeader } from "./encode";
import { isSolanaSigner } from "./solana";

/**
 * Normalizes and validates a configured SIWX origin.
 *
 * @param origin - Absolute http(s) origin without credentials, path, query, or fragment
 * @returns Parsed origin URL
 * @throws Error when the origin string is invalid
 */
export function normalizeConfiguredOrigin(origin: string): URL {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`Invalid SIWX origin: "${origin}" is not a valid URL`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid SIWX origin: "${origin}" must use http: or https:`);
  }

  if (url.username || url.password) {
    throw new Error(`Invalid SIWX origin: "${origin}" must not include credentials`);
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Invalid SIWX origin: "${origin}" must not include a path, query, or fragment`);
  }

  return url;
}

/**
 * Options for creating the SIWX settle hook.
 */
export interface CreateSIWxSettleHookOptions {
  /** Storage for tracking paid addresses */
  storage: SIWxStorage;
  /** Optional callback for logging/debugging */
  onEvent?: (event: SIWxHookEvent) => void;
}

/**
 * Options for creating the SIWX request hook and resource server extension.
 */
export interface CreateSIWxRequestHookOptions extends CreateSIWxSettleHookOptions {
  /**
   * Public browser-visible origin for SIWX domain and URI binding.
   *
   * Set this to the external origin (for example `https://api.example.com`),
   * not the upstream listener address behind a reverse proxy.
   */
  origin: string;
  /** Options for signature verification (e.g., EVM smart wallet support) */
  verifyOptions?: SIWxVerifyOptions;
}

export type CreateSIWxHookOptions = CreateSIWxRequestHookOptions;

/**
 * Options for creating the SIWX client extension.
 */
export interface CreateSIWxClientExtensionOptions {
  /** Wallet signers to try against the server's supported SIWX chains */
  signers: SIWxSigner[];
}

/**
 * Events emitted by SIWX hooks for logging/debugging.
 */
export type SIWxHookEvent =
  | { type: "payment_recorded"; resource: string; address: string }
  | { type: "access_granted"; resource: string; address: string }
  | { type: "validation_failed"; resource: string; error?: string }
  | { type: "nonce_reused"; resource: string; nonce: string }
  | { type: "siwx_header_sent"; resource: string };

/**
 * Creates an onAfterSettle hook that records payments for SIWX.
 *
 * @param options - Hook configuration
 * @returns Hook function for x402ResourceServer.onAfterSettle()
 *
 * @example
 * ```typescript
 * const storage = new InMemorySIWxStorage();
 * const resourceServer = new x402ResourceServer(facilitator)
 *   .onAfterSettle(createSIWxSettleHook({ storage }));
 * ```
 */
export function createSIWxSettleHook(options: CreateSIWxSettleHookOptions) {
  const { storage, onEvent } = options;

  return async (ctx: {
    paymentPayload: { payload: unknown; resource?: { url: string } };
    result: { success: boolean; payer?: string };
  }): Promise<void> => {
    // Only record payment if settlement succeeded
    if (!ctx.result.success) return;

    // Get payer from facilitator's settle result (works for all payment schemes)
    const address = ctx.result.payer;
    if (!address) return;

    // resource is optional per the v2 spec (section 5.2.2)
    const resourceUrl = ctx.paymentPayload.resource?.url;
    if (!resourceUrl) return;

    const resource = new URL(resourceUrl).pathname;
    await storage.recordPayment(resource, address);
    onEvent?.({ type: "payment_recorded", resource, address });
  };
}

/**
 * Creates an onProtectedRequest hook that validates SIWX auth.
 *
 * For paid routes: grants access when the SIWX signature is valid and the address has paid.
 * For auth-only routes (accepts: []): grants access on valid SIWX signature alone.
 * Auth-only detection uses the routeConfig passed by x402HTTPResourceServer.
 *
 * @param options - Hook configuration including required configured origin
 * @returns Hook function for x402HTTPResourceServer.onProtectedRequest()
 *
 * @example
 * ```typescript
 * const storage = new InMemorySIWxStorage();
 * const httpServer = new x402HTTPResourceServer(resourceServer, routes)
 *   .onProtectedRequest(createSIWxRequestHook({
 *     storage,
 *     origin: "https://api.example.com",
 *   }));
 * ```
 */
export function createSIWxRequestHook(options: CreateSIWxRequestHookOptions): ProtectedRequestHook {
  const { storage, verifyOptions, onEvent } = options;
  const configuredOrigin = normalizeConfiguredOrigin(options.origin);

  // Validate nonce tracking is fully implemented or not at all
  const hasUsedNonce = typeof storage.hasUsedNonce === "function";
  const hasRecordNonce = typeof storage.recordNonce === "function";
  if (hasUsedNonce !== hasRecordNonce) {
    throw new Error(
      "SIWxStorage nonce tracking requires both hasUsedNonce and recordNonce to be implemented",
    );
  }

  return async (context, routeConfig) => {
    // Try both cases for header (HTTP headers are case-insensitive)
    const header =
      context.adapter.getHeader(SIGN_IN_WITH_X) ||
      context.adapter.getHeader(SIGN_IN_WITH_X.toLowerCase());
    if (!header) return;

    try {
      const payload = parseSIWxHeader(header);
      const validation = await validateSIWxMessage(payload, configuredOrigin);
      if (!validation.valid) {
        onEvent?.({ type: "validation_failed", resource: context.path, error: validation.error });
        return;
      }

      const verification = await verifySIWxSignature(payload, verifyOptions);
      if (!verification.valid || !verification.address) {
        onEvent?.({ type: "validation_failed", resource: context.path, error: verification.error });
        return;
      }

      // Check if nonce was already used (prevents signature replay attacks)
      if (storage.hasUsedNonce) {
        const nonceUsed = await storage.hasUsedNonce(payload.nonce);
        if (nonceUsed) {
          onEvent?.({ type: "nonce_reused", resource: context.path, nonce: payload.nonce });
          return;
        }
      }

      // Auth-only routes (accepts: []) grant access on valid SIWX alone
      const isAuthOnly = Array.isArray(routeConfig.accepts) && routeConfig.accepts.length === 0;

      const shouldGrant = isAuthOnly || (await storage.hasPaid(context.path, verification.address));
      if (shouldGrant) {
        // Record nonce as used before granting access
        if (storage.recordNonce) {
          await storage.recordNonce(payload.nonce);
        }

        onEvent?.({
          type: "access_granted",
          resource: context.path,
          address: verification.address,
        });
        return { grantAccess: true };
      }
    } catch (err) {
      onEvent?.({
        type: "validation_failed",
        resource: context.path,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };
}

/**
 * Creates an onPaymentRequired hook for client-side SIWX authentication.
 *
 * Matches the signer type to a compatible chain in supportedChains.
 * For EVM signers: matches any eip191 chain
 * For Solana signers: matches any ed25519 chain
 *
 * @param signer - Wallet signer for creating SIWX proofs
 * @returns Hook function for x402HTTPClient.onPaymentRequired()
 *
 * @example
 * ```typescript
 * const httpClient = new x402HTTPClient(client)
 *   .onPaymentRequired(createSIWxClientHook(signer));
 * ```
 */
export function createSIWxClientHook(signer: SIWxSigner) {
  // Determine signer type once at hook creation
  const signerIsSolana = isSolanaSigner(signer);
  const expectedSignatureType: SignatureType = signerIsSolana ? "ed25519" : "eip191";

  return async (context: {
    paymentRequired: { accepts?: Array<{ network: string }>; extensions?: Record<string, unknown> };
  }): Promise<{ headers: Record<string, string> } | void> => {
    const extensions = context.paymentRequired.extensions ?? {};
    const siwxExtension = extensions[SIGN_IN_WITH_X] as SIWxExtension | undefined;

    if (!siwxExtension?.supportedChains) return;

    try {
      // Find a chain that matches the signer's signature type
      const matchingChain = siwxExtension.supportedChains.find(
        chain => chain.type === expectedSignatureType,
      );

      if (!matchingChain) {
        // No chain compatible with this signer type
        return;
      }

      // Build complete info with selected chain
      const completeInfo = {
        ...siwxExtension.info,
        chainId: matchingChain.chainId,
        type: matchingChain.type,
      };

      const payload = await createSIWxPayload(completeInfo, signer);
      const header = encodeSIWxHeader(payload);
      return { headers: { [SIGN_IN_WITH_X]: header } };
    } catch {
      // Failed to create SIWX payload, continue to payment
    }
  };
}

/**
 * Creates a SIWX client extension that signs HTTP SIWX challenges for compatible wallets.
 *
 * @param options - Client extension configuration (signers tried in order until one succeeds)
 * @returns x402 client extension registering HTTP transport hooks for SIWX
 */
export function createSIWxClientExtension(
  options: CreateSIWxClientExtensionOptions,
): ClientExtension {
  const hooks = options.signers.map(createSIWxClientHook);

  return {
    key: SIGN_IN_WITH_X,
    transportHooks: {
      http: {
        onPaymentRequired: async (_declaration: unknown, context: PaymentRequiredContext) => {
          for (const hook of hooks) {
            const result = await hook(context);
            if (result?.headers) return result;
          }
        },
      },
    },
  };
}
