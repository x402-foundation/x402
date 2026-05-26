import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Context } from "hono";
import { paymentMiddleware } from "./index";
import {
  x402HTTPResourceServer,
  x402ResourceServer,
  type HTTPRequestContext,
} from "@x402/core/server";

/**
 * Creates a mock Hono context for testing
 *
 * @param options - Configuration options
 * @param options.path - Request path
 * @param options.method - HTTP method
 * @param options.headers - Request headers
 * @returns Mock context object
 */
function createMockContext(options: {
  path: string;
  method?: string;
  headers?: Record<string, string>;
}): Context & {
  _status: number;
  _headers: Record<string, string>;
  _body: unknown;
  _isHtml: boolean;
} {
  const headers = options.headers || {};
  const responseHeaders = new Map<string, string>();

  const context = {
    _status: 200,
    _headers: {} as Record<string, string>,
    _body: undefined as unknown,
    _isHtml: false,
    req: {
      path: options.path,
      method: options.method || "GET",
      header: vi.fn((name: string) => headers[name.toLowerCase()]),
    },
    res: undefined as Response | undefined,
    header: vi.fn((key: string, value: string) => {
      responseHeaders.set(key, value);
      context._headers[key] = value;
    }),
    html: vi.fn((body: string, status?: number) => {
      context._body = body;
      context._isHtml = true;
      if (status) context._status = status;
      const response = new Response(body, {
        status: status || context._status,
        headers: { "Content-Type": "text/html" },
      });
      context.res = response;
      return response;
    }),
    json: vi.fn((body: unknown, status?: number) => {
      context._body = body;
      context._isHtml = false;
      if (status) context._status = status;
      const response = new Response(JSON.stringify(body), {
        status: status || context._status,
        headers: { "Content-Type": "application/json" },
      });
      responseHeaders.forEach((value, key) => {
        response.headers.set(key, value);
      });
      context.res = response;
      return response;
    }),
  };

  return context as unknown as Context & typeof context;
}

describe("paymentMiddleware malformed path bypass", () => {
  let processSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    processSpy = vi
      .spyOn(x402HTTPResourceServer.prototype, "processHTTPRequest")
      .mockImplementation(async (context: HTTPRequestContext) => {
        return {
          type: "payment-error",
          response: {
            status: 402,
            body: { error: "Payment required", path: context.path },
            headers: {},
            isHtml: false,
          },
        };
      });
  });

  afterEach(() => {
    processSpy.mockRestore();
  });

  it.each(["/paywall/some-param%", "/paywall/some-param%c0"])(
    "does not call next() and returns 402 for %s",
    async path => {
      const routes = {
        "/paywall/*": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00",
            network: "eip155:8453",
          },
        },
      };

      const server = new x402ResourceServer();
      const middleware = paymentMiddleware(routes, server, undefined, undefined, false);

      const context = createMockContext({ path });
      const next = vi.fn().mockResolvedValue(undefined);

      await middleware(context, next);

      expect(next).not.toHaveBeenCalled();
      expect(processSpy).toHaveBeenCalled();
      expect(processSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ path }));
      expect(context._status).toBe(402);
    },
  );
});
