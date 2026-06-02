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
import { buildHardenedWebResolver, didWebToUrl } from "../src/vcx";

// Stand-in for the `parsed` arg the did-resolver runtime passes; the
// hardened resolver doesn't read it, so an empty placeholder is enough.
const dummyParsed = {
  did: "",
  didUrl: "",
  method: "web",
  id: "",
} as unknown as Parameters<ReturnType<typeof buildHardenedWebResolver>>[1];

const dummyOptions = { accept: "application/did+json" };
const dummyResolver = {} as Parameters<ReturnType<typeof buildHardenedWebResolver>>[2];

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/did+json" },
    ...init,
  });
}

describe("didWebToUrl", () => {
  it("maps a domain-only did:web to /.well-known/did.json", () => {
    expect(didWebToUrl("did:web:example.com").toString()).toBe(
      "https://example.com/.well-known/did.json",
    );
  });

  it("maps a path-bearing did:web to /path/segments/did.json", () => {
    expect(
      didWebToUrl("did:web:example.com:users:alice").toString(),
    ).toBe("https://example.com/users/alice/did.json");
  });

  it("URL-decodes a port-bearing domain (%3A)", () => {
    expect(
      didWebToUrl("did:web:example.com%3A8443:users:alice").toString(),
    ).toBe("https://example.com:8443/users/alice/did.json");
  });

  it("rejects identifiers that don't start with did:web:", () => {
    expect(() => didWebToUrl("did:key:zAbc")).toThrow();
  });

  it("rejects an empty identifier", () => {
    expect(() => didWebToUrl("did:web:")).toThrow();
  });
});

describe("buildHardenedWebResolver — happy path", () => {
  it("returns the DID document on a 200 with matching id", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        id: "did:web:example.com",
        verificationMethod: [],
      })) as unknown as typeof fetch;
    const resolver = buildHardenedWebResolver({ fetchImpl });
    const result = await resolver(
      "did:web:example.com",
      dummyParsed,
      dummyResolver,
      dummyOptions,
    );
    expect(result.didResolutionMetadata.error).toBeUndefined();
    expect(result.didDocument?.id).toBe("did:web:example.com");
  });
});

describe("buildHardenedWebResolver — TLS / scheme hardening (§7.2)", () => {
  it("rejects a redirect to http://", async () => {
    let callCount = 0;
    const fetchImpl = (async (): Promise<Response> => {
      callCount += 1;
      return new Response("", {
        status: 301,
        headers: { location: "http://example.com/users/alice/did.json" },
      });
    }) as unknown as typeof fetch;
    const resolver = buildHardenedWebResolver({
      fetchImpl,
      maxSameHostRedirects: 1,
    });
    const result = await resolver(
      "did:web:example.com:users:alice",
      dummyParsed,
      dummyResolver,
      dummyOptions,
    );
    expect(result.didResolutionMetadata.error).toBe("notFound");
    expect(result.didResolutionMetadata.message ?? "").toMatch(
      /redirect refused: http/,
    );
    expect(callCount).toBe(1);
  });

  it("rejects a cross-host redirect", async () => {
    const fetchImpl = (async (): Promise<Response> => {
      return new Response("", {
        status: 302,
        headers: { location: "https://attacker.test/users/alice/did.json" },
      });
    }) as unknown as typeof fetch;
    const resolver = buildHardenedWebResolver({
      fetchImpl,
      maxSameHostRedirects: 5,
    });
    const result = await resolver(
      "did:web:example.com:users:alice",
      dummyParsed,
      dummyResolver,
      dummyOptions,
    );
    expect(result.didResolutionMetadata.error).toBe("notFound");
    expect(result.didResolutionMetadata.message ?? "").toMatch(
      /cross-host redirect refused/,
    );
  });

  it("follows a same-host redirect within the redirect budget", async () => {
    let call = 0;
    const fetchImpl = (async (url: RequestInfo | URL): Promise<Response> => {
      call += 1;
      const u = typeof url === "string" ? url : url.toString();
      if (call === 1) {
        // First request → 301 to same host, different path
        return new Response("", {
          status: 301,
          headers: { location: "/users/alice/did-v2.json" },
        });
      }
      if (u.endsWith("/users/alice/did-v2.json")) {
        return jsonResponse({ id: "did:web:example.com:users:alice" });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const resolver = buildHardenedWebResolver({
      fetchImpl,
      maxSameHostRedirects: 1,
    });
    const result = await resolver(
      "did:web:example.com:users:alice",
      dummyParsed,
      dummyResolver,
      dummyOptions,
    );
    expect(result.didResolutionMetadata.error).toBeUndefined();
    expect(result.didDocument?.id).toBe("did:web:example.com:users:alice");
    expect(call).toBe(2);
  });

  it("rejects when the redirect budget is exhausted", async () => {
    const fetchImpl = (async (): Promise<Response> => {
      return new Response("", {
        status: 301,
        headers: { location: "/again/did.json" },
      });
    }) as unknown as typeof fetch;
    const resolver = buildHardenedWebResolver({
      fetchImpl,
      maxSameHostRedirects: 2,
    });
    const result = await resolver(
      "did:web:example.com",
      dummyParsed,
      dummyResolver,
      dummyOptions,
    );
    expect(result.didResolutionMetadata.error).toBe("notFound");
    expect(result.didResolutionMetadata.message ?? "").toMatch(
      /maxSameHostRedirects/,
    );
  });

  it("rejects a 3xx with no Location header", async () => {
    const fetchImpl = (async () =>
      new Response("", { status: 301 })) as unknown as typeof fetch;
    const resolver = buildHardenedWebResolver({
      fetchImpl,
      maxSameHostRedirects: 1,
    });
    const result = await resolver(
      "did:web:example.com",
      dummyParsed,
      dummyResolver,
      dummyOptions,
    );
    expect(result.didResolutionMetadata.error).toBe("notFound");
    expect(result.didResolutionMetadata.message ?? "").toMatch(/no Location header/);
  });
});

describe("buildHardenedWebResolver — body validation", () => {
  it("rejects when the response is not 2xx", async () => {
    const fetchImpl = (async () =>
      new Response("server exploded", { status: 500 })) as unknown as typeof fetch;
    const resolver = buildHardenedWebResolver({ fetchImpl });
    const result = await resolver(
      "did:web:example.com",
      dummyParsed,
      dummyResolver,
      dummyOptions,
    );
    expect(result.didResolutionMetadata.error).toBe("notFound");
    expect(result.didResolutionMetadata.message ?? "").toMatch(/HTTP 500/);
  });

  it("rejects when the response body is not JSON", async () => {
    const fetchImpl = (async () =>
      new Response("<html></html>", { status: 200 })) as unknown as typeof fetch;
    const resolver = buildHardenedWebResolver({ fetchImpl });
    const result = await resolver(
      "did:web:example.com",
      dummyParsed,
      dummyResolver,
      dummyOptions,
    );
    expect(result.didResolutionMetadata.error).toBe("notFound");
    expect(result.didResolutionMetadata.message ?? "").toMatch(/not valid JSON/);
  });

  it("rejects when the document.id does not match the resolved DID", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ id: "did:web:other.com" })) as unknown as typeof fetch;
    const resolver = buildHardenedWebResolver({ fetchImpl });
    const result = await resolver(
      "did:web:example.com",
      dummyParsed,
      dummyResolver,
      dummyOptions,
    );
    expect(result.didResolutionMetadata.error).toBe("notFound");
    expect(result.didResolutionMetadata.message ?? "").toMatch(
      /document\.id.*does not match/,
    );
  });
});
