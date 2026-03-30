import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type {
  HTTPProcessResult,
  x402HTTPResourceServer,
  PaywallProvider,
  FacilitatorClient,
} from "@x402/core/server";
import {
  x402ResourceServer,
  x402HTTPResourceServer as HTTPResourceServer,
} from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkServer } from "@x402/core/types";
import { paymentMiddleware, paymentMiddlewareFromConfig, type SchemeRegistration } from "./index";

// --- Test Fixtures ---
const mockRoutes = {
  "/api/*": {
    accepts: { scheme: "exact", payTo: "0x123", price: "$0.01", network: "eip155:84532" },
  },
} as const;

const mockPaymentPayload = {
  scheme: "exact",
  network: "eip155:84532",
  payload: { signature: "0xabc" },
} as unknown as PaymentPayload;

const mockPaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  maxAmountRequired: "1000",
  payTo: "0x123",
} as unknown as PaymentRequirements;

// --- Mock setup ---
let mockProcessHTTPRequest: ReturnType<typeof vi.fn>;
let mockProcessSettlement: ReturnType<typeof vi.fn>;
let mockRegisterPaywallProvider: ReturnType<typeof vi.fn>;
let mockRequiresPayment: ReturnType<typeof vi.fn>;

vi.mock("@x402/core/server", () => ({
  SETTLEMENT_OVERRIDES_HEADER: "Settlement-Overrides",
  FacilitatorResponseError: class FacilitatorResponseError extends Error {
    /**
     * Mock error class matching @x402/core/server FacilitatorResponseError.
     *
     * @param message - Error message passed to the superclass.
     */
    constructor(message: string) {
      super(message);
      this.name = "FacilitatorResponseError";
    }
  },
  getFacilitatorResponseError: (error: unknown) => {
    let current = error;
    while (current instanceof Error) {
      if (current.name === "FacilitatorResponseError") {
        return current;
      }
      current = (current as Error & { cause?: unknown }).cause;
    }
    return null;
  },
  x402ResourceServer: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    registerExtension: vi.fn(),
    register: vi.fn(),
    hasExtension: vi.fn().mockReturnValue(false),
  })),
  x402HTTPResourceServer: vi.fn().mockImplementation((server, routes) => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    processHTTPRequest: mockProcessHTTPRequest,
    processSettlement: mockProcessSettlement,
    registerPaywallProvider: mockRegisterPaywallProvider,
    requiresPayment: mockRequiresPayment,
    routes: routes,
    server: server || {
      hasExtension: vi.fn().mockReturnValue(false),
      registerExtension: vi.fn(),
    },
  })),
}));

// --- Hook Capture ---
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
 * Sets up the mock HTTP server to return specified results.
 *
 * @param processResult - The result to return from processHTTPRequest.
 * @param settlementResult - Result to return from processSettlement.
 */
