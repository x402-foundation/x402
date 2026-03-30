import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "hono";
import type {
  HTTPProcessResult,
  x402HTTPResourceServer,
  PaywallProvider,
  FacilitatorClient,
} from "@x402/core/server";
import {
  FacilitatorResponseError,
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
     * Creates a mock facilitator response error.
     *
     * @param message - Error message.
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

// --- Mock Factories ---
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
        response: { status: number; headers: Record<string, string>; body?: unknown };
      } = {
    success: true,
    headers: {},
  },
): void {
  mockProcessHTTPRequest.mockResolvedValue(processResult);
  mockProcessSettlement.mockResolvedValue(settlementResult);
}

/**
 * Creates a mock Hono Context for testing.
 *
 * @param options - Configuration options for the mock context.
 * @param options.path - The request URL path.
 * @param options.method - The HTTP method.
 * @param options.headers - Request headers.
 * @returns A mock Hono Context.
 */
function createMockContext(
  options: {
    path?: string;
    method?: string;
    headers?: Record<string, string>;
  } = {},
): Context & {
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
      path: options.path || "/api/test",
      method: options.method || "GET",
      header: vi.fn((name: string) => headers[name.toLowerCase()]),
    },
    res: undefined as Response | undefined,
    header: vi.fn((key: string, value: string) => {
      responseHeaders.set(key, value);
      context._headers[key] = value;
    }),
    status: vi.fn((code: number) => {
      context._status = code;
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
      // Copy response headers
      responseHeaders.forEach((value, key) => {
        response.headers.set(key, value);
      });
      context.res = response;
      return response;
    }),
  };

  return context as unknown as Context & typeof context;
}

// --- Tests ---
describe("paymentMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessHTTPRequest = vi.fn();
    mockProcessSettlement = vi.fn();
    mockRegisterPaywallProvider = vi.fn();
    mockRequiresPayment = vi.fn().mockReturnValue(true);

    // Reset the mock implementation
    vi.mocked(HTTPResourceServer).mockImplementation(
      (server, routes) =>
        ({
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

  it("calls next() when no-payment-required", async () => {
    setupMockHttpServer({ type: "no-payment-required" });

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const context = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context, next);

    expect(next).toHaveBeenCalled();
    expect(mockProcessHTTPRequest).toHaveBeenCalled();
  });

  it("returns 402 HTML for payment-error with isHtml", async () => {
    setupMockHttpServer({
      type: "payment-error",
      response: {
        status: 402,
        body: "<html>Paywall</html>",
        headers: {},
        isHtml: true,
      },
    });

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const context = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context, next);

    expect(next).not.toHaveBeenCalled();
    expect(context.html).toHaveBeenCalledWith("<html>Paywall</html>", 402);
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

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const context = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context, next);

    expect(next).not.toHaveBeenCalled();
    expect(context.json).toHaveBeenCalledWith({ error: "Payment required" }, 402);
  });

  it("sets custom headers from payment-error response", async () => {
    setupMockHttpServer({
      type: "payment-error",
      response: {
        status: 402,
        body: { error: "Payment required" },
        headers: { "X-Custom-Header": "custom-value" },
        isHtml: false,
      },
    });

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const context = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context, next);

    expect(context.header).toHaveBeenCalledWith("X-Custom-Header", "custom-value");
  });

  it("settles and returns response for payment-verified with successful handler", async () => {
    setupMockHttpServer(
      {
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
      },
      { success: true, headers: { "PAYMENT-RESPONSE": "settled" } },
    );

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const context = createMockContext();

    // Create a proper Response mock with headers and clone method
    const responseHeaders = new Headers();
    const mockResponse = {
      status: 200,
      headers: responseHeaders,
      clone: () => ({
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    } as unknown as Response;

    const next = vi.fn().mockImplementation(async () => {
      context.res = mockResponse;
    });

    await middleware(context, next);

    expect(next).toHaveBeenCalled();
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
    expect(responseHeaders.get("PAYMENT-RESPONSE")).toBe("settled");
  });

  it("skips settlement when handler returns >= 400", async () => {
    setupMockHttpServer(
      {
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
      },
      { success: true, headers: { "PAYMENT-RESPONSE": "settled" } },
    );

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const context = createMockContext();

    const next = vi.fn().mockImplementation(async () => {
      context.res = new Response("Error", { status: 500 });
    });

    await middleware(context, next);

    expect(next).toHaveBeenCalled();
    expect(mockProcessSettlement).not.toHaveBeenCalled();
  });

  it("returns 402 when settlement throws error", async () => {
    setupMockHttpServer({
      type: "payment-verified",
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
    });
    mockProcessSettlement.mockRejectedValue(new Error("Settlement rejected"));

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const context = createMockContext();

    const responseHeaders = new Headers();
    const next = vi.fn().mockImplementation(async () => {
      context.res = {
        status: 200,
        headers: responseHeaders,
        clone: () => ({
          arrayBuffer: async () => new ArrayBuffer(0),
        }),
      } as unknown as Response;
    });

    await middleware(context, next);

    expect(context.json).toHaveBeenCalledWith({}, 402);
  });

  it("retries initialization after a facilitator init failure", async () => {
    const initialize = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Failed to initialize: no supported payment kinds loaded from any facilitator.", {
          cause: new FacilitatorResponseError(
            "Facilitator supported returned invalid JSON: not-json",
          ),
        }),
      )
      .mockResolvedValueOnce(undefined);

    vi.mocked(HTTPResourceServer).mockImplementation(
      (server, routes) =>
        ({
          initialize,
          processHTTPRequest: mockProcessHTTPRequest,
          processSettlement: mockProcessSettlement,
          registerPaywallProvider: mockRegisterPaywallProvider,
          requiresPayment: mockRequiresPayment,
          routes,
          server: server || {
            hasExtension: vi.fn().mockReturnValue(false),
            registerExtension: vi.fn(),
          },
        }) as unknown as x402HTTPResourceServer,
    );
    mockProcessHTTPRequest.mockResolvedValue({ type: "no-payment-required" });

    const middleware = paymentMiddleware(mockRoutes, {} as unknown as x402ResourceServer);
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(createMockContext(), next);
    await middleware(createMockContext(), next);

    expect(initialize).toHaveBeenCalledTimes(2);
    expect(mockProcessHTTPRequest).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns 402 when settlement returns success: false", async () => {
    setupMockHttpServer(
      {
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
      },
      {
        success: false,
        errorReason: "Insufficient funds",
        headers: { "PAYMENT-RESPONSE": "settlement-failed-encoded" },
        response: {
          status: 402,
          headers: {
            "Content-Type": "application/json",
            "PAYMENT-RESPONSE": "settlement-failed-encoded",
          },
          body: {},
        },
      },
    );

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const context = createMockContext();

    const responseHeaders = new Headers();
    const next = vi.fn().mockImplementation(async () => {
      context.res = {
        status: 200,
        headers: responseHeaders,
        clone: () => ({
          arrayBuffer: async () => new ArrayBuffer(0),
        }),
      } as unknown as Response;
    });

    await middleware(context, next);

    expect(context.res?.status).toBe(402);
    expect(context.res?.headers.get("PAYMENT-RESPONSE")).toBe("settlement-failed-encoded");
    const body = await context.res?.json();
    expect(body).toEqual({});
  });

  it("passes paywallConfig to processHTTPRequest", async () => {
    setupMockHttpServer({ type: "no-payment-required" });
    const paywallConfig = { appName: "test-app" };

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      paywallConfig,
      undefined,
      false,
    );
    const context = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context, next);

    expect(mockProcessHTTPRequest).toHaveBeenCalledWith(expect.anything(), paywallConfig);
  });

  it("registers custom paywall provider", () => {
    setupMockHttpServer({ type: "no-payment-required" });
    const paywall: PaywallProvider = { generateHtml: vi.fn() };

    paymentMiddleware(mockRoutes, {} as unknown as x402ResourceServer, undefined, paywall, false);

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
    setupMockHttpServer({ type: "no-payment-required" });
    const facilitator = { verify: vi.fn(), settle: vi.fn() } as unknown as FacilitatorClient;

    paymentMiddlewareFromConfig(mockRoutes, facilitator);

    expect(x402ResourceServer).toHaveBeenCalledWith(facilitator);
  });

  it("registers scheme servers for each network", () => {
    setupMockHttpServer({ type: "no-payment-required" });
    const schemeServer = { verify: vi.fn(), settle: vi.fn() } as unknown as SchemeNetworkServer;
    const schemes: SchemeRegistration[] = [
      { network: "eip155:84532", server: schemeServer },
      { network: "eip155:8453", server: schemeServer },
    ];

    paymentMiddlewareFromConfig(mockRoutes, undefined, schemes);

    const serverInstance = vi.mocked(x402ResourceServer).mock.results[0].value;
    expect(serverInstance.register).toHaveBeenCalledTimes(2);
    expect(serverInstance.register).toHaveBeenCalledWith("eip155:84532", schemeServer);
    expect(serverInstance.register).toHaveBeenCalledWith("eip155:8453", schemeServer);
  });

  it("returns a working middleware function", async () => {
    setupMockHttpServer({ type: "no-payment-required" });

    const middleware = paymentMiddlewareFromConfig(mockRoutes);
    const context = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context, next);

    expect(next).toHaveBeenCalled();
  });
});

