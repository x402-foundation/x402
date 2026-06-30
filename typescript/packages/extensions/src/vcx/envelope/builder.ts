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

import { randomUUID } from "crypto";
import type {
  IdentityEnvelope,
  PrincipalClaims,
  PaymentSourceLayer,
  DisclosureTier,
  IdentityRequirements,
  CredentialFormat,
  DelegationProofFormat,
} from "../types";

export interface BuildEnvelopeOpts {
  credentialJwt: string;
  principalDid: string;
  principalClaims: PrincipalClaims;
  agentDid: string;
  agentName: string;
  delegationProof: string;
  paymentSource: PaymentSourceLayer;
  disclosureTier?: DisclosureTier;
  requiredClaims?: string[];
  /**
   * Credential serialisation format per spec §6.1. Defaults to `"jwt-vc"`.
   * Callers that issue an SD-JWT VC presentation MUST pass `"sd-jwt-vc"`;
   * Tier 1 verification of those presentations requires SDK v1.0.0+.
   */
  credentialFormat?: CredentialFormat;
  /**
   * Delegation-proof profile per spec §6.2. Defaults to `"vc-embedded"`,
   * which is the only profile permitted by spec §10 in v1.
   */
  delegationProofFormat?: DelegationProofFormat;
}

/**
 * Build a VCX identity envelope from the principal credential, agent
 * delegation, and payment-source inputs. Selectively discloses principal
 * claims according to the requested disclosure tier (spec §6).
 *
 * @param opts - The envelope build inputs.
 * @param opts.credentialJwt - The principal's credential serialization.
 * @param opts.principalDid - The principal's DID.
 * @param opts.principalClaims - The full set of principal claims available
 *   for disclosure.
 * @param opts.agentDid - The delegated agent's DID.
 * @param opts.agentName - The delegated agent's human-readable name.
 * @param opts.delegationProof - The delegation proof authorizing the agent.
 * @param opts.paymentSource - The payment-source layer bound into the
 *   envelope.
 * @param opts.disclosureTier - The disclosure tier governing which
 *   principal claims are revealed. Defaults to tier 1.
 * @param opts.requiredClaims - Claim names to disclose under tier 1.
 * @param opts.credentialFormat - Credential serialization format (spec
 *   §6.1). Defaults to `"jwt-vc"`.
 * @param opts.delegationProofFormat - Delegation-proof profile (spec §6.2).
 *   Defaults to `"vc-embedded"`.
 * @returns The assembled identity envelope.
 */
export function buildIdentityEnvelope(opts: BuildEnvelopeOpts): IdentityEnvelope {
  const disclosed = selectDisclosedClaims(
    opts.principalClaims,
    opts.disclosureTier ?? 1,
    opts.requiredClaims,
  );

  return {
    version: "1.0",
    protocol: "x402-vcx-v1",
    transactionId: randomUUID(),
    vcxPresent: true,
    principal: {
      credentialFormat: opts.credentialFormat ?? "jwt-vc",
      credentialJwt: opts.credentialJwt,
      did: opts.principalDid,
      disclosed,
    },
    agent: {
      did: opts.agentDid,
      name: opts.agentName,
      delegationProofFormat: opts.delegationProofFormat ?? "vc-embedded",
      delegationProof: opts.delegationProof,
    },
    paymentSource: opts.paymentSource,
  };
}

/**
 * Build an identity envelope, deriving the disclosure tier and required
 * claims from a verifier's stated {@link IdentityRequirements} rather than
 * passing them explicitly.
 *
 * @param opts - The envelope build inputs, excluding the disclosure tier
 *   and required claims (which are taken from `requirements`).
 * @param requirements - The verifier's identity requirements supplying the
 *   disclosure tier and required claims.
 * @returns The assembled identity envelope.
 */
export function buildEnvelopeFromRequirements(
  opts: Omit<BuildEnvelopeOpts, "disclosureTier" | "requiredClaims">,
  requirements: IdentityRequirements,
): IdentityEnvelope {
  return buildIdentityEnvelope({
    ...opts,
    disclosureTier: requirements.disclosureTier,
    requiredClaims: requirements.requiredClaims,
  });
}

/**
 * Select which principal claims to disclose for a given disclosure tier.
 * Tier 0 discloses nothing, tier 2 discloses everything, and tier 1
 * discloses only the requested required claims (or everything when no
 * required claims are specified).
 *
 * @param claims - The full set of principal claims available.
 * @param tier - The disclosure tier governing the selection.
 * @param requiredClaims - Claim names to disclose under tier 1.
 * @returns The subset of claims to embed in the envelope.
 */
function selectDisclosedClaims(
  claims: PrincipalClaims,
  tier: DisclosureTier,
  requiredClaims?: string[],
): PrincipalClaims {
  if (tier === 0) return {};

  if (tier === 2) return { ...claims };

  if (!requiredClaims || requiredClaims.length === 0) return { ...claims };

  const disclosed: PrincipalClaims = {};
  for (const key of requiredClaims) {
    if (key in claims) {
      disclosed[key] = claims[key];
    }
  }
  return disclosed;
}