function setupMockHttpServer(
  processResult: HTTPProcessResult,
  settlementResult:
    | { success: true; headers: Record<string, string> }
    | {
        success: false;
        errorReason: string;
        headers: Record<string, string>;
        response: {
          status: number;
          headers: Record<string, string>;
          body?: unknown;
          isHtml?: boolean;
        };
      } = {
    success: true,
    headers: {},
  },
): void {
  mockProcessHTTPRequest.mockResolvedValue(processResult);
  mockProcessSettlement.mockResolvedValue(settlementResult);
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
    raw: {
      write: vi.fn(),
      end: vi.fn(),
      writeHead: vi.fn(),
      flushHeaders: vi.fn(),
    },
    getHeaders: vi.fn(function (this: typeof reply) {
      return this._headers;
    }),
    getHeader: vi.fn(function (this: typeof reply, key: string) {
      return this._headers[key];
    }),
    removeHeader: vi.fn(function (this: typeof reply, key: string) {
      delete this._headers[key];
      return this;
    }),
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

// --- Tests ---
describe("paymentMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessHTTPRequest = vi.fn();
    mockProcessSettlement = vi.fn();
    mockRegisterPaywallProvider = vi.fn();
    mockRequiresPayment = vi.fn().mockReturnValue(true);

    vi.mocked(HTTPResourceServer).mockImplementation(
      (server, routes) =>
        ({
          initialize: vi.fn().mockResolvedValue(undefined),
          processHTTPRequest: mockProcessHTTPRequest,
          processSettlement: mockProcessSettlement,
          registerPaywallProvider: mockRegisterPaywallProvider,
          requiresPayment: mockRequiresPayment,
          routes: routes,
          server: server || {
            hasExtension: vi.fn().mockReturnValue(false),
            registerExtension: vi.fn(),
          },
        }) as unknown as x402HTTPResourceServer,
    );
  });

  it("registers onRequest and onSend hooks", () => {
    const { app } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    expect(app.addHook).toHaveBeenCalledWith("onRequest", expect.any(Function));
    expect(app.addHook).toHaveBeenCalledWith("onSend", expect.any(Function));
  });

  it("proceeds when no-payment-required", async () => {
    setupMockHttpServer({ type: "no-payment-required" });

    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const request = createMockRequest();
    const reply = createMockReply();
    await hooks.onRequest[0](request, reply);

    expect(mockProcessHTTPRequest).toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it("skips payment check for non-protected routes", async () => {
    mockRequiresPayment.mockReturnValue(false);

    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const request = createMockRequest({ url: "/health" });
    const reply = createMockReply();
    await hooks.onRequest[0](request, reply);

    expect(mockProcessHTTPRequest).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it("returns 402 HTML for payment-error with isHtml", async () => {
    setupMockHttpServer({
      type: "payment-error",
      response: {
        status: 402,
        body: "<html>Paywall</html>",
        headers: { "PAYMENT-REQUIRED": "encoded-data" },
        isHtml: true,
      },
    });

    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const request = createMockRequest();
    const reply = createMockReply();
    await hooks.onRequest[0](request, reply);

    expect(reply.status).toHaveBeenCalledWith(402);
    expect(reply.type).toHaveBeenCalledWith("text/html");
    expect(reply.send).toHaveBeenCalledWith("<html>Paywall</html>");
    expect(reply.header).toHaveBeenCalledWith("PAYMENT-REQUIRED", "encoded-data");
  });

  it("returns 402 JSON for payment-error", async () => {
    setupMockHttpServer({
      type: "payment-error",
      response: {
        status: 402,
        body: { error: "Payment required" },
        headers: {},
        isHtml: false,
      },
    });

    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const request = createMockRequest();
    const reply = createMockReply();
    await hooks.onRequest[0](request, reply);

    expect(reply.status).toHaveBeenCalledWith(402);
    expect(reply.send).toHaveBeenCalledWith({ error: "Payment required" });
  });

  it("stashes payment context on request for payment-verified", async () => {
    setupMockHttpServer({
      type: "payment-verified",
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
    });

    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const request = createMockRequest();
    const reply = createMockReply();
    await hooks.onRequest[0](request, reply);

    expect(reply.send).not.toHaveBeenCalled();
    expect(request.x402Context).toBeDefined();
    expect(request.x402RawGuard).toBeDefined();
  });

  it("settles payment and adds headers in onSend for verified payments", async () => {
    setupMockHttpServer(
      {
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
      },
      { success: true, headers: { "PAYMENT-RESPONSE": "settled" } },
    );

    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const request = createMockRequest();
    const reply = createMockReply();

    // Step 1: onRequest stashes payment context
    await hooks.onRequest[0](request, reply);

    // Step 2: onSend settles payment
    const payload = JSON.stringify({ data: "premium content" });
    const result = await hooks.onSend[0](request, reply, payload);

    expect(mockProcessSettlement).toHaveBeenCalledWith(
      mockPaymentPayload,
      mockPaymentRequirements,
      undefined,
      expect.objectContaining({
        request: expect.objectContaining({
          path: "/api/test",
          method: "GET",
        }),
        responseBody: expect.any(Buffer),
      }),
    );
    expect(reply.header).toHaveBeenCalledWith("PAYMENT-RESPONSE", "settled");
    expect(result).toBe(payload);
  });

  it("passes Buffer payload bytes to settlement without JSON stringifying them", async () => {
    setupMockHttpServer(
      {
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
      },
      { success: true, headers: { "PAYMENT-RESPONSE": "settled" } },
    );

    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const request = createMockRequest();
    const reply = createMockReply();
    const payload = Buffer.from([0, 1, 2, 255]);

    await hooks.onRequest[0](request, reply);
    const result = await hooks.onSend[0](request, reply, payload);

    expect(result).toBe(payload);
    expect(mockProcessSettlement).toHaveBeenCalledTimes(1);
    expect(
      (mockProcessSettlement.mock.calls[0]?.[3] as { responseBody?: Buffer }).responseBody,
    ).toEqual(payload);
  });

  it("skips settlement for non-payment requests in onSend", async () => {
    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const request = createMockRequest();
    const reply = createMockReply();
    const payload = JSON.stringify({ data: "free content" });

    const result = await hooks.onSend[0](request, reply, payload);

    expect(mockProcessSettlement).not.toHaveBeenCalled();
    expect(result).toBe(payload);
  });

  it("skips settlement when handler returns >= 400", async () => {
    setupMockHttpServer(
      {
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
      },
      { success: true, headers: {} },
    );

    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const request = createMockRequest();
    const reply = createMockReply();

    await hooks.onRequest[0](request, reply);

    reply.statusCode = 500;
    const payload = JSON.stringify({ error: "Server error" });
    const result = await hooks.onSend[0](request, reply, payload);

    expect(mockProcessSettlement).not.toHaveBeenCalled();
    expect(result).toBe(payload);
  });

  it("returns 402 when settlement fails", async () => {
    setupMockHttpServer(
      {
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
      },
      {
        success: false,
        errorReason: "Insufficient funds",
        headers: {},
        response: {
          status: 402,
          headers: {
            "PAYMENT-RESPONSE": "failed",
            "Content-Type": "application/json",
          },
          body: { error: "Settlement failed" },
        },
      },
    );

    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const request = createMockRequest();
    const reply = createMockReply();

    await hooks.onRequest[0](request, reply);

    reply.type("application/octet-stream");
    const payload = JSON.stringify({ data: "premium content" });
    const result = await hooks.onSend[0](request, reply, payload);

    expect(reply.status).toHaveBeenCalledWith(402);
    expect(reply.header).toHaveBeenCalledWith("PAYMENT-RESPONSE", "failed");
    expect(reply.type).toHaveBeenCalledWith("application/json");
    expect(result).toBe(JSON.stringify({ error: "Settlement failed" }));
  });

  it("returns 402 when settlement throws error", async () => {
    setupMockHttpServer({
      type: "payment-verified",
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
    });
    mockProcessSettlement.mockRejectedValue(new Error("Settlement rejected"));

    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const request = createMockRequest();
    const reply = createMockReply();

    await hooks.onRequest[0](request, reply);

    const payload = JSON.stringify({ data: "premium content" });
    const result = await hooks.onSend[0](request, reply, payload);

    expect(reply.status).toHaveBeenCalledWith(402);
    expect(reply.type).toHaveBeenCalledWith("application/json");
    expect(result).toBe(JSON.stringify({}));
  });

  it("passes paywallConfig to processHTTPRequest", async () => {
    setupMockHttpServer({ type: "no-payment-required" });
    const paywallConfig = { appName: "test-app" };

    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      paywallConfig,
      undefined,
      false,
    );

    const request = createMockRequest();
    const reply = createMockReply();
    await hooks.onRequest[0](request, reply);

    expect(mockProcessHTTPRequest).toHaveBeenCalledWith(expect.anything(), paywallConfig);
  });

  it("registers custom paywall provider", () => {
    const { app } = createMockApp();
    const paywall: PaywallProvider = { generateHtml: vi.fn() };

    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      paywall,
      false,
    );

    expect(mockRegisterPaywallProvider).toHaveBeenCalledWith(paywall);
  });
});

