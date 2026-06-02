/**
 * Copyright 2026 PayPal Holdings, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { ResourceServerExtension } from "@x402/core/types";
import { verifyEnvelope } from "./envelope/verifier";
import { parseVCXHeader, VCX_HEADER_NAME } from "./header";
import { VCX_EXTENSION_KEY, type VCXDeclaration } from "./declare";
import {
  type NonceStorage,
  type DailyLimitStore,
  DEFAULT_NONCE_FRESHNESS_MS,
} from "./storage";
import type {
  IdentityEnvelope,
  FullVerificationResult,
  PaymentDetails,
} from "./types";

/**
 * Request context surface VCX needs during `onProtectedRequest`. A thin
 * subset of the x402 v2 HTTP request context, sufficient for header lookup
 * (and re-exposed to user-supplied `extractPaymentSender`).
 */
export interface VCXRequestContext {
  /** Case-insensitive header lookup. Returns undefined when absent. */
  getHeader: (name: string) => string | undefined;
}

export interface CreateVCXResourceServerExtensionOptions {
  /**
   * Extract payment details (sender + amount + asset + network) from the
   * request context. Used for Step 3 envelope-to-payment binding
   * (spec §9.3 / §13.2) and for Step 2 `maxPerTransaction` /
   * `allowedNetworks` / `allowedAssets` / `maxDaily` enforcement
   * (spec §9.2).
   *
   * Preferred over {@link extractPaymentSender} from v0.3 onward. Pass
   * this when registering on a route whose declared
   * `delegatedTo.conditions` may include `maxPerTransaction` or
   * `maxDaily` — without it, those checks fail-closed under
   * `strictDelegationConditions: true` or warn-and-skip otherwise.
   *
   * The implementation is scheme-specific:
   *
   * - `exact_evm`: decode `X-PAYMENT`, read
   *   `payload.authorization.from`, `payload.authorization.value`, and
   *   the asset address from the payment requirements.
   * - `exact_solana`: read the transaction fee-payer, the SystemProgram
   *   transfer amount, and the asset (typically SOL or a token mint).
   */
  extractPaymentDetails?: (
    ctx: VCXRequestContext,
  ) => PaymentDetails | Promise<PaymentDetails>;

  /**
   * Extract the payment sender identifier from the request context. Used
   * for the Step 3 envelope-to-payment binding check (spec §9.3 / §13.2).
   *
   * @deprecated Prefer {@link extractPaymentDetails}, which also supplies
   * the amount/asset/network needed for spec §9.2 condition enforcement.
   * Callers that use only `extractPaymentSender` on a route whose
   * credential carries `maxPerTransaction` will see the verifier
   * fail-closed (with `strictDelegationConditions: true`) or warn-and-skip
   * those specific checks. Kept for back-compat in v0.x; will be removed
   * in v2.0.
   */
  extractPaymentSender?: (
    ctx: VCXRequestContext,
  ) => string | Promise<string>;

  /**
   * Storage for transactionId uniqueness enforcement (spec §13.1).
   * REQUIRED in this revision — pass `new InMemoryNonceStorage()` for
   * single-process deployments or a shared-store implementation
   * (Redis, distributed cache) for multi-instance verifiers. There is no
   * default — the prior `NoOpNonceStorage` default silently disabled
   * replay protection and was non-conformant with the spec.
   */
  nonceStorage: NonceStorage;

  /**
   * Override the freshness window applied to the `transactionId` nonce.
   * Defaults to spec §13.1's 300 seconds.
   */
  nonceFreshnessMs?: number;

  /**
   * Store for `delegatedTo.conditions.maxDaily` enforcement (spec §9.2).
   * No default implementation is shipped; see {@link DailyLimitStore}.
   * When a credential carries `maxDaily` but this option is unset, the
   * verifier logs a `console.warn` and skips the check — unless
   * `strictDelegationConditions: true`, in which case it fails-closed.
   */
  dailyLimitStore?: DailyLimitStore;

  /**
   * When true, missing context that prevents enforcement of a present
   * delegation condition causes the verifier to fail-closed. Production
   * deployments in regulated environments SHOULD set this to true.
   * Default: false.
   */
  strictDelegationConditions?: boolean;

