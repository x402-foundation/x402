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

// ---------------------------------------------------------------------------
// VCX Protocol Types — x402 v2 Extension
// Spec: specs/vcx.md
// ---------------------------------------------------------------------------

// --- Disclosure Tiers ---

export enum DisclosureTier {
  IssuerOnly = 0,
  SelectiveClaims = 1,
  FullDisclosure = 2,
}

// --- Identity Requirements (server → client, in 402 response extensions) ---

export interface IdentityRequirements {
  protocol: "x402-vcx-v1";
  disclosureTier: DisclosureTier;
  requiredClaims?: string[];
  minKycLevel?: KycLevel;
  acceptedIssuers: string[];
}

// --- KYC Levels ---

export type KycLevel = "Unverified" | "EmailVerified" | "IdentityVerified" | "BusinessVerified";

export const KYC_LEVEL_ORDER: Record<KycLevel, number> = {
  Unverified: 0,
  EmailVerified: 1,
  IdentityVerified: 2,
  BusinessVerified: 3,
};

// --- Principal Layer ---

export interface PrincipalClaims {
  [key: string]: unknown;
  kycLevel?: KycLevel;
  ageOver18?: boolean;
  jurisdiction?: string;
  paymentsEnabled?: boolean;
  emailVerified?: boolean;
  accountType?: string;
}

/**
 * Permitted credential serialisation formats per spec §6.1.
 *
 * - `jwt-vc` — plain JWT-based W3C VC. Used for Tier 0 (IssuerOnly) and
 *   Tier 2 (FullDisclosure) per §12.
 * - `sd-jwt-vc` — SD-JWT VC presentation per draft-ietf-oauth-sd-jwt-vc.
 *   Used for Tier 1 (SelectiveClaims). Verification is deferred to the
 *   v1.0.0 SDK release; envelopes setting this format on a pre-1.0.0
 *   verifier MUST be rejected at Step 1.
 */
export type CredentialFormat = "jwt-vc" | "sd-jwt-vc";

export interface PrincipalLayer {
  credentialFormat: CredentialFormat;
  credentialJwt: string;
  did: string;
  disclosed: PrincipalClaims;
}

// --- Agent Layer ---

export interface AgentDelegation {
  agentDid: string;
  paymentSource?: string;
  conditions?: DelegationConditions;
}

export interface DelegationConditions {
  maxPerTransaction?: string;
  maxDaily?: string;
  allowedNetworks?: string[];
  allowedAssets?: string[];
  expiresAt?: string;
}

/**
 * Delegation-proof profile discriminator per spec §6.2 / §10.
 *
 * v1 normative profile is `"vc-embedded"` (delegation inside the principal's
 * VC under `credentialSubject.delegatedTo`). Reserved values from §10
 * (`ucan`, `cacao`, `hdp`) are intentionally absent from this union: v1
 * verifiers MUST reject any other value, and accepting them at the type
 * level would invite a builder to emit one.
 */
export type DelegationProofFormat = "vc-embedded";

export interface AgentLayer {
  did: string;
  name: string;
  delegationProofFormat: DelegationProofFormat;
  delegationProof: string;
}

// --- Payment Source Layer ---

export interface PaymentSourceLayer {
  accountId: string;
  sourceId: string;
  network: string;
  asset?: string;
}

// --- Payment Details (verifier input, spec §9.2 / §9.3) ---

/**
 * Payment-payload-derived inputs the verifier needs to enforce both
 * Step 3 envelope-to-payment binding (sender) and Step 2 delegation
 * conditions (amount). Extracted by the integrator from the x402
 * payment payload, since the extraction path is scheme-specific.
 *
 * `network` and `asset` are intentionally absent: spec §9.2 enforces
 * `allowedNetworks` / `allowedAssets` against the envelope's
 * `paymentSource.network` / `paymentSource.asset` fields, not against
 * the payment payload, so the verifier reads them from the envelope
 * itself.
 */
export interface PaymentDetails {
  /** The sender / from-address on the x402 payment payload. */
  sender: string;
  /**
   * The amount being charged on the matching payment payload, as a
   * decimal string in the scheme's smallest unit. REQUIRED whenever the
   * credential's delegation carries `maxPerTransaction` or `maxDaily`.
   */
  amount?: string;
}

// --- Identity Envelope ---

export interface IdentityEnvelope {
  version: "1.0";
  protocol: "x402-vcx-v1";
  transactionId: string;
  /**
   * Passive-observer flag per spec §6 envelope table. Always the literal
   * `true` in v1; the field exists so indexers and analytics can flag
   * VCX-attested traffic without dereferencing principal claims.
   */
  vcxPresent: true;
  principal: PrincipalLayer;
  agent: AgentLayer;
  paymentSource: PaymentSourceLayer;
}

// --- Verification ---

export type VerificationStep =
  | "principal_credential"
  | "agent_delegation"
  | "payment_source_binding"
  | "payment_settlement";

export interface VerificationResult {
  step: VerificationStep;
  success: boolean;
  error?: string;
}

export interface FullVerificationResult {
  valid: boolean;
  steps: VerificationResult[];
}

// --- Credential Subject (for W3C VC issuance) ---

export interface VCXCredentialSubject {
  id: string;
  kycLevel: KycLevel;
  emailVerified?: boolean;
  paymentsEnabled?: boolean;
  accountType?: string;
  ageOver18?: boolean;
  jurisdiction?: string;
  delegatedTo: AgentDelegation;
}

// --- Issuer Configuration ---

export interface IssuerConfig {
  privateKeyHex: string;
  did: string;
}
