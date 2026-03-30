/**
 * SIWX Lifecycle Hooks
 *
 * Pre-built hooks for integrating SIWX authentication with x402 servers and clients.
 */

import type { SIWxStorage } from "./storage";
import type { SIWxExtension, SIWxVerifyOptions, SignatureType } from "./types";
import type { SIWxSigner } from "./sign";
import { SIGN_IN_WITH_X } from "./types";
import { parseSIWxHeader } from "./parse";
import { validateSIWxMessage } from "./validate";
import { verifySIWxSignature } from "./verify";
import { createSIWxPayload } from "./client";
import { encodeSIWxHeader } from "./encode";
import { isSolanaSigner } from "./solana";

/**
 * Options for creating server-side SIWX hooks.
 */
export interface CreateSIWxHookOptions {
  /** Storage for tracking paid addresses */
  storage: SIWxStorage;
  /** Options for signature verification (e.g., EVM smart wallet support) */
  verifyOptions?: SIWxVerifyOptions;
  /** Optional callback for logging/debugging */
  onEvent?: (event: SIWxHookEvent) => void;
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
export function createSIWxSettleHook(options: CreateSIWxHookOptions) {
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
 * @param options - Hook configuration
 * @returns Hook function for x402HTTPResourceServer.onProtectedRequest()
 *
 * @example
 * ```typescript
 * const storage = new InMemorySIWxStorage();
 * const httpServer = new x402HTTPResourceServer(resourceServer, routes)
 *   .onProtectedRequest(createSIWxRequestHook({ storage }));
 * ```
 */
export function createSIWxRequestHook(options: CreateSIWxHookOptions) {
  const { storage, verifyOptions, onEvent } = options;

  // Validate nonce tracking is fully implemented or not at all
  const hasUsedNonce = typeof storage.hasUsedNonce === "function";
  const hasRecordNonce = typeof storage.recordNonce === "function";
  if (hasUsedNonce !== hasRecordNonce) {
    throw new Error(
      "SIWxStorage nonce tracking requires both hasUsedNonce and recordNonce to be implemented",
    );
  }

  return async (
    context: {
      adapter: { getHeader(name: string): string | undefined; getUrl(): string };
      path: string;
    },
    routeConfig?: { accepts?: unknown },
  ): Promise<void | { grantAccess: true }> => {
    // Try both cases for header (HTTP headers are case-insensitive)
    const header =
      context.adapter.getHeader(SIGN_IN_WITH_X) ||
      context.adapter.getHeader(SIGN_IN_WITH_X.toLowerCase());
    if (!header) return;

    try {
      const payload = parseSIWxHeader(header);
      const resourceUri = context.adapter.getUrl();

      const validation = await validateSIWxMessage(payload, resourceUri);
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
      const isAuthOnly = Array.isArray(routeConfig?.accepts) && routeConfig.accepts.length === 0;

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
