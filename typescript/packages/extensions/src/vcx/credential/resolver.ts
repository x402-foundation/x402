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

import { Resolver } from "did-resolver";
import type { DIDResolutionResult, DIDResolver, VerificationMethod } from "did-resolver";
import { base58btcDecode, base58Encode } from "../identity/base58";

/**
 * Configuration knobs for the hardened `did:web` resolver (spec §7.2).
 * These are read at resolver-construction time; pass via
 * {@link configureDidWebResolver} before the first {@link getDidResolver}
 * call, or call `configureDidWebResolver` then re-acquire.
 */
export interface DidWebHardeningConfig {
  /**
   * Override the fetch implementation. Defaults to the global `fetch`.
   * Primarily for testing — production deployments may also wrap to add
   * timeouts, retries, or proxy routing.
   */
  fetchImpl?: typeof fetch;
  /**
   * Maximum number of same-host redirects to follow before giving up.
   * Defaults to 0; spec §7.2 doesn't require redirect-following at all,
   * and most issuers serve `did.json` directly. Cross-host redirects are
   * ALWAYS rejected regardless of this number.
   */
  maxSameHostRedirects?: number;
}

let cachedResolver: Resolver | null = null;
let activeHardeningConfig: DidWebHardeningConfig = {};

/**
 * Override the `did:web` hardening config. Invalidates the cached
 * resolver so the next {@link getDidResolver} call rebuilds with the
 * new config. Use this in tests to inject a mock fetch.
 *
 * @param config - The hardening configuration to apply on the next resolver build.
 */
export function configureDidWebResolver(config: DidWebHardeningConfig): void {
  activeHardeningConfig = { ...config };
  cachedResolver = null;
}

/**
 * Return a cached DID resolver wired for the `did:key` and hardened
 * `did:web` methods, building it on first use from the active hardening
 * config and reusing it on subsequent calls.
 *
 * @returns The shared {@link Resolver} instance.
 */
export function getDidResolver(): Resolver {
  if (cachedResolver) return cachedResolver;

  cachedResolver = new Resolver({
    key: resolveDidKey,
    web: buildHardenedWebResolver(activeHardeningConfig),
  });

  return cachedResolver;
}

/**
 * Build a hardened `did:web` resolver per spec §7.2:
 *
 * - HTTPS-only (reject any URL whose scheme is not `https:`).
 * - Default Node `fetch` TLS chain + expiry + hostname validation
 *   (`rejectUnauthorized` is true by default and MUST NOT be disabled).
 * - No cross-host redirects: each 3xx Location MUST resolve to the same
 *   hostname as the original DID, else fail with a clear error.
 *
 * Replaces the unmodified `web-did-resolver` registration the SDK used
 * through v0.4. The shape `DIDResolver` is unchanged so consumers see
 * no API difference.
 *
 * @param config - Optional hardening configuration (fetch override, redirect limit).
 * @returns A {@link DIDResolver} that resolves `did:web` identifiers safely.
 */
