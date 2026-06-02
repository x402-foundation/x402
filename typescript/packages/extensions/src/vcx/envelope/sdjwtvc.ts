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

import { createHash, randomBytes } from "crypto";
import { verifyJWT } from "did-jwt";
import type { Resolvable } from "did-resolver";

/**
 * Initial in-house SD-JWT VC implementation for spec §12 Tier 1.
 *
 * Why not `@sd-jwt/core`? The v1.0 SDK roadmap called for it, but the
 * package's exact v0.x API surface couldn't be verified against the
 * public npm registry from the development environment this code was
 * authored in. Shipping a small (~200 LOC) self-contained
 * implementation that we can statically verify line-by-line is safer
 * for a v1.0 reference impl than shipping API guesses. A follow-up PR
 * MAY swap this for `@sd-jwt/core` (or `@sd-jwt/sd-jwt-vc`) with the
 * `verifySdJwtVcPresentation` signature unchanged.
 *
 * The scope is intentionally narrow: support for the SD-JWT VC
 * presentation flow as VCX uses it. Out of scope here (and deferred
 * to a future PR):
 *
 * - Key-binding JWT verification (the trailing `~<kb-jwt>` segment).
 *   We parse-and-ignore; VCX v1 does not require it.
 * - Recursive / nested disclosures (SD-JWT v06+ allows disclosures
 *   pointing at other disclosures).
 * - Array element disclosures (`[salt, value]` 2-element arrays for
 *   array-element revelation, vs the 3-element `[salt, name, value]`
 *   we handle).
 *
 * Spec references throughout: draft-ietf-oauth-selective-disclosure-jwt
 * for the SD-JWT base format and draft-ietf-oauth-sd-jwt-vc for the
 * VC layer on top.
 */

export interface Disclosure {
  salt: string;
  name: string;
  value: unknown;
}

/**
 * Build a disclosure: a base64url-encoded JSON array
 * `[salt, name, value]`. The SHA-256 hash of this base64url string
 * (ASCII bytes) is what the issuer puts into the `_sd` array of the
 * SD-JWT payload; the disclosure itself is transmitted alongside the
 * JWT separated by `~`.
 */
