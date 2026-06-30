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

import { gunzipSync } from "zlib";
import { verifyCredential } from "did-jwt-vc";
import type { Resolvable } from "did-resolver";

/**
 * Maximum lifetime for the short-lived revocation profile (spec §11.1):
 * 24 hours, after which a credential MUST carry a `credentialStatus`
 * field per the status-list profile (§11.2).
 */
const SHORT_LIVED_MAX_SECONDS = 24 * 60 * 60;

/**
 * Default cache TTL for status-list fetches when the response carries no
 * `Cache-Control: max-age=…`. Set to one hour per spec §11.2.
 */
const DEFAULT_STATUS_LIST_TTL_SECONDS = 60 * 60;

/**
 * In-memory cache entry shape.
 */
export interface CachedStatusList {
  /** Decoded, decompressed bitstring bytes. */
  bitstring: Uint8Array;
  /** Epoch milliseconds. Reads past this point MUST refetch. */
  expiresAt: number;
}

/**
 * Pluggable cache for fetched Bitstring Status List bytes (spec §11.2).
 * The default `InMemoryStatusListCache` is suitable for single-process
 * deployments; multi-instance verifiers SHOULD provide a shared store
 * (Redis, distributed cache) so a revocation event applied to one
 * instance's cache doesn't leave another instance accepting the same
 * credential until its independent TTL expires.
 */
export interface StatusListCache {
  get(url: string): CachedStatusList | undefined;
  set(url: string, bitstring: Uint8Array, ttlSeconds: number): void;
}

/**
 * In-process {@link StatusListCache} backed by a `Map`. Entries expire on
 * read once their TTL elapses. Suitable for single-process verifiers; not
 * shared across instances.
 */
export class InMemoryStatusListCache implements StatusListCache {
  private readonly store = new Map<string, CachedStatusList>();

