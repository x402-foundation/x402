import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type {
  CompletedSettlement,
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
let mockCreateCompletedSettlementHeaders: ReturnType<typeof vi.fn>;
let mockCreateFailurePathSettlementHeaders: ReturnType<typeof vi.fn>;
let mockRegisterPaywallProvider: ReturnType<typeof vi.fn>;
let mockRequiresPayment: ReturnType<typeof vi.fn>;

type PaymentVerifiedResult = Extract<HTTPProcessResult, { type: "payment-verified" }>;
type MockHTTPProcessResult =
  | Exclude<HTTPProcessResult, PaymentVerifiedResult>
  | (Omit<PaymentVerifiedResult, "cancellationDispatcher"> & {
      cancellationDispatcher?: PaymentVerifiedResult["cancellationDispatcher"];
    });

/**
 * Creates a mock payment cancellation dispatcher.
 *
 * @returns Mock payment cancellation dispatcher.
 */
function createMockPaymentCancellationDispatcher(): PaymentVerifiedResult["cancellationDispatcher"] {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
  } as unknown as PaymentVerifiedResult["cancellationDispatcher"];
}

vi.mock("@x402/core/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@x402/core/server")>();
  return {
    ...actual,
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
      createCompletedSettlementHeaders: mockCreateCompletedSettlementHeaders,
      createFailurePathSettlementHeaders: mockCreateFailurePathSettlementHeaders,
      registerPaywallProvider: mockRegisterPaywallProvider,
      requiresPayment: mockRequiresPayment,
      routes: routes,
      server: server || {
        hasExtension: vi.fn().mockReturnValue(false),
        registerExtension: vi.fn(),
      },
    })),
    checkIfBazaarNeeded: vi.fn().mockReturnValue(false),
  };
});

// --- Mock Factories ---
/**
 * Sets up the mock HTTP server to return specified results.
 *
 * @param processResult - The result to return from processHTTPRequest.
 * @param settlementResult - Result to return from processSettlement.
 */
function setupMockHttpServer(
  processResult: MockHTTPProcessResult,
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
  const normalizedResult =
    processResult.type === "payment-verified"
      ? {
          ...processResult,
          cancellationDispatcher:
            processResult.cancellationDispatcher ?? createMockPaymentCancellationDispatcher(),
        }
      : processResult;
  mockProcessHTTPRequest.mockResolvedValue(normalizedResult);
  mockProcessSettlement.mockResolvedValue(settlementResult);
}

/**
 * Creates a Hono app with the payment middleware mounted on /api/*.
 *
 * @param handler - Handler for GET /api/test.
 * @returns The app.
 */