export function buildDisclosure(
  name: string,
  value: unknown,
  salt?: string,
): string {
  const actualSalt = salt ?? randomBytes(16).toString("base64url");
  const json = JSON.stringify([actualSalt, name, value]);
  return Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Hash a disclosure string per SD-JWT: SHA-256 over the ASCII bytes
 * of the base64url-encoded disclosure, output base64url-encoded.
 */
export function disclosureHash(disclosure: string): string {
  return createHash("sha256").update(disclosure, "ascii").digest("base64url");
}

/**
 * Decode a base64url disclosure back into its `[salt, name, value]` parts.
 */
export function parseDisclosure(disclosure: string): Disclosure {
  let json: string;
  try {
    json = Buffer.from(disclosure, "base64url").toString("utf8");
  } catch (err) {
    throw new Error(
      `Disclosure is not valid base64url: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Disclosure is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(arr) || arr.length !== 3) {
    throw new Error(
      "Disclosure MUST be a 3-element array [salt, name, value] for object-property disclosures",
    );
  }
  if (typeof arr[0] !== "string" || typeof arr[1] !== "string") {
    throw new Error("Disclosure salt and name MUST be strings");
  }
  return { salt: arr[0], name: arr[1], value: arr[2] };
}

/**
 * Parse SD-JWT format: `<JWT>~<disclosure1>~<disclosure2>~...[~<kb-jwt>]`.
 * The trailing key-binding JWT is identified by its 2-dot JWT shape and
 * captured separately. Empty trailing segments (from the canonical
 * trailing `~`) are dropped.
 */
export function parseSdJwt(sdjwt: string): {
  jwt: string;
  disclosures: string[];
  keyBindingJwt?: string;
} {
  if (typeof sdjwt !== "string" || !sdjwt.includes("~")) {
    throw new Error("SD-JWT MUST contain at least one ~ separator");
  }
  const parts = sdjwt.split("~");
  const jwt = parts[0];
  const tail = parts.slice(1);
  // Drop trailing empties (e.g. "<jwt>~<d>~" canonical form).
  while (tail.length > 0 && tail[tail.length - 1] === "") tail.pop();
  let keyBindingJwt: string | undefined;
  if (tail.length > 0 && tail[tail.length - 1].split(".").length === 3) {
    keyBindingJwt = tail.pop();
  }
  return { jwt, disclosures: tail, keyBindingJwt };
}

export interface VerifiedSdJwtVc {
  /**
   * The verified JWT payload from the issuer-signed portion. Includes
   * non-disclosable claims as-is, plus the `_sd` digest array and any
   * `_sd_alg` field. Disclosed claim values are NOT spliced back into
   * this object — they're returned separately in `disclosed`.
   */
  payload: Record<string, unknown>;
  /** Issuer DID resolved from the JWT `iss` claim. */
  issuer: string;
  /**
   * Verified disclosed claims, keyed by name. Every entry here has been
   * cryptographically validated against the issuer-signed `_sd` digests;
   * a holder cannot inject an undisclosed claim.
   */
  disclosed: Record<string, unknown>;
}

/**
 * Verify an SD-JWT VC presentation per draft-ietf-oauth-sd-jwt-vc:
 *
 * 1. Split the presentation on `~`.
 * 2. Verify the issuer JWT's JWS against the configured resolver.
 * 3. Reject if `_sd_alg` is present and not `sha-256` (the only algorithm
 *    VCX v1.0 supports).
 * 4. Collect `_sd` digests from the top-level payload and from the
 *    `vc.credentialSubject` block (both placements are seen in the
 *    wild; VCX issuers use the `vc.credentialSubject` placement).
 * 5. For each disclosure, compute its SHA-256 hash. Reject if any
 *    disclosure's hash isn't in the `_sd` set (i.e. a holder appended
 *    a disclosure the issuer didn't commit to).
 * 6. Return the verified disclosed claims as a flat name→value map.
 */
export async function verifySdJwtVcPresentation(opts: {
  sdjwt: string;
  resolver: Resolvable;
}): Promise<VerifiedSdJwtVc> {
  const { jwt, disclosures } = parseSdJwt(opts.sdjwt);

  let verified;
  try {
    verified = await verifyJWT(jwt, { resolver: opts.resolver });
  } catch (err) {
    throw new Error(
      `SD-JWT VC: issuer JWT verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const payload = verified.payload as Record<string, unknown>;

  // _sd_alg defaults to sha-256 per spec; v1.0 supports only this value.
  const sdAlg = payload._sd_alg;
  if (sdAlg !== undefined && sdAlg !== "sha-256") {
    throw new Error(
      `SD-JWT VC: _sd_alg MUST be "sha-256" in v1; got ${JSON.stringify(sdAlg)}`,
    );
  }

  const sdDigests = collectSdDigests(payload);

  const disclosed: Record<string, unknown> = {};
  for (const d of disclosures) {
    const h = disclosureHash(d);
    if (!sdDigests.has(h)) {
      throw new Error(
        `SD-JWT VC: disclosure hash ${h} not present in issuer _sd commitments (forged disclosure)`,
      );
    }
    const parsed = parseDisclosure(d);
    disclosed[parsed.name] = parsed.value;
  }

  return {
    payload,
    issuer: verified.issuer,
    disclosed,
  };
}

/**
 * Collect every `_sd` digest commitment from a JWT payload. VCX issuers
 * place `_sd` inside `vc.credentialSubject` (so the disclosures map to
 * credential subject fields), but generic SD-JWT placement at the top
 * level is also accepted.
 */
function collectSdDigests(payload: Record<string, unknown>): Set<string> {
  const set = new Set<string>();
  addStringArrayToSet(payload._sd, set);
  const vc = payload.vc as { credentialSubject?: Record<string, unknown> } | undefined;
  if (vc?.credentialSubject) {
    addStringArrayToSet(vc.credentialSubject._sd, set);
  }
  return set;
}

function addStringArrayToSet(raw: unknown, set: Set<string>): void {
  if (!Array.isArray(raw)) return;
  for (const v of raw) {
    if (typeof v === "string") set.add(v);
  }
}

/**
 * Helper for tests / issuer-side code: given a base credential subject
 * object and a list of selectively-disclosable field names, build the
 * matching SD-JWT VC issuer payload (with `_sd` digests in place of
 * the disclosable values) and the disclosure strings.
 *
 * The caller then signs the payload (via did-jwt's `createJWT` or
 * did-jwt-vc's `createVerifiableCredentialJwt`) and assembles the
 * SD-JWT format `<jwt>~<d1>~<d2>~...`.
 */
export function buildSdIssuerSubject(opts: {
  subject: Record<string, unknown>;
  selectivelyDisclosable: readonly string[];
}): {
  issuerSubject: Record<string, unknown>;
  disclosures: string[];
} {
  const issuerSubject: Record<string, unknown> = {};
  const disclosures: string[] = [];
  const sdHashes: string[] = [];
  for (const [name, value] of Object.entries(opts.subject)) {
    if (opts.selectivelyDisclosable.includes(name)) {
      const d = buildDisclosure(name, value);
      disclosures.push(d);
      sdHashes.push(disclosureHash(d));
    } else {
      issuerSubject[name] = value;
    }
  }
  if (sdHashes.length > 0) {
    issuerSubject._sd = sdHashes;
    issuerSubject._sd_alg = "sha-256";
  }
  return { issuerSubject, disclosures };
}

/**
 * Concatenate a JWT and its disclosures into the canonical SD-JWT
 * format. Convenience for issuer-side composition; verification accepts
 * the same shape.
 */
export function composeSdJwt(jwt: string, disclosures: readonly string[]): string {
  return [jwt, ...disclosures].join("~") + "~";
}
