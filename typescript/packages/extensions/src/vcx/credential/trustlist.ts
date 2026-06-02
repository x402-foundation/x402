/**
 * Copyright 2026 PayPal Holdings, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { verifyJWT } from "did-jwt";
import type { Resolvable } from "did-resolver";
import { jcsSha256 } from "../envelope/canonicalize";

/**
 * One entry in a trust list. `did` is the issuer DID the verifier
 * should accept; the optional `didDocumentHash` (per spec §8.2) pins
 * the resolved DID document by content hash so a DNS / BGP / TLS-MITM
 * attacker cannot substitute a malicious DID document even if they
 * control the issuer's domain transiently.
 */
export interface TrustListEntry {
  did: string;
  didDocumentHash?: string;
}

const DEFAULT_TRUST_LIST_TTL_SECONDS = 60 * 60;

export interface CachedTrustList {
  entries: TrustListEntry[];
  /** Epoch milliseconds. Reads past this point MUST refetch. */
  expiresAt: number;
}

/**
 * Pluggable cache for resolved well-known trust lists. The default
 * {@link InMemoryTrustListCache} is fine for single-process verifiers;
 * multi-instance verifiers SHOULD provide a shared store so a trust
 * list update applied to one instance propagates.
 */
export interface TrustListCache {
  get(ref: string): CachedTrustList | undefined;
  set(ref: string, entries: TrustListEntry[], ttlSeconds: number): void;
}

export class InMemoryTrustListCache implements TrustListCache {
  private readonly store = new Map<string, CachedTrustList>();