describe("paymentMiddlewareFromConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessHTTPRequest = vi.fn();
    mockProcessSettlement = vi.fn();
    mockRegisterPaywallProvider = vi.fn();
    mockRequiresPayment = vi.fn().mockReturnValue(true);

    vi.mocked(HTTPResourceServer).mockImplementation(
      (server, routes) =>
        ({
          initialize: vi.fn().mockResolvedValue(undefined),
          processHTTPRequest: mockProcessHTTPRequest,
          processSettlement: mockProcessSettlement,
          registerPaywallProvider: mockRegisterPaywallProvider,
          requiresPayment: mockRequiresPayment,
          routes: routes,
          server: server || {
            hasExtension: vi.fn().mockReturnValue(false),
            registerExtension: vi.fn(),
          },
        }) as unknown as x402HTTPResourceServer,
    );

    vi.mocked(x402ResourceServer).mockImplementation(
      () =>
        ({
          initialize: vi.fn().mockResolvedValue(undefined),
          registerExtension: vi.fn(),
          register: vi.fn(),
        }) as unknown as x402ResourceServer,
    );
  });

  it("creates x402ResourceServer with facilitator clients", () => {
    const { app } = createMockApp();
    const facilitator = { verify: vi.fn(), settle: vi.fn() } as unknown as FacilitatorClient;

    paymentMiddlewareFromConfig(app, mockRoutes, facilitator);

    expect(x402ResourceServer).toHaveBeenCalledWith(facilitator);
  });

  it("registers scheme servers for each network", () => {
    const { app } = createMockApp();
    const schemeServer = { verify: vi.fn(), settle: vi.fn() } as unknown as SchemeNetworkServer;
    const schemes: SchemeRegistration[] = [
      { network: "eip155:84532", server: schemeServer },
      { network: "eip155:8453", server: schemeServer },
    ];

    paymentMiddlewareFromConfig(app, mockRoutes, undefined, schemes);

    const serverInstance = vi.mocked(x402ResourceServer).mock.results[0].value;
    expect(serverInstance.register).toHaveBeenCalledTimes(2);
    expect(serverInstance.register).toHaveBeenCalledWith("eip155:84532", schemeServer);
    expect(serverInstance.register).toHaveBeenCalledWith("eip155:8453", schemeServer);
  });

  it("registers hooks on the Fastify instance", () => {
    const { app } = createMockApp();
    paymentMiddlewareFromConfig(app, mockRoutes);

    expect(app.addHook).toHaveBeenCalledWith("onRequest", expect.any(Function));
    expect(app.addHook).toHaveBeenCalledWith("onSend", expect.any(Function));
  });
});