export function buildHardenedWebResolver(config: DidWebHardeningConfig = {}): DIDResolver {
  const fetchImpl = config.fetchImpl ?? fetch;
  const maxRedirects = config.maxSameHostRedirects ?? 0;

  return async (did, _parsed, _resolver, options): Promise<DIDResolutionResult> => {
    let url: URL;
    try {
      url = didWebToUrl(did);
    } catch (err) {
      return webError("invalidDid", err instanceof Error ? err.message : String(err));
    }
    if (url.protocol !== "https:") {
      return webError(
        "notFound",
        `did:web resolution refused: ${url.protocol} is not https (spec §7.2)`,
      );
    }
    const originalHostname = url.hostname;

    let response: Response;
    try {
      response = await fetchWithSameHostRedirects({
        url,
        originalHostname,
        fetchImpl,
        maxRedirects,
      });
    } catch (err) {
      return webError("notFound", err instanceof Error ? err.message : String(err));
    }

    if (!response.ok) {
      return webError("notFound", `HTTP ${response.status} from ${url.toString()}`);
    }

    let didDocument: Record<string, unknown>;
    try {
      didDocument = (await response.json()) as Record<string, unknown>;
    } catch (err) {
      return webError(
        "notFound",
        `did.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (didDocument.id !== did) {
      return webError(
        "notFound",
        `did:web document.id "${String(didDocument.id)}" does not match resolved DID "${did}"`,
      );
    }

    return {
      didResolutionMetadata: {
        contentType: options.accept || "application/did+json",
      },
      didDocument: didDocument as DIDResolutionResult["didDocument"],
      didDocumentMetadata: {},
    };
  };
}

/**
 * Construct the HTTPS URL for a `did:web` per the DID method
 * specification: `did:web:DOMAIN[:PATH...]` →
 * `https://DOMAIN[/PATH...]/did.json`, or
 * `https://DOMAIN/.well-known/did.json` when there is no path. Domain
 * may be URL-encoded (`%3A` for the port colon).
 *
 * @param did - The `did:web` identifier to translate.
 * @returns The HTTPS URL of the corresponding `did.json` document.
 */
export function didWebToUrl(did: string): URL {
  if (!did.startsWith("did:web:")) {
    throw new Error(`Not a did:web identifier: ${did}`);
  }
  const identifier = did.slice("did:web:".length);
  if (identifier.length === 0) {
    throw new Error(`did:web identifier is empty`);
  }
  const segments = identifier.split(":");
  const domain = decodeURIComponent(segments[0]);
  const path = segments.slice(1).map(decodeURIComponent);
  const pathPart = path.length === 0 ? "/.well-known/did.json" : `/${path.join("/")}/did.json`;
  // URL constructor will throw on malformed domains; let that propagate.
  return new URL(`https://${domain}${pathPart}`);
}

/**
 * Fetch a URL while following only same-host HTTPS redirects up to a
 * limit. Any cross-host redirect, non-HTTPS redirect, missing `Location`
 * header, or exceeding the redirect limit throws (spec §7.2).
 *
 * @param args - The fetch parameters.
 * @param args.url - The initial URL to fetch.
 * @param args.originalHostname - The hostname redirects must stay within.
 * @param args.fetchImpl - The fetch implementation to use.
 * @param args.maxRedirects - The maximum number of same-host redirects to follow.
 * @returns The final non-redirect {@link Response}.
 */
async function fetchWithSameHostRedirects(args: {
  url: URL;
  originalHostname: string;
  fetchImpl: typeof fetch;
  maxRedirects: number;
}): Promise<Response> {
  let currentUrl = args.url;
  for (let attempt = 0; attempt <= args.maxRedirects; attempt += 1) {
    const response = await args.fetchImpl(currentUrl.toString(), {
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(
          `${response.status} redirect from ${currentUrl.toString()} with no Location header`,
        );
      }
      const next = new URL(location, currentUrl);
      if (next.protocol !== "https:") {
        throw new Error(`did:web redirect refused: ${next.protocol} is not https (spec §7.2)`);
      }
      if (next.hostname !== args.originalHostname) {
        throw new Error(
          `did:web cross-host redirect refused: ${currentUrl.hostname} → ${next.hostname} (spec §7.2)`,
        );
      }
      currentUrl = next;
      continue;
    }
    return response;
  }
  throw new Error(`did:web exceeded the maxSameHostRedirects limit (${args.maxRedirects})`);
}

/**
 * Build a failed `did:web` {@link DIDResolutionResult} carrying an error
 * code and human-readable message with a null DID document.
 *
 * @param error - The resolution error code.
 * @param message - The human-readable error message.
 * @returns A resolution result representing the failure.
 */
function webError(error: string, message: string): DIDResolutionResult {
  return {
    didResolutionMetadata: { error, message },
    didDocument: null,
    didDocumentMetadata: {},
  };
}

const resolveDidKey: DIDResolver = async (
  did,
  parsed,
  _resolver,
  options,
): Promise<DIDResolutionResult> => {
  try {
    const multicodecPublicKey = base58btcDecode(parsed.id);
    if (
      multicodecPublicKey.length !== 34 ||
      multicodecPublicKey[0] !== 0xed ||
      multicodecPublicKey[1] !== 0x01
    ) {
      return notFound("Only Ed25519 did:key identifiers are supported");
    }

    const publicKey = multicodecPublicKey.slice(2);
    const keyId = `${did}#${parsed.id}`;
    const verificationMethod: VerificationMethod = {
      id: keyId,
      type: "Ed25519VerificationKey2020",
      controller: did,
      publicKeyBase58: base58Encode(publicKey),
      publicKeyMultibase: parsed.id,
    };

    return {
      didResolutionMetadata: {
        contentType: options.accept || "application/did+json",
      },
      didDocument: {
        id: did,
        verificationMethod: [verificationMethod],
        authentication: [keyId],
        assertionMethod: [keyId],
        capabilityInvocation: [keyId],
        capabilityDelegation: [keyId],
      },
      didDocumentMetadata: {},
    };
  } catch (err) {
    return notFound(err instanceof Error ? err.message : String(err));
  }
};

/**
 * Build a `notFound` {@link DIDResolutionResult} carrying the given
 * message with a null DID document.
 *
 * @param message - The human-readable error message.
 * @returns A resolution result representing the not-found failure.
 */
function notFound(message: string): DIDResolutionResult {
  return {
    didResolutionMetadata: {
      error: "notFound",
      message,
    },
    didDocument: null,
    didDocumentMetadata: {},
  };
}
