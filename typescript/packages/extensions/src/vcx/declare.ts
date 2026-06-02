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

import type {
  IdentityRequirements,
  DisclosureTier,
  KycLevel,
} from "./types";
import { buildVCXEnvelopeSchema, type VCXEnvelopeSchema } from "./schema";

/** Extension key registered with the x402 v2 runtime (spec §4). */
export const VCX_EXTENSION_KEY = "vcx";

/** Protocol version this implementation speaks. */
const VCX_PROTOCOL_VERSION = "x402-vcx-v1" as const;

export interface DeclareVCXOptions {
  disclosureTier: DisclosureTier;
  requiredClaims?: string[];
  minKycLevel?: KycLevel;
  /**
   * Trust-list references. Each entry MUST resolve to a set of issuer DIDs
   * via one of the transports defined in spec §8: a literal DID URI, a URL
   * to a `/.well-known/vcx-trust-list` endpoint, or a URL to an ETSI
   * Trusted List.
   */
  acceptedIssuers: string[];
  /** Protocol version override. Defaults to `"x402-vcx-v1"`. */
  protocol?: typeof VCX_PROTOCOL_VERSION;
}

/**
 * Extension declaration object returned by `declareVCXExtension`. Stored on
 * the route declaration and consumed at request time by the server extension.
 */
export interface VCXDeclaration {
  info: IdentityRequirements;
  schema: VCXEnvelopeSchema;
  _options: DeclareVCXOptions;
}

/**
 * Declare the VCX extension on a route.
 *
 * @example
 * ```typescript
 * const routes = {
 *   "GET /premium/data": {
 *     accepts: [{ scheme: "exact", price: "$0.01", network: "eip155:8453" }],
 *     extensions: declareVCXExtension({
 *       disclosureTier: 1,
 *       requiredClaims: ["kycLevel", "ageOver18"],
 *       minKycLevel: "IdentityVerified",
 *       acceptedIssuers: ["did:web:paypal.com"],
 *     }),
 *   },
 * };
 * ```
 */
export function declareVCXExtension(
  options: DeclareVCXOptions,
): Record<string, VCXDeclaration> {
  // Conditional spread so optional fields are absent when undefined, rather
  // than serialised as explicit-undefined keys.
  const info: IdentityRequirements = {
    protocol: options.protocol ?? VCX_PROTOCOL_VERSION,
    disclosureTier: options.disclosureTier,
    acceptedIssuers: options.acceptedIssuers,
    ...(options.requiredClaims !== undefined && {
      requiredClaims: options.requiredClaims,
    }),
    ...(options.minKycLevel !== undefined && {
      minKycLevel: options.minKycLevel,
    }),
  };

  return {
    [VCX_EXTENSION_KEY]: {
      info,
      schema: buildVCXEnvelopeSchema(),
      _options: options,
    },
  };
}
