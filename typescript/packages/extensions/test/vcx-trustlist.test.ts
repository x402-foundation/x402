/**
 * Copyright 2026 PayPal Holdings, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest";
import { createJWT, EdDSASigner } from "did-jwt";
import {
  resolveAcceptedIssuers,
  verifyDidDocumentHash,
  InMemoryTrustListCache,
  getDidResolver,
} from "../src/vcx";
import { jcsSha256 } from "../src/vcx/envelope/canonicalize";
import { trustedIssuer } from "./vcx-test-utils";

const TRUST_LIST_URL = "https://trust.example.test/.well-known/vcx-trust-list";

/**
 * Build the signing options (issuer DID, EdDSA signer, alg) for the trusted
 * fixture issuer, used to sign trust list JWSs.
 *
 * @returns The createJWT signer options for the trusted issuer.
 */
function issuerSignerOpts() {
  const privateKeyBytes = Uint8Array.from(Buffer.from(trustedIssuer.privateKeyHex, "hex"));
  return {
    issuer: trustedIssuer.did,
    signer: EdDSASigner(privateKeyBytes),
    alg: "EdDSA",
  };
}

/**
 * Sign a trust list body into a JWS, defaulting the `iss` claim to the signer's issuer.
 *
 * @param body - The trust list body claims to sign.
 * @param signerOverride - Optional signer options to use instead of the trusted issuer.
 * @returns The signed trust list JWS.
 */
async function buildTrustListJws(
  body: Record<string, unknown>,
  signerOverride?: ReturnType<typeof issuerSignerOpts>,
): Promise<string> {
  return createJWT(
    {
      ...body,
      iss: (signerOverride ?? issuerSignerOpts()).issuer,
    },
    signerOverride ?? issuerSignerOpts(),
  );
}

/**
 * Build a `fetch` mock that serves the given JWS for the trust list URL and
 * 404s for everything else, tracking the number of calls made.
 *
 * @param opts - Options for the fetch mock.
 * @param opts.jws - The JWS response body returned for the trust list URL.
 * @param opts.cacheControl - Optional `cache-control` header value to include.
 * @returns A fetch-compatible function exposing a `calls` counter.
 */
