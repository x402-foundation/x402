import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { NextAdapter } from "./adapter";

/**
 * Factory for creating mock NextRequest.
 *
 * @param options - Configuration options for the mock request.
 * @param options.url - The request URL.
 * @param options.method - The HTTP method.
 * @param options.headers - Request headers.
 * @returns A mock NextRequest.
 */
function createMockRequest(
  options: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  } = {},
): NextRequest {
  const url = options.url || "https://example.com/api/test";
  const req = new NextRequest(url, {
    method: options.method || "GET",
    headers: options.headers,
  });
  return req;
}

describe("NextAdapter", () => {
  describe("getHeader", () => {
    it("returns header value when present", () => {
      const req = createMockRequest({ headers: { "X-Payment": "test-payment" } });
      const adapter = new NextAdapter(req);
      expect(adapter.getHeader("X-Payment")).toBe("test-payment");
    });

    it("returns undefined for missing headers", () => {
      const req = createMockRequest();
      const adapter = new NextAdapter(req);
      expect(adapter.getHeader("X-Missing")).toBeUndefined();
    });
  });

  describe("getMethod", () => {
    it("returns the HTTP method", () => {
      const req = createMockRequest({ method: "POST" });
      const adapter = new NextAdapter(req);
      expect(adapter.getMethod()).toBe("POST");
    });
  });

  describe("getPath", () => {
    it("returns the pathname", () => {
      const req = createMockRequest({ url: "https://example.com/api/weather?city=NYC" });
      const adapter = new NextAdapter(req);
      expect(adapter.getPath()).toBe("/api/weather");
    });
  });

  describe("getUrl", () => {
    it("returns the full URL", () => {
      const req = createMockRequest({ url: "https://example.com/api/test?foo=bar" });
      const adapter = new NextAdapter(req);
      expect(adapter.getUrl()).toBe("https://example.com/api/test?foo=bar");
    });
  });

  describe("getAcceptHeader", () => {
    it("returns Accept header when present", () => {
      const req = createMockRequest({ headers: { Accept: "text/html" } });
      const adapter = new NextAdapter(req);
      expect(adapter.getAcceptHeader()).toBe("text/html");
    });

    it("returns empty string when missing", () => {
      const req = createMockRequest();
      const adapter = new NextAdapter(req);
      expect(adapter.getAcceptHeader()).toBe("");
    });
  });

  describe("getUserAgent", () => {
    it("returns User-Agent header when present", () => {
      const req = createMockRequest({ headers: { "User-Agent": "Mozilla/5.0" } });
      const adapter = new NextAdapter(req);
      expect(adapter.getUserAgent()).toBe("Mozilla/5.0");
    });

    it("returns empty string when missing", () => {
      const req = createMockRequest();
      const adapter = new NextAdapter(req);
      expect(adapter.getUserAgent()).toBe("");
    });
  });

  describe("getQueryParams", () => {
    it("returns all query parameters", () => {
      const req = createMockRequest({ url: "https://example.com/api?foo=bar&baz=qux" });
      const adapter = new NextAdapter(req);
      expect(adapter.getQueryParams()).toEqual({ foo: "bar", baz: "qux" });
    });

    it("handles multiple values for same key", () => {
      const req = createMockRequest({ url: "https://example.com/api?tag=a&tag=b&tag=c" });
      const adapter = new NextAdapter(req);
      expect(adapter.getQueryParams()).toEqual({ tag: ["a", "b", "c"] });
    });

    it("returns empty object when no query params", () => {
      const req = createMockRequest({ url: "https://example.com/api" });
      const adapter = new NextAdapter(req);
      expect(adapter.getQueryParams()).toEqual({});
    });
  });

  describe("getQueryParam", () => {
    it("returns single value for single param", () => {
      const req = createMockRequest({ url: "https://example.com/api?city=NYC" });
      const adapter = new NextAdapter(req);
      expect(adapter.getQueryParam("city")).toBe("NYC");
    });

    it("returns array for multiple values", () => {
      const req = createMockRequest({ url: "https://example.com/api?id=1&id=2" });
      const adapter = new NextAdapter(req);
      expect(adapter.getQueryParam("id")).toEqual(["1", "2"]);
    });

    it("returns undefined for missing param", () => {
      const req = createMockRequest({ url: "https://example.com/api" });
      const adapter = new NextAdapter(req);
      expect(adapter.getQueryParam("missing")).toBeUndefined();
    });
  });

  describe("getBody", () => {
    it("returns parsed JSON body", async () => {
      const body = { data: "test" };
      const req = new NextRequest("https://example.com/api", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      const adapter = new NextAdapter(req);
      expect(await adapter.getBody()).toEqual(body);
    });

    it("returns undefined when body parsing fails", async () => {
      const req = new NextRequest("https://example.com/api", { method: "GET" });
      const adapter = new NextAdapter(req);
      expect(await adapter.getBody()).toBeUndefined();
    });
  });
});
