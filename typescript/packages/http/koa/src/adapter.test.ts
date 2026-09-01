import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Koa from "koa";
import type { Context } from "koa";
import mount from "koa-mount";
import bodyparser from "koa-bodyparser";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { KoaAdapter } from "./adapter";

/**
 * Factory for creating mock Koa Context.
 *
 * @param options - Configuration options for the mock context.
 * @param options.path - The request path.
 * @param options.originalUrl - The original URL (defaults to path).
 * @param options.method - The HTTP method.
 * @param options.headers - Request headers.
 * @param options.query - Query parameters.
 * @param options.body - Request body.
 * @param options.protocol - Request protocol (default: "https").
 * @param options.host - Request host (default: "example.com").
 * @returns A mock Koa Context.
 */
function createMockContext(
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
): Context {
  const path = options.path || "/api/test";
  const headers = options.headers || {};
  const query = options.query || {};
  const protocol = options.protocol || "https";
  const host = options.host || "example.com";

  const mockContext = {
    get: vi.fn((name: string) => headers[name]),
    set: vi.fn(),
    method: options.method || "GET",
    path,
    originalUrl: options.originalUrl || path,
    origin: `${protocol}://${host}`,
    query,
    request: {
      body: options.body,
    },
  } as unknown as Context;

  return mockContext;
}