  get(ref: string): CachedTrustList | undefined {
    const entry = this.store.get(ref);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(ref);
      return undefined;
    }
    return entry;
  }

  set(ref: string, entries: TrustListEntry[], ttlSeconds: number): void {
    this.store.set(ref, {
      entries,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }
}

export interface ResolveAcceptedIssuersOptions {
  resolver: Resolvable;
  cache?: TrustListCache;
  fetchImpl?: typeof fetch;
}

/**
 * Resolve each `acceptedIssuers` reference (spec §8) to a flat list of
 * {@link TrustListEntry}. Three transports are supported in v1:
 *
 * - **§8.1 inline DID URI** (`did:web:...`, `did:key:z...`): returned
 *   as-is with no `didDocumentHash` pin.
 * - **§8.2 well-known JWS-signed JSON** (HTTPS URL): fetched, the JWS
 *   verified against the publisher's DID, and the embedded `issuers`
 *   array (with optional `didDocumentHash`) returned.
 * - **§8.3 ETSI Trusted List**: deferred to v1.1. Returns an explicit
 *   "deferred" error so a verifier configured with one fails-closed
 *   rather than silently accepting.
 */
export async function resolveAcceptedIssuers(
  refs: readonly string[],
  options: ResolveAcceptedIssuersOptions,
): Promise<TrustListEntry[]> {
  const entries: TrustListEntry[] = [];
  for (const ref of refs) {
    if (ref.startsWith("did:")) {
      entries.push({ did: ref });
      continue;
    }
    if (ref.startsWith("https://")) {
      if (ref.endsWith(".xml") || /\/etsi\//i.test(ref)) {
        throw new Error(
          `Trust-list reference appears to be ETSI (${ref}); ETSI Trusted List transport (spec §8.3) is deferred to v1.1`,
        );
      }
      const resolved = await fetchWellKnownTrustList(ref, options);
      entries.push(...resolved);
      continue;
    }
    if (ref.startsWith("http://")) {
      throw new Error(
        `Trust-list reference MUST be HTTPS (spec §8.2); got ${ref}`,
      );
    }
    throw new Error(
      `Unrecognised acceptedIssuers reference shape: ${ref}. Expected inline DID URI, https://.../.well-known/vcx-trust-list, or ETSI URL.`,
    );
  }
  return entries;
}

async function fetchWellKnownTrustList(
  ref: string,
  options: ResolveAcceptedIssuersOptions,
): Promise<TrustListEntry[]> {
  const cache = options.cache;
  const cached = cache?.get(ref);
  if (cached) return cached.entries;

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(ref);
  if (!response.ok) {
    throw new Error(`Trust-list fetch ${ref} returned HTTP ${response.status}`);
  }
  const jws = (await response.text()).trim();
  const ttlSeconds = parseCacheControlMaxAge(response.headers.get("cache-control"));

  // Verify the JWS against any DID in the resolver. did-jwt's verifyJWT
  // resolves the `iss` claim from the JWT payload, looks up keys in the
  // DID document, and verifies. Throws on failure.
  let verified: Awaited<ReturnType<typeof verifyJWT>>;
  try {
    verified = await verifyJWT(jws, { resolver: options.resolver });
  } catch (err) {
    throw new Error(
      `Trust-list JWS verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const payload = verified.payload as {
    issuer?: unknown;
    issuers?: unknown;
    validFrom?: unknown;
    validUntil?: unknown;
  };

  // The publisher DID in the body MUST match the JWS issuer; otherwise
  // an attacker could repackage a different publisher's trust list and
  // claim it as their own.
  if (payload.issuer !== verified.issuer) {
    throw new Error(
      `Trust-list body.issuer (${String(payload.issuer)}) does not match JWS iss (${verified.issuer})`,
    );
  }

  // Enforce validity window (spec §8.2 doesn't pin format but documents
  // validFrom/validUntil in the example). Strict ISO 8601 timestamps.
  const now = Date.now();
  if (typeof payload.validFrom === "string") {
    const ms = Date.parse(payload.validFrom);
    if (Number.isFinite(ms) && ms > now) {
      throw new Error(`Trust-list validFrom (${payload.validFrom}) is in the future`);
    }
  }
  if (typeof payload.validUntil === "string") {
    const ms = Date.parse(payload.validUntil);
    if (Number.isFinite(ms) && ms <= now) {
      throw new Error(`Trust-list validUntil (${payload.validUntil}) has passed`);
    }
  }

  if (!Array.isArray(payload.issuers)) {
    throw new Error("Trust-list body.issuers MUST be an array");
  }
  const entries: TrustListEntry[] = [];
  for (const raw of payload.issuers) {
    if (!raw || typeof raw !== "object") {
      throw new Error("Each trust-list issuers entry MUST be an object");
    }
    const obj = raw as { did?: unknown; didDocumentHash?: unknown };
    if (typeof obj.did !== "string" || obj.did.length === 0) {
      throw new Error("Each trust-list issuers entry MUST have a string `did`");
    }
    const entry: TrustListEntry = { did: obj.did };
    if (obj.didDocumentHash !== undefined) {
      if (typeof obj.didDocumentHash !== "string") {
        throw new Error(
          `Trust-list entry didDocumentHash MUST be a string; got ${typeof obj.didDocumentHash}`,
        );
      }
      if (!/^sha256:[0-9a-f]{64}$/.test(obj.didDocumentHash)) {
        throw new Error(
          `Trust-list entry didDocumentHash MUST be "sha256:<lowercase-hex>"; got ${obj.didDocumentHash}`,
        );
      }
      entry.didDocumentHash = obj.didDocumentHash;
    }
    entries.push(entry);
  }
  cache?.set(ref, entries, ttlSeconds);
  return entries;
}

/**
 * After Step 1's JWS check, when the trust-list entry for the resolved
 * issuer publishes a `didDocumentHash`, recompute the hash by
 * resolving the issuer DID and JCS-canonicalizing the returned DID
 * document. If the hash differs, the resolved document was tampered
 * (or rotated without an updated trust-list publication) and the
 * envelope MUST be rejected (spec §8.2 / §13.3).
 */
export async function verifyDidDocumentHash(opts: {
  issuerDid: string;
  expectedHash: string;
  resolver: Resolvable;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  let result: Awaited<ReturnType<Resolvable["resolve"]>>;
  try {
    result = await opts.resolver.resolve(opts.issuerDid);
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to resolve issuer DID ${opts.issuerDid} for hash pinning: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!result.didDocument) {
    return {
      ok: false,
      reason: `Issuer DID ${opts.issuerDid} resolved to no document (${result.didResolutionMetadata.error ?? "unknown"})`,
    };
  }
  const computed = jcsSha256(result.didDocument);
  if (computed !== opts.expectedHash) {
    return {
      ok: false,
      reason: `didDocumentHash mismatch for ${opts.issuerDid}: expected ${opts.expectedHash}, computed ${computed}`,
    };
  }
  return { ok: true };
}

function parseCacheControlMaxAge(header: string | null): number {
  if (!header) return DEFAULT_TRUST_LIST_TTL_SECONDS;
  const match = header.match(/max-age=(\d+)/i);
  if (!match) return DEFAULT_TRUST_LIST_TTL_SECONDS;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TRUST_LIST_TTL_SECONDS;
}