  /**
   * Return the cached status list for a URL, or `undefined` when absent or
   * expired. Expired entries are evicted on access.
   *
   * @param url - The status-list credential URL to look up.
   * @returns The cached entry, or `undefined` when missing or expired.
   */
  get(url: string): CachedStatusList | undefined {
    const entry = this.store.get(url);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(url);
      return undefined;
    }
    return entry;
  }

  /**
   * Store decoded status-list bytes for a URL with the given TTL.
   *
   * @param url - The status-list credential URL to cache under.
   * @param bitstring - The decoded, decompressed status-list bytes.
   * @param ttlSeconds - Time-to-live in seconds before the entry expires.
   */
  set(url: string, bitstring: Uint8Array, ttlSeconds: number): void {
    this.store.set(url, {
      bitstring,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }
}

/**
 * Result of a revocation check. `ok: false` always carries a reason
 * suitable for inclusion in the verifier's step-1 error message.
 */
export type RevocationCheckResult = { ok: true } | { ok: false; reason: string };

export interface CheckCredentialStatusOptions {
  /** Issuer DID of the verified principal credential (spec §11.2). */
  issuerDid: string;
  /** Resolver shared with the verifier. */
  resolver: Resolvable;
  /** Cache. Defaults to a new {@link InMemoryStatusListCache} per call. */
  cache?: StatusListCache;
  /**
   * Override the fetch function (testing). Defaults to global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Run the spec §11 revocation check against a verified credential's JWT
 * payload. Detects the short-lived (§11.1) vs status-list (§11.2)
 * profile and enforces the relevant MUSTs.
 *
 * @param payload - The `payload` field returned by did-jwt-vc's
 *   verifyCredential. Must include `nbf` and `exp` (epoch seconds) and
 *   the W3C VC body under `vc`.
 * @param options - Revocation-check options (issuer DID, resolver, cache,
 *   and fetch override).
 * @returns `{ ok: true }` when the credential is not revoked, or
 *   `{ ok: false, reason }` describing the failure.
 */
export async function checkCredentialStatus(
  payload: unknown,
  options: CheckCredentialStatusOptions,
): Promise<RevocationCheckResult> {
  const nbf = readEpochClaim(payload, "nbf");
  const exp = readEpochClaim(payload, "exp");
  if (nbf === undefined || exp === undefined) {
    return {
      ok: false,
      reason:
        "Credential JWT MUST carry both `nbf` and `exp` claims for revocation-profile detection (spec §11)",
    };
  }

  const credentialStatus = readCredentialStatus(payload);
  const lifetimeSeconds = exp - nbf;

  // Spec §11.1 short-lived profile: lifetime ≤ 24h AND no
  // `credentialStatus`. Reject either deviation.
  if (lifetimeSeconds <= SHORT_LIVED_MAX_SECONDS) {
    if (credentialStatus !== undefined) {
      return {
        ok: false,
        reason:
          "Short-lived credential (lifetime ≤ 24h) MUST NOT carry a credentialStatus field (spec §11.1)",
      };
    }
    return { ok: true };
  }

  // Spec §11.2 status-list profile. credentialStatus MUST be present.
  if (credentialStatus === undefined) {
    return {
      ok: false,
      reason: `Long-lived credential (lifetime ${lifetimeSeconds}s > 24h) MUST carry a credentialStatus field per Bitstring Status List v1.0 (spec §11.2)`,
    };
  }
  if (credentialStatus.type !== "BitstringStatusListEntry") {
    return {
      ok: false,
      reason: `credentialStatus.type MUST be "BitstringStatusListEntry"; got ${JSON.stringify(credentialStatus.type)}`,
    };
  }
  if (credentialStatus.statusPurpose !== "revocation") {
    return {
      ok: false,
      reason: `credentialStatus.statusPurpose MUST be "revocation" in v1; got ${JSON.stringify(credentialStatus.statusPurpose)}`,
    };
  }
  if (typeof credentialStatus.statusListCredential !== "string") {
    return {
      ok: false,
      reason: "credentialStatus.statusListCredential MUST be a string URL",
    };
  }
  const statusListIndex = parseStatusListIndex(credentialStatus.statusListIndex);
  if (statusListIndex === undefined) {
    return {
      ok: false,
      reason: `credentialStatus.statusListIndex MUST be a non-negative integer string; got ${JSON.stringify(credentialStatus.statusListIndex)}`,
    };
  }

  const cache = options.cache ?? new InMemoryStatusListCache();
  const fetchImpl = options.fetchImpl ?? fetch;

  let bitstring: Uint8Array;
  const cached = cache.get(credentialStatus.statusListCredential);
  if (cached) {
    bitstring = cached.bitstring;
  } else {
    let fetchResult: FetchedStatusList;
    try {
      fetchResult = await fetchAndVerifyStatusList({
        url: credentialStatus.statusListCredential,
        expectedIssuerDid: options.issuerDid,
        resolver: options.resolver,
        fetchImpl,
      });
    } catch (err) {
      return {
        ok: false,
        reason: `Failed to fetch / verify status list at ${credentialStatus.statusListCredential}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    cache.set(credentialStatus.statusListCredential, fetchResult.bitstring, fetchResult.ttlSeconds);
    bitstring = fetchResult.bitstring;
  }

  let bit: number;
  try {
    bit = getBit(bitstring, statusListIndex);
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to read bit ${statusListIndex} from status list: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (bit === 1) {
    return {
      ok: false,
      reason: `Credential is revoked (status list bit ${statusListIndex} is set)`,
    };
  }
  return { ok: true };
}

interface FetchedStatusList {
  bitstring: Uint8Array;
  ttlSeconds: number;
}

/**
 * Fetch a status-list credential, verify its JWS against the resolver,
 * confirm the issuer matches the credential issuer, and decode the
 * embedded bitstring (spec §11.2).
 *
 * @param args - The fetch-and-verify inputs.
 * @param args.url - The status-list credential URL to fetch.
 * @param args.expectedIssuerDid - The DID the status-list issuer MUST equal.
 * @param args.resolver - The DID resolver used to verify the status-list JWS.
 * @param args.fetchImpl - The fetch implementation to use.
 * @returns The decoded bitstring and the cache TTL derived from the
 *   response headers.
 */
async function fetchAndVerifyStatusList(args: {
  url: string;
  expectedIssuerDid: string;
  resolver: Resolvable;
  fetchImpl: typeof fetch;
}): Promise<FetchedStatusList> {
  const response = await args.fetchImpl(args.url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const body = await response.text();
  const ttlSeconds = parseCacheControlMaxAge(response.headers.get("cache-control"));

  // The status list credential is itself a JWT-encoded W3C VC. Verify
  // the JWS against the configured resolver; this is what the §11.2
  // "verify JWS against the status-list issuer's DID" MUST refers to.
  const verified = await verifyCredential(body, args.resolver);
  if (!verified.verified) {
    throw new Error("status list JWS verification failed");
  }

  // Spec §17 open question (v1 simplifying assumption): status-list
  // issuer MUST equal the credential issuer. v1.1 may relax via a
  // delegation-of-issuance profile.
  const statusListIssuer = readIssuer(verified.verifiableCredential.issuer);
  if (statusListIssuer !== args.expectedIssuerDid) {
    throw new Error(
      `status list issuer ${statusListIssuer ?? "(missing)"} MUST equal the credential issuer ${args.expectedIssuerDid} in v1`,
    );
  }

  // credentialSubject.encodedList per Bitstring Status List v1.0 §3.
  const subject = verified.verifiableCredential.credentialSubject as
    | { encodedList?: unknown; type?: unknown }
    | undefined;
  if (!subject || subject.type !== "BitstringStatusList") {
    throw new Error(
      `status list credentialSubject.type MUST be "BitstringStatusList"; got ${JSON.stringify(subject?.type)}`,
    );
  }
  if (typeof subject.encodedList !== "string") {
    throw new Error("status list credentialSubject.encodedList MUST be a string");
  }
  const bitstring = decodeEncodedList(subject.encodedList);

  return { bitstring, ttlSeconds };
}

/**
 * Read a finite numeric epoch-seconds claim from a JWT payload.
 *
 * @param payload - The JWT payload to read from.
 * @param key - The claim name to read (`"nbf"` or `"exp"`).
 * @returns The numeric claim value, or `undefined` when absent or not a
 *   finite number.
 */
function readEpochClaim(payload: unknown, key: "nbf" | "exp"): number | undefined {
  const value = (payload as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface CredentialStatusObject {
  type?: unknown;
  statusPurpose?: unknown;
  statusListIndex?: unknown;
  statusListCredential?: unknown;
}

/**
 * Extract the `vc.credentialStatus` object from a JWT payload, if present.
 *
 * @param payload - The JWT payload to read from.
 * @returns The credential-status object, or `undefined` when absent or not
 *   an object.
 */
function readCredentialStatus(payload: unknown): CredentialStatusObject | undefined {
  const vc = (payload as { vc?: unknown }).vc as { credentialStatus?: unknown } | undefined;
  const status = vc?.credentialStatus;
  if (!status || typeof status !== "object") return undefined;
  return status as CredentialStatusObject;
}

/**
 * Normalize a W3C VC `issuer` field (string or `{ id }` object) to its DID
 * string.
 *
 * @param issuer - The raw issuer value (string or object with `id`).
 * @returns The issuer DID string, or `undefined` when it cannot be
 *   determined.
 */
function readIssuer(issuer: unknown): string | undefined {
  if (typeof issuer === "string") return issuer;
  const id = (issuer as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Parse a `statusListIndex` into a non-negative safe integer, accepting
 * either a decimal-digit string or a number.
 *
 * @param raw - The raw status-list index value.
 * @returns The parsed non-negative integer, or `undefined` when invalid.
 */
function parseStatusListIndex(raw: unknown): number | undefined {
  if (typeof raw === "string") {
    if (!/^\d+$/.test(raw)) return undefined;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
    return raw;
  }
  return undefined;
}

/**
 * Derive a cache TTL in seconds from a `Cache-Control` header's `max-age`
 * directive, falling back to the default when absent or unparseable.
 *
 * @param header - The raw `Cache-Control` header value, or `null`.
 * @returns The TTL in seconds.
 */
function parseCacheControlMaxAge(header: string | null): number {
  if (!header) return DEFAULT_STATUS_LIST_TTL_SECONDS;
  const match = header.match(/max-age=(\d+)/i);
  if (!match) return DEFAULT_STATUS_LIST_TTL_SECONDS;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_STATUS_LIST_TTL_SECONDS;
}

/**
 * Decode the `encodedList` per Bitstring Status List v1.0 §3.4: a
 * multibase-prefixed (typically `u` for base64url-no-pad) GZIP-compressed
 * bitstring. Returns the decompressed bytes.
 *
 * @param encoded - The multibase-prefixed, GZIP-compressed encoded list.
 * @returns The decompressed bitstring bytes.
 */
function decodeEncodedList(encoded: string): Uint8Array {
  if (encoded.length === 0) {
    throw new Error("encodedList is empty");
  }
  const prefix = encoded[0];
  const body = encoded.slice(1);
  let raw: Buffer;
  if (prefix === "u") {
    raw = Buffer.from(body, "base64url");
  } else {
    throw new Error(`Unsupported multibase prefix "${prefix}"; v1 supports base64url (\`u\`) only`);
  }
  // GZIP-decompress per Bitstring Status List v1.0 §3.4.
  return new Uint8Array(gunzipSync(raw));
}

/**
 * MSB-first bit access into the decoded bitstring per Bitstring Status
 * List v1.0 §3.1 (the bit at position `i` is bit `7 - (i % 8)` of byte
 * `floor(i / 8)`).
 *
 * @param bitstring - The decoded status-list bytes.
 * @param index - The zero-based bit position to read.
 * @returns The bit value (0 or 1) at the given index.
 */
function getBit(bitstring: Uint8Array, index: number): number {
  const byteIdx = Math.floor(index / 8);
  if (byteIdx >= bitstring.length) {
    throw new Error(
      `statusListIndex ${index} is beyond the bitstring (${bitstring.length} bytes / ${bitstring.length * 8} bits)`,
    );
  }
  const bitIdx = index % 8;
  return (bitstring[byteIdx] >> (7 - bitIdx)) & 1;
}