function mockFetch(opts: { jws: string; cacheControl?: string }): typeof fetch & { calls: number } {
  const fn = (async (input: RequestInfo | URL): Promise<Response> => {
    fn.calls += 1;
    const url = typeof input === "string" ? input : input.toString();
    if (url === TRUST_LIST_URL) {
      const headers = new Headers();
      if (opts.cacheControl) {
        headers.set("cache-control", opts.cacheControl);
      }
      return new Response(opts.jws, { status: 200, headers });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch & { calls: number };
  fn.calls = 0;
  return fn;
}

describe("resolveAcceptedIssuers — inline DIDs (§8.1)", () => {
  it("passes through inline DIDs without fetching", async () => {
    const fetchMock = mockFetch({ jws: "unused" });
    const entries = await resolveAcceptedIssuers(["did:web:paypal.com", "did:key:zAbc"], {
      resolver: getDidResolver(),
      fetchImpl: fetchMock,
    });
    expect(entries).toEqual([{ did: "did:web:paypal.com" }, { did: "did:key:zAbc" }]);
    expect(fetchMock.calls).toBe(0);
  });
});

describe("resolveAcceptedIssuers — well-known JWS (§8.2)", () => {
  it("fetches, verifies, and parses a JWS-signed trust list", async () => {
    const jws = await buildTrustListJws({
      issuer: trustedIssuer.did,
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: "2027-01-01T00:00:00Z",
      issuers: [
        { did: trustedIssuer.did },
        {
          did: "did:web:paypal.com:divisions:cards",
          didDocumentHash:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        },
      ],
    });
    const fetchMock = mockFetch({ jws });
    const entries = await resolveAcceptedIssuers([TRUST_LIST_URL], {
      resolver: getDidResolver(),
      fetchImpl: fetchMock,
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ did: trustedIssuer.did });
    expect(entries[1].didDocumentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fetchMock.calls).toBe(1);
  });

  it("rejects when body.issuer does not match JWS iss", async () => {
    // Sign with trustedIssuer but claim a different `issuer` in the body.
    const jws = await buildTrustListJws({
      issuer: "did:web:attacker.test",
      issuers: [{ did: "did:web:attacker.test" }],
    });
    const fetchMock = mockFetch({ jws });
    await expect(
      resolveAcceptedIssuers([TRUST_LIST_URL], {
        resolver: getDidResolver(),
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow(/body\.issuer.*does not match JWS iss/);
  });

  it("rejects an expired trust list (validUntil in the past)", async () => {
    const jws = await buildTrustListJws({
      issuer: trustedIssuer.did,
      validFrom: "2025-01-01T00:00:00Z",
      validUntil: "2025-12-31T00:00:00Z",
      issuers: [{ did: trustedIssuer.did }],
    });
    const fetchMock = mockFetch({ jws });
    await expect(
      resolveAcceptedIssuers([TRUST_LIST_URL], {
        resolver: getDidResolver(),
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow(/validUntil.*has passed/);
  });

  it("rejects a malformed didDocumentHash format", async () => {
    const jws = await buildTrustListJws({
      issuer: trustedIssuer.did,
      issuers: [
        {
          did: trustedIssuer.did,
          didDocumentHash: "sha512:abc", // wrong algo tag
        },
      ],
    });
    const fetchMock = mockFetch({ jws });
    await expect(
      resolveAcceptedIssuers([TRUST_LIST_URL], {
        resolver: getDidResolver(),
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow(/didDocumentHash MUST be "sha256/);
  });

  it("honours the cache: same URL doesn't refetch on the second call", async () => {
    const jws = await buildTrustListJws({
      issuer: trustedIssuer.did,
      issuers: [{ did: trustedIssuer.did }],
    });
    const fetchMock = mockFetch({ jws, cacheControl: "max-age=3600" });
    const cache = new InMemoryTrustListCache();
    await resolveAcceptedIssuers([TRUST_LIST_URL], {
      resolver: getDidResolver(),
      fetchImpl: fetchMock,
      cache,
    });
    await resolveAcceptedIssuers([TRUST_LIST_URL], {
      resolver: getDidResolver(),
      fetchImpl: fetchMock,
      cache,
    });
    expect(fetchMock.calls).toBe(1);
  });
});

describe("resolveAcceptedIssuers — rejection paths", () => {
  it("rejects http:// URLs", async () => {
    await expect(
      resolveAcceptedIssuers(["http://insecure.test/.well-known/vcx-trust-list"], {
        resolver: getDidResolver(),
      }),
    ).rejects.toThrow(/MUST be HTTPS/);
  });

  it("returns the deferred-to-v1.1 error for ETSI URLs", async () => {
    await expect(
      resolveAcceptedIssuers(["https://example.test/etsi/trust-list.xml"], {
        resolver: getDidResolver(),
      }),
    ).rejects.toThrow(/ETSI.*deferred to v1\.1/);
  });

  it("rejects unrecognised reference shapes", async () => {
    await expect(
      resolveAcceptedIssuers(["mailto:trust@example.test"], {
        resolver: getDidResolver(),
      }),
    ).rejects.toThrow(/Unrecognised acceptedIssuers reference/);
  });
});

describe("verifyDidDocumentHash (§8.2)", () => {
  it("passes when the computed hash equals the expected hash (did:key)", async () => {
    const resolver = getDidResolver();
    const result = await resolver.resolve(trustedIssuer.did);
    const expectedHash = jcsSha256(result.didDocument);
    const check = await verifyDidDocumentHash({
      issuerDid: trustedIssuer.did,
      expectedHash,
      resolver,
    });
    expect(check.ok).toBe(true);
  });

  it("rejects when the computed hash differs from the expected hash", async () => {
    const resolver = getDidResolver();
    const check = await verifyDidDocumentHash({
      issuerDid: trustedIssuer.did,
      expectedHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      resolver,
    });
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toMatch(/mismatch/);
    }
  });
});
