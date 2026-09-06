import { describe, it, expect, vi } from "vitest";
import { Request } from "express";
import { ExpressAdapter } from "./adapter";

/**
 * Factory for creating mock Express Request.
 *
 * @param options - Configuration options for the mock request.
 * @param options.path - The request URL path.
 * @param options.method - The HTTP method.
 * @param options.headers - Request headers.
 * @param options.query - Query parameters.
 * @param options.body - Request body.
 * @param options.protocol - Request protocol (default: "https").
 * @param options.host - Request host (default: "example.com").
 * @param options.originalUrl - Original URL including query string (defaults to path).
 * @returns A mock Express Request.
 */
function createMockRequest(
  options: {
    path?: string;
    originalUrl?: string;
    method?: string;
    headers?: Record<string, string>;
    query?: Record<string, string | string[]>;
    body?: unknown;
    protocol?: string;
    host?: string;
  } = {},
): Request {
  const headers = options.headers || {};
  const path = options.path || "/api/test";

  const mockRequest = {
    header: vi.fn((name: string) => headers[name]),
    method: options.method || "GET",
    path,
    originalUrl: options.originalUrl || path,
    protocol: options.protocol || "https",
    headers: {
      host: options.host || "example.com",
      ...headers,
    },
    query: options.query || {},
    body: options.body,
  } as unknown as Request;

  return mockRequest;
}

describe("ExpressAdapter", () => {
  describe("getHeader", () => {
    it("returns header value when present", () => {
      const req = createMockRequest({ headers: { "X-Payment": "test-payment" } });
      const adapter = new ExpressAdapter(req);
      expect(adapter.getHeader("X-Payment")).toBe("test-payment");
    });

    it("returns undefined for missing headers", () => {
      const req = createMockRequest();
      const adapter = new ExpressAdapter(req);
      expect(adapter.getHeader("X-Missing")).toBeUndefined();
    });

    it("returns first value when header is an array", () => {
      const mockReq = {
        header: vi.fn().mockReturnValue(["first", "second"]),
        method: "GET",
        path: "/api/test",
        protocol: "https",
        headers: { host: "example.com" },
        query: {},
      } as unknown as Request;
      const adapter = new ExpressAdapter(mockReq);
      expect(adapter.getHeader("X-Multi")).toBe("first");
    });
  });

  describe("getMethod", () => {
    it("returns the HTTP method", () => {
      const req = createMockRequest({ method: "POST" });
      const adapter = new ExpressAdapter(req);
      expect(adapter.getMethod()).toBe("POST");
    });
  });

  describe("getPath", () => {
    it("returns the pathname", () => {
      const req = createMockRequest({ path: "/api/weather" });
      const adapter = new ExpressAdapter(req);
      expect(adapter.getPath()).toBe("/api/weather");
    });
  });

  describe("getUrl", () => {
    it("returns the full URL", () => {
      const req = createMockRequest({
        path: "/api/test",
        protocol: "https",
        host: "example.com",
      });
      const adapter = new ExpressAdapter(req);
      expect(adapter.getUrl()).toBe("https://example.com/api/test");
    });

    it("returns the full URL including query parameters", () => {
      const req = createMockRequest({
        path: "/api/test",
        originalUrl: "/api/test?city=NYC&units=metric",
        protocol: "https",
        host: "example.com",
      });
      const adapter = new ExpressAdapter(req);
      expect(adapter.getUrl()).toBe("https://example.com/api/test?city=NYC&units=metric");
    });
  });

  describe("getAcceptHeader", () => {
    it("returns Accept header when present", () => {
      const req = createMockRequest({ headers: { Accept: "text/html" } });
      const adapter = new ExpressAdapter(req);
      expect(adapter.getAcceptHeader()).toBe("text/html");
    });

    it("returns empty string when missing", () => {
      const req = createMockRequest();
      const adapter = new ExpressAdapter(req);
      expect(adapter.getAcceptHeader()).toBe("");
    });
  });

  describe("getUserAgent", () => {
    it("returns User-Agent header when present", () => {
      const req = createMockRequest({ headers: { "User-Agent": "Mozilla/5.0" } });
      const adapter = new ExpressAdapter(req);
      expect(adapter.getUserAgent()).toBe("Mozilla/5.0");
    });

    it("returns empty string when missing", () => {
      const req = createMockRequest();
      const adapter = new ExpressAdapter(req);
      expect(adapter.getUserAgent()).toBe("");
    });
  });

  describe("getQueryParams", () => {
    it("returns all query parameters", () => {
      const req = createMockRequest({ query: { foo: "bar", baz: "qux" } });
      const adapter = new ExpressAdapter(req);
      expect(adapter.getQueryParams()).toEqual({ foo: "bar", baz: "qux" });
    });

    it("handles multiple values for same key", () => {
      const req = createMockRequest({ query: { tag: ["a", "b", "c"] } });
      const adapter = new ExpressAdapter(req);
      expect(adapter.getQueryParams()).toEqual({ tag: ["a", "b", "c"] });
    });

    it("returns empty object when no query params", () => {
      const req = createMockRequest({ query: {} });
      const adapter = new ExpressAdapter(req);
      expect(adapter.getQueryParams()).toEqual({});
    });
  });

  describe("getQueryParam", () => {
    it("returns single value for single param", () => {
      const req = createMockRequest({ query: { city: "NYC" } });
      const adapter = new ExpressAdapter(req);
      expect(adapter.getQueryParam("city")).toBe("NYC");
    });

    it("returns array for multiple values", () => {
      const req = createMockRequest({ query: { id: ["1", "2"] } });
      const adapter = new ExpressAdapter(req);
      expect(adapter.getQueryParam("id")).toEqual(["1", "2"]);
    });

    it("returns undefined for missing param", () => {
      const req = createMockRequest({ query: {} });
      const adapter = new ExpressAdapter(req);
      expect(adapter.getQueryParam("missing")).toBeUndefined();
    });
  });

  describe("getBody", () => {
    it("returns parsed body", () => {
      const body = { data: "test" };
      const req = createMockRequest({ body });
      const adapter = new ExpressAdapter(req);
      expect(adapter.getBody()).toEqual(body);
    });

    it("returns undefined when body is undefined", () => {
      const req = createMockRequest();
      const adapter = new ExpressAdapter(req);
      expect(adapter.getBody()).toBeUndefined();
    });
  });
});
