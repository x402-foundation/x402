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

import type { ClientExtension } from "@x402/core/client";
import { buildEnvelopeFromRequirements } from "./envelope/builder";
import { encodeVCXHeader, VCX_HEADER_NAME } from "./header";
import { VCX_EXTENSION_KEY } from "./declare";
import type {
  IdentityRequirements,
  PrincipalClaims,
  PaymentSourceLayer,
} from "./types";
import type { AgentIdentity } from "./identity/agent";

export interface CreateVCXClientExtensionOptions {
  /** Pre-issued W3C VC JWT (or SD-JWT VC presentation) for the principal. */
  principalCredential: string;
  /** Principal DID. MUST equal `credentialSubject.id` of the credential. */
  principalDid: string;
  /** Claims the principal is willing to disclose at Tier 1 / Tier 2. */
  principalClaims: PrincipalClaims;
  /** Agent identity (typically created via `createAgent(name)`). */
  agent: AgentIdentity;
  /** Payment source binding the envelope to the x402 payment sender. */
  paymentSource: PaymentSourceLayer;
  /**
   * Delegation proof. Defaults to `principalCredential` for the v1
   * `vc-embedded` profile (spec §10), in which the delegation lives inside
   * the credential's `credentialSubject.delegatedTo`.
   */
  delegationProof?: string;
}

/**
 * Build the VCX client extension for registration with the x402 v2 client.
 *
 * On any 402 response whose `extensions` declares VCX, the extension
 * constructs an identity envelope from the configured principal credential,
 * agent identity, and payment source, then attaches it as the `VCX`
 * header on the resumed request.
 *
 * @example
 * ```typescript
 * import { createVCXClientExtension, createAgent } from "@x402/vcx";
 *
 * const vcx = createVCXClientExtension({
 *   principalCredential: myCredentialJwt,
 *   principalDid: "did:web:paypal.com:user/abc",
 *   principalClaims: { kycLevel: "IdentityVerified", ageOver18: true },
 *   agent: createAgent("my-payment-agent"),
 *   paymentSource: {
 *     accountId: "eip155:8453:0xA11CE...",
 *     sourceId: "0xA11CE...",
 *     network: "eip155:8453",
 *   },
 * });
 *
 * const client = new x402HTTPClient(...).registerExtension(vcx);
 * ```
 */
export function createVCXClientExtension(
  options: CreateVCXClientExtensionOptions,
): ClientExtension {
  return {
    key: VCX_EXTENSION_KEY,
    transportHooks: {
      http: {
        onPaymentRequired: async (
          _declaration: unknown,
          context: unknown,
        ): Promise<{ headers: Record<string, string> } | void> => {
          const ctx = context as {
            paymentRequired: { extensions?: Record<string, unknown> };
          };

          const declared = ctx.paymentRequired.extensions?.[VCX_EXTENSION_KEY] as
            | { info?: IdentityRequirements }
            | undefined;

          if (!declared?.info) return;

          const envelope = buildEnvelopeFromRequirements(
            {
              credentialJwt: options.principalCredential,
              principalDid: options.principalDid,
              principalClaims: options.principalClaims,
              agentDid: options.agent.did,
              agentName: options.agent.name,
              delegationProof:
                options.delegationProof ?? options.principalCredential,
              paymentSource: options.paymentSource,
            },
            declared.info,
          );

          return {
            headers: { [VCX_HEADER_NAME]: encodeVCXHeader(envelope) },
          };
        },
      },
    },
  };
}