describe("KoaAdapter", () => {
  describe("getHeader", () => {
    it("returns header value when present", () => {
      const ctx = createMockContext({ headers: { "X-Payment": "test-payment" } });
      const adapter = new KoaAdapter(ctx);
      expect(adapter.getHeader("X-Payment")).toBe("test-payment");
    });

    it("returns undefined for missing headers", () => {
      const ctx = createMockContext();
      const adapter = new KoaAdapter(ctx);
      expect(adapter.getHeader("X-Missing")).toBeUndefined();
    });

    it("reads REQUEST headers only, not response headers", async () => {
      // End-to-end test: verify getHeader does not see headers set via ctx.set()
      const app = new Koa();
      let requestHeaderValue: string | undefined;
      let responseHeaderVisible: string | undefined;

      app.use(async ctx => {
        // Set a response header
        ctx.set("X-Response-Only", "response-value");

        const adapter = new KoaAdapter(ctx);
        // Read the request header (should be present)
        requestHeaderValue = adapter.getHeader("X-Request-Header");
        // Try to read the response header via adapter (should NOT be visible)
        responseHeaderVisible = adapter.getHeader("X-Response-Only");

        ctx.status = 200;
        ctx.body = "ok";
      });

      const server = http.createServer(app.callback());
      server.listen(0);
      await new Promise<void>(resolve => server.once("listening", () => resolve()));
      const port = (server.address() as AddressInfo).port;

      await fetch(`http://localhost:${port}/test`, {
        headers: { "X-Request-Header": "request-value" },
      });

      expect(requestHeaderValue).toBe("request-value");
      expect(responseHeaderVisible).toBeUndefined();

      server.close();
    });
  });

  describe("getMethod", () => {
    it("returns the HTTP method", () => {
      const ctx = createMockContext({ method: "POST" });
      const adapter = new KoaAdapter(ctx);
      expect(adapter.getMethod()).toBe("POST");
    });
  });

  describe("getPath", () => {
    it("returns the pathname", () => {
      const ctx = createMockContext({ path: "/api/weather" });
      const adapter = new KoaAdapter(ctx);
      expect(adapter.getPath()).toBe("/api/weather");
    });
  });

  describe("getUrl", () => {
    it("returns the full URL", () => {
      const ctx = createMockContext({
        path: "/api/test",
        protocol: "https",
        host: "example.com",
      });
      const adapter = new KoaAdapter(ctx);
      expect(adapter.getUrl()).toBe("https://example.com/api/test");
    });

    it("returns the full URL including query parameters", () => {
      const ctx = createMockContext({
        path: "/api/test",
        originalUrl: "/api/test?city=NYC&units=metric",
        protocol: "https",
        host: "example.com",
      });
      const adapter = new KoaAdapter(ctx);
      expect(adapter.getUrl()).toBe("https://example.com/api/test?city=NYC&units=metric");
    });
  });

  describe("getPath vs getUrl under koa-mount (D2 contract)", () => {
    it("getPath() returns mount-relative path; getUrl() returns origin + originalUrl", async () => {
      let capturedPath: string | undefined;
      let capturedUrl: string | undefined;

      const subApp = new Koa();
      subApp.use(async ctx => {
        const adapter = new KoaAdapter(ctx);
        capturedPath = adapter.getPath();
        capturedUrl = adapter.getUrl();
        ctx.status = 200;
        ctx.body = "ok";
      });

      const mainApp = new Koa();
      mainApp.use(mount("/v1", subApp));

      const server = http.createServer(mainApp.callback());
      server.listen(0);
      await new Promise<void>(resolve => server.once("listening", () => resolve()));
      const port = (server.address() as AddressInfo).port;

      await fetch(`http://localhost:${port}/v1/api/resource?foo=bar`);

      // getPath() returns mount-relative (without /v1 prefix)
      expect(capturedPath).toBe("/api/resource");
      // getUrl() returns full external URL (with /v1 prefix)
      expect(capturedUrl).toContain("/v1/api/resource?foo=bar");
      // They must differ
      expect(capturedPath).not.toBe(capturedUrl);

      server.close();
    });
  });

  describe("getAcceptHeader", () => {
    it("returns Accept header when present", () => {
      const ctx = createMockContext({ headers: { Accept: "text/html" } });
      const adapter = new KoaAdapter(ctx);
      expect(adapter.getAcceptHeader()).toBe("text/html");
    });

    it("returns empty string when missing", () => {
      const ctx = createMockContext();
      const adapter = new KoaAdapter(ctx);
      expect(adapter.getAcceptHeader()).toBe("");
    });
  });

  describe("getUserAgent", () => {
    it("returns User-Agent header when present", () => {
      const ctx = createMockContext({ headers: { "User-Agent": "Mozilla/5.0" } });
      const adapter = new KoaAdapter(ctx);
      expect(adapter.getUserAgent()).toBe("Mozilla/5.0");
    });

    it("returns empty string when missing", () => {
      const ctx = createMockContext();
      const adapter = new KoaAdapter(ctx);
      expect(adapter.getUserAgent()).toBe("");
    });
  });

  describe("getQueryParams", () => {
    it("returns all query parameters", () => {
      const ctx = createMockContext({ query: { foo: "bar", baz: "qux" } });
      const adapter = new KoaAdapter(ctx);
      expect(adapter.getQueryParams()).toEqual({ foo: "bar", baz: "qux" });
    });

    it("returns array for repeated key (?a=1&a=2)", async () => {
      // End-to-end test with actual Koa query parsing
      let capturedParams: Record<string, string | string[]> | undefined;

      const app = new Koa();
      app.use(async ctx => {
        const adapter = new KoaAdapter(ctx);
        capturedParams = adapter.getQueryParams();
        ctx.status = 200;
        ctx.body = "ok";
      });

      const server = http.createServer(app.callback());
      server.listen(0);
      await new Promise<void>(resolve => server.once("listening", () => resolve()));
      const port = (server.address() as AddressInfo).port;

      await fetch(`http://localhost:${port}/test?a=1&a=2&b=single`);

      // Repeated key should be an array
      expect(capturedParams!.a).toEqual(["1", "2"]);
      // Single key should be a string
      expect(capturedParams!.b).toBe("single");

      server.close();
    });

    it("returns empty object when no query params", () => {
      const ctx = createMockContext({ query: {} });
      const adapter = new KoaAdapter(ctx);
      expect(adapter.getQueryParams()).toEqual({});
    });
  });

  describe("getQueryParam", () => {
    it("returns single value for single param", () => {
      const ctx = createMockContext({ query: { city: "NYC" } });
      const adapter = new KoaAdapter(ctx);
      expect(adapter.getQueryParam("city")).toBe("NYC");
    });

    it("returns array for multiple values", () => {
      const ctx = createMockContext({ query: { id: ["1", "2"] } });
      const adapter = new KoaAdapter(ctx);
      expect(adapter.getQueryParam("id")).toEqual(["1", "2"]);
    });

    it("returns undefined for missing param", () => {
      const ctx = createMockContext({ query: {} });
      const adapter = new KoaAdapter(ctx);
      expect(adapter.getQueryParam("missing")).toBeUndefined();
    });
  });

  describe("getBody", () => {
    it("returns parsed body when present", () => {
      const body = { data: "test" };
      const ctx = createMockContext({ body });
      const adapter = new KoaAdapter(ctx);
      expect(adapter.getBody()).toEqual(body);
    });

    it("returns undefined when body is undefined", () => {
      const ctx = createMockContext();
      const adapter = new KoaAdapter(ctx);
      expect(adapter.getBody()).toBeUndefined();
    });

    it("returns undefined on bare Koa app with no body parser", async () => {
      let capturedBody: unknown;

      const app = new Koa();
      // NO body parser middleware
      app.use(async ctx => {
        const adapter = new KoaAdapter(ctx);
        capturedBody = adapter.getBody();
        ctx.status = 200;
        ctx.body = "ok";
      });

      const server = http.createServer(app.callback());
      server.listen(0);
      await new Promise<void>(resolve => server.once("listening", () => resolve()));
      const port = (server.address() as AddressInfo).port;

      await fetch(`http://localhost:${port}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ foo: "bar" }),
      });

      expect(capturedBody).toBeUndefined();

      server.close();
    });

    it("returns parsed body when koa-bodyparser is present", async () => {
      let capturedBody: unknown;

      const app = new Koa();
      app.use(bodyparser());
      app.use(async ctx => {
        const adapter = new KoaAdapter(ctx);
        capturedBody = adapter.getBody();
        ctx.status = 200;
        ctx.body = "ok";
      });

      const server = http.createServer(app.callback());
      server.listen(0);
      await new Promise<void>(resolve => server.once("listening", () => resolve()));
      const port = (server.address() as AddressInfo).port;

      await fetch(`http://localhost:${port}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ foo: "bar" }),
      });

      expect(capturedBody).toEqual({ foo: "bar" });

      server.close();
    });
  });
});

