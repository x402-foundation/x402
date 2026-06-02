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

// Protocol types
export type {
  IdentityRequirements,
  KycLevel,
  PrincipalClaims,
  PrincipalLayer,
  CredentialFormat,
  AgentDelegation,
  DelegationConditions,
  AgentLayer,
  DelegationProofFormat,
  PaymentSourceLayer,
  PaymentDetails,
  IdentityEnvelope,
  VerificationStep,
  VerificationResult,
  FullVerificationResult,
  VCXCredentialSubject,
  IssuerConfig,
} from "./types";

export { DisclosureTier, KYC_LEVEL_ORDER } from "./types";

// Identity primitives
export {
  generateEd25519KeyPair,
  publicKeyToDidKey,
  buildDid,
  buildCredentialSubject,
  meetsKycRequirement,
  createAgent,
  buildDelegation,
} from "./identity";
export type {
  Ed25519KeyPair,
  PrincipalIdentity,
  AgentIdentity,
} from "./identity";

// Credentials
export {
  createVCXIssuer,
  issueCredential,
  getDidResolver,
  configureDidWebResolver,
  buildHardenedWebResolver,
  didWebToUrl,
  resolveAcceptedIssuers,
  verifyDidDocumentHash,
  InMemoryTrustListCache,
} from "./credential";
export type {
  DidWebHardeningConfig,
  TrustListEntry,
  TrustListCache,
  CachedTrustList,
  ResolveAcceptedIssuersOptions,
} from "./credential";

// Envelope
export {
  buildIdentityEnvelope,
  buildEnvelopeFromRequirements,
  verifyEnvelope,
  canonicalEnvelope,
  envelopeDigest,
  checkCredentialStatus,
  InMemoryStatusListCache,
  verifySdJwtVcPresentation,
  buildDisclosure,
  disclosureHash,
  parseDisclosure,
  parseSdJwt,
  buildSdIssuerSubject,
  composeSdJwt,
} from "./envelope";
export type {
  BuildEnvelopeOpts,
  VerifyEnvelopeOptions,
  StatusListCache,
  CachedStatusList,
  RevocationCheckResult,
  CheckCredentialStatusOptions,
  Disclosure,
  VerifiedSdJwtVc,
} from "./envelope";

// V2 extension declaration
export { declareVCXExtension, VCX_EXTENSION_KEY } from "./declare";
export type { DeclareVCXOptions, VCXDeclaration } from "./declare";

// V2 extension factories
export { createVCXResourceServerExtension } from "./server";
export type {
  CreateVCXResourceServerExtensionOptions,
  VCXRequestContext,
} from "./server";

export { createVCXClientExtension } from "./client";
export type { CreateVCXClientExtensionOptions } from "./client";

// VCX header transport
export { VCX_HEADER_NAME, encodeVCXHeader, parseVCXHeader } from "./header";

// Replay-protection storage + daily-limit storage
export {
  InMemoryNonceStorage,
  NoOpNonceStorage,
  DEFAULT_NONCE_FRESHNESS_MS,
} from "./storage";
export type { NonceStorage, DailyLimitStore } from "./storage";

// JSON Schema for the envelope
export { buildVCXEnvelopeSchema } from "./schema";
export type { VCXEnvelopeSchema } from "./schema";