function createPaidApp(handler: Parameters<Hono["get"]>[1]): Hono {
  const app = new Hono();
  app.use(
    "/api/*",
    paymentMiddleware(mockRoutes, {} as unknown as x402ResourceServer, undefined, undefined, false),
  );
  app.get("/api/test", handler);
  return app;
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
    mockCreateCompletedSettlementHeaders = vi.fn((_settlement, existingCacheControl) => ({
      "PAYMENT-RESPONSE": "before-handler-receipt",
      "Cache-Control": existingCacheControl ? `${existingCacheControl}, private` : "private",
    }));
    mockCreateFailurePathSettlementHeaders = vi.fn((cancelSettlement, settlement) => {
      if (cancelSettlement) {
        return {
          "PAYMENT-RESPONSE": cancelSettlement.success
            ? "cancel-receipt"
            : "cancel-failure-receipt",
          "Cache-Control": "private",
        };
      }
      if (settlement) {
        return mockCreateCompletedSettlementHeaders(settlement, null);
      }
      return undefined;
    });
    mockRegisterPaywallProvider = vi.fn();
    mockRequiresPayment = vi.fn().mockReturnValue(true);

    // Reset the mock implementation
    vi.mocked(HTTPResourceServer).mockImplementation(
      (server, routes) =>
        ({
          processHTTPRequest: mockProcessHTTPRequest,
          processSettlement: mockProcessSettlement,
          createCompletedSettlementHeaders: mockCreateCompletedSettlementHeaders,
          createFailurePathSettlementHeaders: mockCreateFailurePathSettlementHeaders,
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
      undefined,
      undefined,
    );
    expect(context.res?.headers.get("PAYMENT-RESPONSE")).toBe("settled");
  });

  it("sends the handler response to the client after settlement succeeds", async () => {
    setupMockHttpServer({
      type: "payment-verified",
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
    });
    // Settlement against a real facilitator takes seconds; what was buffered
    // before it started must still reach the client once it resolves.
    mockProcessSettlement.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { success: true, headers: { "PAYMENT-RESPONSE": "settled" } };
    });

    const app = createPaidApp(
      () =>
        new Response('{"ok":true}', {
          status: 200,
          statusText: "Totally Fine",
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-length": "11",
            "x-custom": "kept",
          },
        }),
    );

    const res = await app.request("/api/test");

    expect(res.status).toBe(200);
    expect(res.statusText).toBe("Totally Fine");
    expect(res.headers.get("PAYMENT-RESPONSE")).toBe("settled");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("content-length")).toBe("11");
    expect(res.headers.get("x-custom")).toBe("kept");
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(await res.text()).toBe('{"ok":true}');
  });

  it("keeps a null-body status intact after settlement succeeds", async () => {
    setupMockHttpServer(
      {
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
      },
      { success: true, headers: { "PAYMENT-RESPONSE": "settled" } },
    );

    const app = createPaidApp(c => c.body(null, 204));

    const res = await app.request("/api/test");

    expect(res.status).toBe(204);
    expect(res.headers.get("PAYMENT-RESPONSE")).toBe("settled");
  });

  it("keeps multiple Set-Cookie headers separate through the rebuild", async () => {
    setupMockHttpServer(
      {
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
      },
      { success: true, headers: { "PAYMENT-RESPONSE": "settled" } },
    );

    const app = createPaidApp(() => {
      // Carrying headers into the rebuilt response must not collapse these into one.
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response('{"ok":true}', { status: 200, headers });
    });

    const res = await app.request("/api/test");

    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(res.headers.get("PAYMENT-RESPONSE")).toBe("settled");
  });

  it("does not turn an unreconstructable response into a 402 after settling", async () => {
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

    // A status outside 200-599 makes `new Response()` throw whatever the body is.
    // Undici cannot build one, but workerd can (a 101 upgrade carries a webSocket),
    // so the middleware has to survive receiving it. The payment is already settled
    // onchain at this point, so a 402 here would charge and withhold.
    const responseHeaders = new Headers();
    responseHeaders.set("Settlement-Overrides", JSON.stringify({ amount: "32%" }));
    const upgradeResponse = {
      status: 101,
      headers: responseHeaders,
      clone: () => ({
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    } as unknown as Response;

    const next = vi.fn().mockImplementation(async () => {
      context.res = upgradeResponse;
    });

    await middleware(context, next);

    expect(context.json).not.toHaveBeenCalledWith({}, 402);
    expect(context.res).toBe(upgradeResponse);
    expect(context.res?.status).toBe(101);
    expect(context.res?.headers.get("PAYMENT-RESPONSE")).toBe("settled");
    expect(context.res?.headers.has("Settlement-Overrides")).toBe(false);
  });

  it("strips settlement override header from client response", async () => {
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

    const responseHeaders = new Headers();
    responseHeaders.set("Settlement-Overrides", JSON.stringify({ amount: "32%" }));
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

    expect(context.res?.headers.has("Settlement-Overrides")).toBe(false);
    expect(context.res?.headers.get("PAYMENT-RESPONSE")).toBe("settled");
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

    const responseHeaders = new Headers();
    responseHeaders.set("Settlement-Overrides", JSON.stringify({ amount: "32%" }));
    const next = vi.fn().mockImplementation(async () => {
      context.res = new Response("Error", { status: 500, headers: responseHeaders });
    });

    await middleware(context, next);

    expect(next).toHaveBeenCalled();
    expect(mockProcessSettlement).not.toHaveBeenCalled();
    expect(mockCreateCompletedSettlementHeaders).not.toHaveBeenCalled();
    expect(context.res?.headers.has("Settlement-Overrides")).toBe(false);
  });

  it("echoes before-handler PAYMENT-RESPONSE when handler returns >= 400", async () => {
    const beforeHandlerSettlement = {
      phase: "before-handler" as const,
      flow: "upfront" as const,
      result: {
        success: true,
        transaction: "0xdeposit",
        network: "eip155:84532" as const,
      },
      requirements: mockPaymentRequirements,
    };
    setupMockHttpServer(
      {
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
        beforeHandlerSettlement,
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

    expect(mockProcessSettlement).not.toHaveBeenCalled();
    expect(mockCreateFailurePathSettlementHeaders).toHaveBeenCalledWith(
      undefined,
      beforeHandlerSettlement,
      mockPaymentPayload,
      null,
    );
    expect(context.res?.headers.get("PAYMENT-RESPONSE")).toBe("before-handler-receipt");
    expect(context.res?.headers.get("Cache-Control")).toBe("private");
  });

  it("prefers cancel refund receipt over deposit echo when handler fails", async () => {
    const cancel = vi.fn().mockResolvedValue({
      success: true,
      amount: "0",
      transaction: "0xrefund",
      network: "eip155:84532",
    });
    const beforeHandlerSettlement = {
      phase: "before-handler" as const,
      flow: "escrow" as const,
      result: {
        success: true,
        transaction: "0xdeposit",
        network: "eip155:84532" as const,
      },
      requirements: mockPaymentRequirements,
    };
    setupMockHttpServer({
      type: "payment-verified",
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
      cancellationDispatcher: { cancel } as PaymentVerifiedResult["cancellationDispatcher"],
      beforeHandlerSettlement,
    });

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

    expect(context.res?.headers.get("PAYMENT-RESPONSE")).toBe("cancel-receipt");
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
          createCompletedSettlementHeaders: mockCreateCompletedSettlementHeaders,
          createFailurePathSettlementHeaders: mockCreateFailurePathSettlementHeaders,
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

  it("does not surface an eager initialization failure as an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      // Hand-rolled instead of vi.fn(): the spy instruments promise results to
      // record settlements, which attaches a rejection handler and would mask
      // the unhandled rejection this test exists to detect.
      let initializeCalls = 0;
      const initialize = (): Promise<void> => {
        initializeCalls += 1;
        return initializeCalls === 1
          ? Promise.reject(new Error("facilitator request timed out"))
          : Promise.resolve(undefined);
      };
      vi.mocked(HTTPResourceServer).mockImplementation(
        (server, routes) =>
          ({
            initialize,
            processHTTPRequest: mockProcessHTTPRequest,
            processSettlement: mockProcessSettlement,
            createCompletedSettlementHeaders: mockCreateCompletedSettlementHeaders,
            createFailurePathSettlementHeaders: mockCreateFailurePathSettlementHeaders,
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
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(unhandled).toHaveLength(0);

      const firstResult = await middleware(createMockContext(), vi.fn());
      expect(firstResult).toBeInstanceOf(Response);
      expect((firstResult as Response).status).toBe(500);
      await expect((firstResult as Response).json()).resolves.toEqual({
        error: "Internal Server Error",
      });
      expect(mockProcessHTTPRequest).not.toHaveBeenCalled();

      await middleware(createMockContext(), vi.fn().mockResolvedValue(undefined));
      expect(initializeCalls).toBe(2);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
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
          createCompletedSettlementHeaders: mockCreateCompletedSettlementHeaders,
          createFailurePathSettlementHeaders: mockCreateFailurePathSettlementHeaders,
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
          createCompletedSettlementHeaders: mockCreateCompletedSettlementHeaders,
          createFailurePathSettlementHeaders: mockCreateFailurePathSettlementHeaders,
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

/**
 * Real Hono app.fetch probes: whether the middleware's `handler_threw` catch or
 * its `status >= 400` branch runs is decided by Hono's `compose`.
 */
describe("before-handler receipt survives a failing handler", () => {
  const RECEIPT_HEADER = "PAYMENT-RESPONSE";
  const BEFORE_HANDLER_RECEIPT = "before-handler-receipt";
  const AFTER_HANDLER_RECEIPT = "after-handler-receipt";

  const upfrontSettlement: CompletedSettlement = {
    phase: "before-handler",
    flow: "upfront",
    result: { success: true, transaction: "0xdeposit", network: "eip155:84532" },
    requirements: mockPaymentRequirements,
  };

  let beforeHandlerSettlement: CompletedSettlement | undefined;
  let cancel: ReturnType<typeof vi.fn>;
  let app: Hono;

  beforeEach(() => {
    beforeHandlerSettlement = upfrontSettlement;
    cancel = vi.fn().mockResolvedValue(undefined);
    mockProcessSettlement = vi.fn().mockResolvedValue({
      success: true,
      headers: { "PAYMENT-RESPONSE": AFTER_HANDLER_RECEIPT },
    });
    mockCreateCompletedSettlementHeaders = vi.fn(
      (_settlement: CompletedSettlement, existingCacheControl?: string | null) => ({
        "PAYMENT-RESPONSE": BEFORE_HANDLER_RECEIPT,
        "Cache-Control": existingCacheControl ? `${existingCacheControl}, private` : "private",
      }),
    );
    mockProcessHTTPRequest = vi.fn(async () => ({
      type: "payment-verified" as const,
      cancellationDispatcher: { cancel },
      beforeHandlerSettlement,
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
    }));
    mockRegisterPaywallProvider = vi.fn();
    mockRequiresPayment = vi.fn().mockReturnValue(true);

    vi.mocked(HTTPResourceServer).mockImplementation(
      (server, routes) =>
        ({
          initialize: vi.fn().mockResolvedValue(undefined),
          processHTTPRequest: mockProcessHTTPRequest,
          processSettlement: mockProcessSettlement,
          createCompletedSettlementHeaders: mockCreateCompletedSettlementHeaders,
          createFailurePathSettlementHeaders: mockCreateFailurePathSettlementHeaders,
          registerPaywallProvider: mockRegisterPaywallProvider,
          requiresPayment: mockRequiresPayment,
          routes,
          server: server || {
            hasExtension: vi.fn().mockReturnValue(false),
            registerExtension: vi.fn(),
          },
        }) as unknown as x402HTTPResourceServer,
    );

    app = new Hono();
    app.use(
      "*",
      paymentMiddleware(
        mockRoutes,
        {} as unknown as x402ResourceServer,
        undefined,
        undefined,
        false,
      ),
    );
    app.get("/api/throw-error", () => {
      throw new Error("handler exploded");
    });
    app.get("/api/throw-http-exception", () => {
      throw new HTTPException(503, { message: "upstream unavailable" });
    });
    app.get("/api/throw-non-error", () => {
      throw "handler exploded";
    });
    app.get("/api/status-503", c => c.json({ error: "upstream unavailable" }, 503));
    app.get("/api/ok", c => c.json({ data: "protected" }));
  });

  it("echoes the receipt when the handler throws an Error", async () => {
    const response = await app.fetch(new Request("http://localhost/api/throw-error"));

    expect(response.status).toBe(500);
    expect(response.headers.get(RECEIPT_HEADER)).toBe(BEFORE_HANDLER_RECEIPT);
    expect(mockProcessSettlement).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith({ reason: "handler_failed", responseStatus: 500 });
  });

  it("echoes the receipt when the handler throws an HTTPException", async () => {
    const response = await app.fetch(new Request("http://localhost/api/throw-http-exception"));

    expect(response.status).toBe(503);
    expect(response.headers.get(RECEIPT_HEADER)).toBe(BEFORE_HANDLER_RECEIPT);
    expect(mockProcessSettlement).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith({ reason: "handler_failed", responseStatus: 503 });
  });

  it("echoes the receipt when the handler returns a 5xx", async () => {
    const response = await app.fetch(new Request("http://localhost/api/status-503"));

    expect(response.status).toBe(503);
    expect(response.headers.get(RECEIPT_HEADER)).toBe(BEFORE_HANDLER_RECEIPT);
    expect(mockProcessSettlement).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith({ reason: "handler_failed", responseStatus: 503 });
  });

  it("settles after the handler when it succeeds", async () => {
    const response = await app.fetch(new Request("http://localhost/api/ok"));

    expect(response.status).toBe(200);
    expect(response.headers.get(RECEIPT_HEADER)).toBe(AFTER_HANDLER_RECEIPT);
    expect(mockProcessSettlement).toHaveBeenCalledTimes(1);
  });

  it("adds no receipt for a flow that has not settled before the handler", async () => {
    beforeHandlerSettlement = undefined;

    const response = await app.fetch(new Request("http://localhost/api/throw-error"));

    expect(response.status).toBe(500);
    expect(response.headers.get(RECEIPT_HEADER)).toBeNull();
    expect(mockCreateCompletedSettlementHeaders).not.toHaveBeenCalled();
  });

  it("echoes the receipt when the handler throws a non-Error", async () => {
    const response = await app.fetch(new Request("http://localhost/api/throw-non-error"));

    expect(response.status).toBe(500);
    expect(response.headers.get(RECEIPT_HEADER)).toBe(BEFORE_HANDLER_RECEIPT);
    expect(mockProcessSettlement).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith({
      reason: "handler_threw",
      error: "handler exploded",
    });
  });
});
