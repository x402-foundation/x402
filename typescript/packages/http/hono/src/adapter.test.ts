import { describe, it, expect, vi } from "vitest";
import { Context } from "hono";
import { HonoAdapter } from "./adapter";

/**
 * Factory for creating mock Hono Context.
 *
 * @param options - Configuration options for the mock context.
 * @param options.url - The request URL.
 * @param options.method - The HTTP method.
 * @param options.headers - Request headers.
 * @param options.query - Query parameters.
 * @param options.body - Request body.
 * @returns A mock Hono Context.
 */
function createMockContext(
  options: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
  } = {},
): Context {
  const url = new URL(options.url || "https://example.com/api/test");
  const headers = options.headers || {};
  const query = options.query || {};

  const mockContext = {
    req: {
      header: vi.fn((name: string) => headers[name]),
      method: options.method || "GET",
      path: url.pathname,
      url: url.toString(),
      query: vi.fn((name?: string) => {
        if (name === undefined) {
          return query;
        }
        return query[name];
      }),
      json: vi.fn().mockResolvedValue(options.body),
    },
  } as unknown as Context;

  return mockContext;
}

describe("HonoAdapter", () => {
  describe("getHeader", () => {
    it("returns header value when present", () => {
      const c = createMockContext({ headers: { "X-Payment": "test-payment" } });
      const adapter = new HonoAdapter(c);
      expect(adapter.getHeader("X-Payment")).toBe("test-payment");
    });

    it("returns undefined for missing headers", () => {
      const c = createMockContext();
      const adapter = new HonoAdapter(c);
      expect(adapter.getHeader("X-Missing")).toBeUndefined();
    });
  });

  describe("getMethod", () => {
    it("returns the HTTP method", () => {
      const c = createMockContext({ method: "POST" });
      const adapter = new HonoAdapter(c);
      expect(adapter.getMethod()).toBe("POST");
    });
  });

  describe("getPath", () => {
    it("returns the pathname", () => {
      const c = createMockContext({ url: "https://example.com/api/weather?city=NYC" });
      const adapter = new HonoAdapter(c);
      expect(adapter.getPath()).toBe("/api/weather");
    });
  });

  describe("getUrl", () => {
    it("returns the full URL", () => {
      const c = createMockContext({ url: "https://example.com/api/test?foo=bar" });
      const adapter = new HonoAdapter(c);
      expect(adapter.getUrl()).toBe("https://example.com/api/test?foo=bar");
    });
  });

  describe("getAcceptHeader", () => {
    it("returns Accept header when present", () => {
      const c = createMockContext({ headers: { Accept: "text/html" } });
      const adapter = new HonoAdapter(c);
      expect(adapter.getAcceptHeader()).toBe("text/html");
    });

    it("returns empty string when missing", () => {
      const c = createMockContext();
      const adapter = new HonoAdapter(c);
      expect(adapter.getAcceptHeader()).toBe("");
    });
  });

  describe("getUserAgent", () => {
    it("returns User-Agent header when present", () => {
      const c = createMockContext({ headers: { "User-Agent": "Mozilla/5.0" } });
      const adapter = new HonoAdapter(c);
      expect(adapter.getUserAgent()).toBe("Mozilla/5.0");
    });

    it("returns empty string when missing", () => {
      const c = createMockContext();
      const adapter = new HonoAdapter(c);
      expect(adapter.getUserAgent()).toBe("");
    });
  });

  describe("getQueryParams", () => {
    it("returns all query parameters", () => {
      const c = createMockContext({ query: { foo: "bar", baz: "qux" } });
      const adapter = new HonoAdapter(c);
      expect(adapter.getQueryParams()).toEqual({ foo: "bar", baz: "qux" });
    });

    it("returns empty object when no query params", () => {
      const c = createMockContext({ query: {} });
      const adapter = new HonoAdapter(c);
      expect(adapter.getQueryParams()).toEqual({});
    });
  });

  describe("getQueryParam", () => {
    it("returns single value for single param", () => {
      const c = createMockContext({ query: { city: "NYC" } });
      const adapter = new HonoAdapter(c);
      expect(adapter.getQueryParam("city")).toBe("NYC");
    });

    it("returns undefined for missing param", () => {
      const c = createMockContext({ query: {} });
      const adapter = new HonoAdapter(c);
      expect(adapter.getQueryParam("missing")).toBeUndefined();
    });
  });

  describe("getBody", () => {
    it("returns parsed JSON body", async () => {
      const body = { data: "test" };
      const c = createMockContext({ body });
      const adapter = new HonoAdapter(c);
      expect(await adapter.getBody()).toEqual(body);
    });

    it("returns undefined when body parsing fails", async () => {
      const mockContext = {
        req: {
          json: vi.fn().mockRejectedValue(new Error("Invalid JSON")),
        },
      } as unknown as Context;
      const adapter = new HonoAdapter(mockContext);
      expect(await adapter.getBody()).toBeUndefined();
    });
  });
});