  /**
   * Invoked after every verification (success or failure) for audit
   * logging (spec §16).
   */
  onVerify?: (
    envelope: IdentityEnvelope,
    verification: FullVerificationResult,
  ) => void;
}

/**
 * Build the VCX server extension for registration with the x402 v2
 * `x402HTTPResourceServer`.
 *
 * @example
 * ```typescript
 * import {
 *   createVCXResourceServerExtension,
 *   InMemoryNonceStorage,
 * } from "@x402/vcx";
 *
 * const vcx = createVCXResourceServerExtension({
 *   extractPaymentSender: (ctx) => {
 *     const raw = ctx.getHeader("X-PAYMENT");
 *     if (!raw) return "";
 *     const payload = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
 *     return payload?.payload?.authorization?.from ?? "";
 *   },
 *   nonceStorage: new InMemoryNonceStorage(),
 * });
 *
 * const server = new x402HTTPResourceServer(resourceServer, routes)
 *   .registerExtension(vcx);
 * ```
 */
export function createVCXResourceServerExtension(
  options: CreateVCXResourceServerExtensionOptions,
): ResourceServerExtension {
  const freshnessMs = options.nonceFreshnessMs ?? DEFAULT_NONCE_FRESHNESS_MS;

  return {
    key: VCX_EXTENSION_KEY,

    enrichPaymentRequiredResponse: async (declaration) => {
      const decl = declaration as VCXDeclaration;
      return { info: decl.info, schema: decl.schema };
    },

    transportHooks: {
      http: {
        onProtectedRequest: async (
          declaration: unknown,
          context: unknown,
          _routeConfig: unknown,
        ): Promise<void | { abort: true; reason: string }> => {
          const decl = declaration as VCXDeclaration;
          const ctx = context as {
            adapter: { getHeader: (name: string) => string | undefined };
          };

          const adapterCtx: VCXRequestContext = {
            getHeader: (name) =>
              ctx.adapter.getHeader(name) ??
              ctx.adapter.getHeader(name.toLowerCase()),
          };

          const headerValue = adapterCtx.getHeader(VCX_HEADER_NAME);
          if (!headerValue) {
            return abort("missing VCX header");
          }

          let envelope: IdentityEnvelope;
          try {
            envelope = parseVCXHeader(headerValue);
          } catch (err) {
            return abort(
              `malformed envelope: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          let paymentDetails: PaymentDetails;
          try {
            if (options.extractPaymentDetails) {
              paymentDetails = await options.extractPaymentDetails(adapterCtx);
            } else if (options.extractPaymentSender) {
              paymentDetails = {
                sender: await options.extractPaymentSender(adapterCtx),
              };
            } else {
              return abort(
                "configuration error: one of extractPaymentDetails or extractPaymentSender MUST be provided",
              );
            }
          } catch (err) {
            return abort(
              `payment-details extractor threw: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          const verification = await verifyEnvelope(
            envelope,
            decl.info,
            paymentDetails.sender,
            {
              paymentAmount: paymentDetails.amount,
              dailyLimitStore: options.dailyLimitStore,
              strictDelegationConditions:
                options.strictDelegationConditions ?? false,
            },
          );

          options.onVerify?.(envelope, verification);

          if (!verification.valid) {
            const failed = verification.steps.find((s) => !s.success);
            return abort(
              `verification failed at ${failed?.step ?? "unknown"}: ${failed?.error ?? "no error message"}`,
            );
          }

          // Verify-then-record: only consume the nonce on successful
          // verification, so a failed verify doesn't poison the cache and
          // an attacker can't grief a victim by replaying their envelope
          // once to mark the nonce used.
          const replayed = await options.nonceStorage.checkAndRecord(
            envelope.transactionId,
            freshnessMs,
          );
          if (replayed) {
            return abort(
              `transactionId ${envelope.transactionId} already processed within the freshness window`,
            );
          }

          return undefined;
        },
      },
    },
  };
}

function abort(reason: string): { abort: true; reason: string } {
  return { abort: true, reason: `VCX: ${reason}` };
}