describe("Encoded path handling", () => {
  // Verifies that Koa's ctx.path preserves percent-encoded separators.
  // Express req.path produces identical values (verified separately in @x402/express).
  // See NOTES.md for the cross-framework comparison.

  let server: http.Server;
  let port: number;
  let capturedPath: string | undefined;

  beforeAll(async () => {
    const app = new Koa();
    app.use(async ctx => {
      capturedPath = ctx.path;
      ctx.status = 200;
      ctx.body = "ok";
    });
    server = http.createServer(app.callback());
    server.listen(0);
    await new Promise<void>(resolve => server.once("listening", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  /**
   * Send raw request with path verbatim (no fetch normalization).
   *
   * @param rawPath - The raw HTTP path to request.
   */
  async function sendRawRequest(rawPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: "GET", path: rawPath }, res => {
        res.resume();
        res.on("end", () => resolve());
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("ctx.path preserves %2F (encoded forward slash)", async () => {
    capturedPath = undefined;
    await sendRawRequest("/api%2Ftest");
    expect(capturedPath).toBe("/api%2Ftest");
  });

  it("ctx.path preserves %2f (lowercase encoded forward slash)", async () => {
    capturedPath = undefined;
    await sendRawRequest("/api%2ftest");
    expect(capturedPath).toBe("/api%2ftest");
  });

  it("ctx.path preserves %5C (encoded backslash)", async () => {
    capturedPath = undefined;
    await sendRawRequest("/api%5Ctest");
    expect(capturedPath).toBe("/api%5Ctest");
  });
});
