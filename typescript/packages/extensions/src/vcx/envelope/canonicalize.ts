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

import canonicalize from "canonicalize";
import { createHash } from "crypto";
import type { IdentityEnvelope } from "../types";

/**
 * JCS-canonicalize an arbitrary JSON-shaped value per spec §17 / RFC 8785
 * and return the UTF-8 bytes. Used internally by {@link canonicalEnvelope}
 * and by the didDocumentHash check in `src/credential/trustlist.ts`.
 *
 * @param value - The JSON-shaped value to canonicalize.
 * @returns The UTF-8 bytes of the JCS-canonical JSON serialization.
 */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  const json = canonicalize(value);
  if (typeof json !== "string") {
    throw new Error("JCS canonicalization returned non-string");
  }
  return new TextEncoder().encode(json);
}

/**
 * `"sha256:" + lowercase-hex SHA-256` over the JCS-canonical bytes. The
 * canonical VCX digest format (spec §6.4 envelopeDigest, §8.2
 * didDocumentHash, §17.3 future digest sites).
 *
 * @param value - The JSON-shaped value to hash.
 * @returns The `"sha256:"`-prefixed lowercase-hex SHA-256 digest of the
 *   JCS-canonical bytes.
 */
export function jcsSha256(value: unknown): string {
  const bytes = canonicalJsonBytes(value);
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

/**
 * JCS-canonicalize the envelope per spec §17 and return the UTF-8 bytes.
 *
 * The output is byte-deterministic across implementations that conform to
 * RFC 8785. Two envelopes with identical content but different JSON key
 * insertion order MUST produce identical output.
 *
 * @param envelope - The identity envelope to canonicalize.
 * @returns The UTF-8 bytes of the envelope's JCS-canonical JSON
 *   serialization.
 */
export function canonicalEnvelope(envelope: IdentityEnvelope): Uint8Array {
  return canonicalJsonBytes(envelope);
}

/**
 * Compute the content-addressable envelope digest per spec §6.4.
 *
 * Returns `"sha256:" + lowercase-hex SHA-256` over the JCS-canonical bytes.
 * Suitable for embedding in facilitator settle-time receipts (spec §16.1)
 * and any other audit-time correlation surface.
 *
 * @param envelope - The identity envelope to digest.
 * @returns The `"sha256:"`-prefixed lowercase-hex SHA-256 envelope digest.
 */
export function envelopeDigest(envelope: IdentityEnvelope): string {
  return jcsSha256(envelope);
}