describe("HonoAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessHTTPRequest = vi.fn();
    mockProcessSettlement = vi.fn();
    mockRegisterPaywallProvider = vi.fn();
    mockRequiresPayment = vi.fn().mockReturnValue(true);

    vi.mocked(HTTPResourceServer).mockImplementation(
      (server, routes) =>
        ({
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

  it("extracts path and method from context", async () => {
    setupMockHttpServer({ type: "no-payment-required" });

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const context = createMockContext({ path: "/api/weather", method: "POST" });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context, next);

    expect(mockProcessHTTPRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/weather",
        method: "POST",
      }),
      undefined,
    );
  });

  it("extracts x-payment header", async () => {
    setupMockHttpServer({ type: "no-payment-required" });

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const context = createMockContext({ headers: { "x-payment": "payment-data" } });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context, next);

    expect(mockProcessHTTPRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentHeader: "payment-data",
      }),
      undefined,
    );
  });

  it("extracts payment-signature header (v2)", async () => {
    setupMockHttpServer({ type: "no-payment-required" });

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const context = createMockContext({ headers: { "payment-signature": "sig-data" } });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context, next);

    expect(mockProcessHTTPRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentHeader: "sig-data",
      }),
      undefined,
    );
  });

  it("prefers payment-signature over x-payment", async () => {
    setupMockHttpServer({ type: "no-payment-required" });

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const context = createMockContext({
      headers: { "payment-signature": "sig-data", "x-payment": "x-payment-data" },
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context, next);

    expect(mockProcessHTTPRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentHeader: "sig-data",
      }),
      undefined,
    );
  });

  it("returns undefined paymentHeader when no payment headers present", async () => {
    setupMockHttpServer({ type: "no-payment-required" });

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const context = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context, next);

    expect(mockProcessHTTPRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentHeader: undefined,
      }),
      undefined,
    );
  });
});
