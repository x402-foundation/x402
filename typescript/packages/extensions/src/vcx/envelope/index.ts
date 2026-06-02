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

export {
  buildIdentityEnvelope,
  buildEnvelopeFromRequirements,
} from "./builder";
export type { BuildEnvelopeOpts } from "./builder";

export { verifyEnvelope } from "./verifier";
export type { VerifyEnvelopeOptions } from "./verifier";

export { canonicalEnvelope, envelopeDigest } from "./canonicalize";

export {
  checkCredentialStatus,
  InMemoryStatusListCache,
} from "./revocation";
export type {
  StatusListCache,
  CachedStatusList,
  RevocationCheckResult,
  CheckCredentialStatusOptions,
} from "./revocation";

export {
  verifySdJwtVcPresentation,
  buildDisclosure,
  disclosureHash,
  parseDisclosure,
  parseSdJwt,
  buildSdIssuerSubject,
  composeSdJwt,
} from "./sdjwtvc";
export type { Disclosure, VerifiedSdJwtVc } from "./sdjwtvc";