describe("FastifyAdapter integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessHTTPRequest = vi.fn();
    mockProcessSettlement = vi.fn();
    mockRegisterPaywallProvider = vi.fn();
    mockRequiresPayment = vi.fn().mockReturnValue(true);

    vi.mocked(HTTPResourceServer).mockImplementation(
      (server, routes) =>
        ({
          initialize: vi.fn().mockResolvedValue(undefined),
          processHTTPRequest: mockProcessHTTPRequest,
          processSettlement: mockProcessSettlement,
          registerPaywallProvider: mockRegisterPaywallProvider,
          requiresPayment: mockRequiresPayment,
          routes: routes,
          server: server || {
            hasExtension: vi.fn().mockReturnValue(false),
            registerExtension: vi.fn(),
          },
        }) as unknown as x402HTTPResourceServer,
    );
  });

  it("extracts path and method from request", async () => {
    setupMockHttpServer({ type: "no-payment-required" });

    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const request = createMockRequest({ url: "/api/weather", method: "POST" });
    const reply = createMockReply();
    await hooks.onRequest[0](request, reply);

    expect(mockProcessHTTPRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/weather",
        method: "POST",
      }),
      undefined,
    );
  });

  it("strips query string from path", async () => {
    setupMockHttpServer({ type: "no-payment-required" });

    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const request = createMockRequest({ url: "/api/weather?city=NYC" });
    const reply = createMockReply();
    await hooks.onRequest[0](request, reply);

    expect(mockProcessHTTPRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/weather",
      }),
      undefined,
    );
  });

  it("extracts payment-signature header", async () => {
    setupMockHttpServer({ type: "no-payment-required" });

    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const request = createMockRequest({ headers: { "payment-signature": "sig-data" } });
    const reply = createMockReply();
    await hooks.onRequest[0](request, reply);

    expect(mockProcessHTTPRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentHeader: "sig-data",
      }),
      undefined,
    );
  });

  it("extracts x-payment header", async () => {
    setupMockHttpServer({ type: "no-payment-required" });

    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const request = createMockRequest({ headers: { "x-payment": "payment-data" } });
    const reply = createMockReply();
    await hooks.onRequest[0](request, reply);

    expect(mockProcessHTTPRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentHeader: "payment-data",
      }),
      undefined,
    );
  });

  it("prefers payment-signature over x-payment", async () => {
    setupMockHttpServer({ type: "no-payment-required" });

    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const request = createMockRequest({
      headers: { "payment-signature": "sig-data", "x-payment": "x-payment-data" },
    });
    const reply = createMockReply();
    await hooks.onRequest[0](request, reply);

    expect(mockProcessHTTPRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentHeader: "sig-data",
      }),
      undefined,
    );
  });

  it("returns undefined paymentHeader when no payment headers present", async () => {
    setupMockHttpServer({ type: "no-payment-required" });

    const { app, hooks } = createMockApp();
    paymentMiddleware(
      app,
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const request = createMockRequest();
    const reply = createMockReply();
    await hooks.onRequest[0](request, reply);

    expect(mockProcessHTTPRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentHeader: undefined,
      }),
      undefined,
    );
  });
});
