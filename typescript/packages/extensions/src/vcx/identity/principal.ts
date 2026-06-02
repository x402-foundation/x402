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

export function meetsKycRequirement(
  actual: KycLevel,
  required: KycLevel,
): boolean {
  return KYC_LEVEL_ORDER[actual] >= KYC_LEVEL_ORDER[required];
}
