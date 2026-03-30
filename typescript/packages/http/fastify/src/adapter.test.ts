import { describe, it, expect } from "vitest";
import { FastifyRequest } from "fastify";
import { FastifyAdapter } from "./adapter";

/**
 * Factory for creating mock Fastify requests.
 *
 * @param options - Configuration options for the mock request.
 * @param options.url - The request URL path with optional query string.
 * @param options.method - The HTTP method.
 * @param options.headers - Request headers.
 * @param options.query - Query parameters.
 * @param options.body - Request body.
 * @param options.protocol - The request protocol.
 * @param options.hostname - The request hostname.
 * @param options.host - The request host header, including port if present.
 * @returns A mock Fastify request.
 */
function createMockRequest(
  options: {
    url?: string;
    method?: string;
    headers?: Record<string, string | string[]>;
    query?: Record<string, string | string[]>;
    body?: unknown;
    protocol?: string;
    hostname?: string;
    host?: string;
  } = {},
): FastifyRequest {
  return {
    url: options.url || "/api/test",
    method: options.method || "GET",
    headers: options.headers || {},
    query: options.query || {},
    body: options.body,
    protocol: options.protocol || "https",
    hostname: options.hostname || "example.com",
    host: options.host || options.hostname || "example.com",
  } as unknown as FastifyRequest;
}

describe("FastifyAdapter", () => {
  describe("getHeader", () => {
    it("returns header value when present", () => {
      const req = createMockRequest({ headers: { "x-payment": "test-payment" } });
      const adapter = new FastifyAdapter(req);
      expect(adapter.getHeader("X-Payment")).toBe("test-payment");
    });

    it("returns first value for array headers", () => {
      const req = createMockRequest({ headers: { "x-payment": ["first", "second"] } });
      const adapter = new FastifyAdapter(req);
      expect(adapter.getHeader("X-Payment")).toBe("first");
    });

    it("returns undefined for missing headers", () => {
      const req = createMockRequest();
      const adapter = new FastifyAdapter(req);
      expect(adapter.getHeader("X-Missing")).toBeUndefined();
    });
  });

  describe("getMethod", () => {
    it("returns the HTTP method", () => {
      const req = createMockRequest({ method: "POST" });
      const adapter = new FastifyAdapter(req);
      expect(adapter.getMethod()).toBe("POST");
    });
  });

  describe("getPath", () => {
    it("returns the pathname without query string", () => {
      const req = createMockRequest({ url: "/api/weather?city=NYC" });
      const adapter = new FastifyAdapter(req);
      expect(adapter.getPath()).toBe("/api/weather");
    });

    it("returns the pathname when no query string", () => {
      const req = createMockRequest({ url: "/api/test" });
      const adapter = new FastifyAdapter(req);
      expect(adapter.getPath()).toBe("/api/test");
    });
  });

  describe("getUrl", () => {
    it("returns the full URL", () => {
      const req = createMockRequest({
        url: "/api/test?foo=bar",
        protocol: "https",
        hostname: "example.com",
        host: "example.com:3000",
      });
      const adapter = new FastifyAdapter(req);
      expect(adapter.getUrl()).toBe("https://example.com:3000/api/test?foo=bar");
    });
  });

  describe("getAcceptHeader", () => {
    it("returns Accept header when present", () => {
      const req = createMockRequest({ headers: { accept: "text/html" } });
      const adapter = new FastifyAdapter(req);
      expect(adapter.getAcceptHeader()).toBe("text/html");
    });

    it("returns empty string when missing", () => {
      const req = createMockRequest();
      const adapter = new FastifyAdapter(req);
      expect(adapter.getAcceptHeader()).toBe("");
    });
  });

  describe("getUserAgent", () => {
    it("returns User-Agent header when present", () => {
      const req = createMockRequest({ headers: { "user-agent": "Mozilla/5.0" } });
      const adapter = new FastifyAdapter(req);
      expect(adapter.getUserAgent()).toBe("Mozilla/5.0");
    });

    it("returns empty string when missing", () => {
      const req = createMockRequest();
      const adapter = new FastifyAdapter(req);
      expect(adapter.getUserAgent()).toBe("");
    });
  });

  describe("getQueryParams", () => {
    it("returns all query parameters", () => {
      const req = createMockRequest({ query: { foo: "bar", baz: "qux" } });
      const adapter = new FastifyAdapter(req);
      expect(adapter.getQueryParams()).toEqual({ foo: "bar", baz: "qux" });
    });

    it("returns empty object when no query params", () => {
      const req = createMockRequest({ query: {} });
      const adapter = new FastifyAdapter(req);
      expect(adapter.getQueryParams()).toEqual({});
    });
  });

  describe("getQueryParam", () => {
    it("returns single value for single param", () => {
      const req = createMockRequest({ query: { city: "NYC" } });
      const adapter = new FastifyAdapter(req);
      expect(adapter.getQueryParam("city")).toBe("NYC");
    });

    it("returns undefined for missing param", () => {
      const req = createMockRequest({ query: {} });
      const adapter = new FastifyAdapter(req);
      expect(adapter.getQueryParam("missing")).toBeUndefined();
    });
  });

  describe("getBody", () => {
    it("returns parsed body", () => {
      const body = { data: "test" };
      const req = createMockRequest({ body });
      const adapter = new FastifyAdapter(req);
      expect(adapter.getBody()).toEqual(body);
    });

    it("returns undefined when no body", () => {
      const req = createMockRequest();
      const adapter = new FastifyAdapter(req);
      expect(adapter.getBody()).toBeUndefined();
    });
  });
});
