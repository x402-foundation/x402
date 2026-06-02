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

export function buildIdentityEnvelope(
  opts: BuildEnvelopeOpts
): IdentityEnvelope {
  const disclosed = selectDisclosedClaims(
    opts.principalClaims,
    opts.disclosureTier ?? 1,
    opts.requiredClaims
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

export function buildEnvelopeFromRequirements(
  opts: Omit<BuildEnvelopeOpts, "disclosureTier" | "requiredClaims">,
  requirements: IdentityRequirements
): IdentityEnvelope {
  return buildIdentityEnvelope({
    ...opts,
    disclosureTier: requirements.disclosureTier,
    requiredClaims: requirements.requiredClaims,
  });
}

function selectDisclosedClaims(
  claims: PrincipalClaims,
  tier: DisclosureTier,
  requiredClaims?: string[]
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
