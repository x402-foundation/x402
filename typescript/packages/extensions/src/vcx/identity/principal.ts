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

import {
  KYC_LEVEL_ORDER,
  type KycLevel,
  type PrincipalClaims,
  type VCXCredentialSubject,
  type AgentDelegation,
} from "../types";

export interface PrincipalIdentity {
  did: string;
  claims: PrincipalClaims;
}

/**
 * Assemble a VCX credential subject from a principal's DID, identity
 * claims, and an agent delegation. Missing KYC level defaults to
 * `"Unverified"`.
 *
 * @param opts - The inputs used to build the subject.
 * @param opts.principalDid - The DID of the principal that owns the credential.
 * @param opts.claims - The principal's identity claims.
 * @param opts.delegation - The agent delegation to embed as `delegatedTo`.
 * @returns The assembled VCX credential subject.
 */
export function buildCredentialSubject(opts: {
  principalDid: string;
  claims: PrincipalClaims;
  delegation: AgentDelegation;
}): VCXCredentialSubject {
  return {
    id: opts.principalDid,
    kycLevel: opts.claims.kycLevel ?? "Unverified",
    emailVerified: opts.claims.emailVerified,
    paymentsEnabled: opts.claims.paymentsEnabled,
    accountType: opts.claims.accountType,
    ageOver18: opts.claims.ageOver18,
    jurisdiction: opts.claims.jurisdiction,
    delegatedTo: opts.delegation,
  };
}

/**
 * Determine whether an actual KYC level satisfies a required level by
 * comparing their positions in the canonical KYC ordering.
 *
 * @param actual - The KYC level the principal currently holds.
 * @param required - The minimum KYC level demanded.
 * @returns `true` when the actual level meets or exceeds the required level.
 */
export function meetsKycRequirement(actual: KycLevel, required: KycLevel): boolean {
  return KYC_LEVEL_ORDER[actual] >= KYC_LEVEL_ORDER[required];
}
