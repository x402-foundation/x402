import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { paymentMiddleware } from "./index";
import {
  x402HTTPResourceServer,
  x402ResourceServer,
  type HTTPRequestContext,
} from "@x402/core/server";

type HookHandler = (...args: unknown[]) => Promise<unknown>;

/**
 * Captured hooks from a mock Fastify instance.
 */
interface CapturedHooks {
  onRequest: HookHandler[];
  onSend: HookHandler[];
}

/**
 * Creates a mock Fastify instance that captures registered hooks.
 *
 * @returns Object containing the mock app and captured hooks.
 */
function createMockApp(): { app: FastifyInstance; hooks: CapturedHooks } {
  const hooks: CapturedHooks = { onRequest: [], onSend: [] };

  const app = {
    addHook: vi.fn((name: string, handler: HookHandler) => {
      if (name === "onRequest") hooks.onRequest.push(handler);
      if (name === "onSend") hooks.onSend.push(handler);
    }),
    decorateRequest: vi.fn(),
  } as unknown as FastifyInstance;

  return { app, hooks };
}

/**
 * Creates a mock Fastify request for testing.
 *
 * @param options - Configuration options for the mock request.
 * @param options.url - The request URL path.
 * @param options.method - The HTTP method.
 * @param options.headers - Request headers.
 * @returns A mock Fastify request.
 */
function createMockRequest(
  options: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  } = {},
): FastifyRequest {
  return {
    url: options.url || "/api/test",
    method: options.method || "GET",
    headers: options.headers || {},
    query: {},
    body: undefined,
    protocol: "https",
    hostname: "example.com",
  } as unknown as FastifyRequest;
}

/**
 * Creates a mock Fastify reply for testing.
 *
 * @returns A mock Fastify reply with tracking properties.
 */
function createMockReply(): FastifyReply & {
  _status: number;
  _headers: Record<string, string>;
  _body: unknown;
  _type: string | undefined;
} {
  const reply = {
    _status: 200,
    _headers: {} as Record<string, string>,
    _body: undefined as unknown,
    _type: undefined as string | undefined,
    statusCode: 200,
    header: vi.fn(function (this: typeof reply, key: string, value: string) {
      this._headers[key] = value;
      return this;
    }),
    status: vi.fn(function (this: typeof reply, code: number) {
      this._status = code;
      this.statusCode = code;
      return this;
    }),
    type: vi.fn(function (this: typeof reply, contentType: string) {
      this._type = contentType;
      return this;
    }),
    send: vi.fn(function (this: typeof reply, body: unknown) {
      this._body = body;
      return this;
    }),
  };

  return reply as unknown as typeof reply;
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
    "does not skip payment check and returns 402 for %s",
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

      const { app, hooks } = createMockApp();
      paymentMiddleware(app, routes, server, undefined, undefined, false);

      const request = createMockRequest({ url: path });
      const reply = createMockReply();

      await hooks.onRequest[0](request, reply);

      expect(processSpy).toHaveBeenCalled();
      expect(processSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ path }));
      expect(reply._status).toBe(402);
    },
  );
});
