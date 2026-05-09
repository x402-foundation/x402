import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { HTTPProcessResult, PaywallProvider, FacilitatorClient } from "@x402/core/server";
import { x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkServer } from "@x402/core/types";
import { paymentProxy, paymentProxyFromConfig, withX402, type SchemeRegistration } from "./index";

import { createHttpServer } from "./utils";

// Mock utils
vi.mock("./utils", async () => {
  const actual = await vi.importActual("./utils");
  return {
    ...actual,
    createHttpServer: vi.fn(),
  };
});

// Shared mock functions storage - will be populated by tests
const mockFunctions = {
  processHTTPRequest: vi.fn(),
  processSettlement: vi.fn(),
  requiresPayment: vi.fn().mockReturnValue(true),
};

// Mock @x402/core/server
vi.mock("@x402/core/server", () => ({
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
    registerPaywallProvider: vi.fn(),
    processHTTPRequest: (...args: unknown[]) => mockFunctions.processHTTPRequest(...args),
    processSettlement: (...args: unknown[]) => mockFunctions.processSettlement(...args),
    requiresPayment: (...args: unknown[]) => mockFunctions.requiresPayment(...args),
    routes: routes || {},
    server: server || {
      hasExtension: vi.fn().mockReturnValue(false),
      registerExtension: vi.fn(),
    },
  })),
  checkIfBazaarNeeded: vi.fn().mockReturnValue(false),
}));

// --- Test Fixtures ---
const mockRoutes = {
  "/api/*": {
    accepts: { scheme: "exact", payTo: "0x123", price: "$0.01", network: "eip155:84532" },
  },
} as const;

const mockRouteConfig = {
  accepts: { scheme: "exact", payTo: "0x123", price: "$0.01", network: "eip155:84532" },
  description: "Test route",
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

// --- Mock Factories ---
/**
 * Creates a mock HTTP server for testing.
 *
 * @param processResult - The result to return from processHTTPRequest.
 * @param settlementResult - Result to return from processSettlement (success with headers or failure).
 * @returns A mock x402HTTPResourceServer.
 */
function createMockHttpServer(
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
): x402HTTPResourceServer {
  const normalizedResult =
    processResult.type === "payment-verified"
      ? {
          ...processResult,
          cancellationDispatcher:
            processResult.cancellationDispatcher ?? createMockPaymentCancellationDispatcher(),
        }
      : processResult;
  return {
    processHTTPRequest: vi.fn().mockResolvedValue(normalizedResult),
    processSettlement: vi.fn().mockResolvedValue(settlementResult),
    registerPaywallProvider: vi.fn(),
    initialize: vi.fn().mockResolvedValue(undefined),
    requiresPayment: vi.fn().mockReturnValue(true),
    routes: mockRoutes,
    server: {
      hasExtension: vi.fn().mockReturnValue(false),
      registerExtension: vi.fn(),
    },
  } as unknown as x402HTTPResourceServer;
}

/**
 * Creates a mock Next.js request for testing.
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
  return new NextRequest(url, {
    method: options.method || "GET",
    headers: options.headers,
  });
}

/**
 * Sets up the mock x402HTTPResourceServer constructor to return instances
 * with the provided mock server's behavior.
 *
 * @param mockServer - The mock x402HTTPResourceServer to use as template.
 */
function setupMockCreateHttpServer(mockServer: x402HTTPResourceServer): void {
  // Replace the shared mock functions with the ones from mockServer
  // This allows the mock constructor to use the configured mocks
  mockFunctions.processHTTPRequest = mockServer.processHTTPRequest as ReturnType<typeof vi.fn>;
  mockFunctions.processSettlement = mockServer.processSettlement as ReturnType<typeof vi.fn>;
  mockFunctions.requiresPayment = mockServer.requiresPayment as ReturnType<typeof vi.fn>;

  // Also set up createHttpServer mock for backward compatibility
  vi.mocked(createHttpServer).mockReturnValue({
    httpServer: mockServer,
    init: vi.fn().mockResolvedValue(undefined),
  });
}

describe("paymentProxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset shared mock functions
    mockFunctions.processHTTPRequest = vi.fn();
    mockFunctions.processSettlement = vi.fn();
    mockFunctions.requiresPayment = vi.fn().mockReturnValue(true);
  });

  it("returns NextResponse.next() when no-payment-required", async () => {
    const mockServer = createMockHttpServer({ type: "no-payment-required" });
    setupMockCreateHttpServer(mockServer);

    const proxy = paymentProxy(mockRoutes, {} as unknown as x402ResourceServer);
    const response = await proxy(createMockRequest());

    expect(response.status).toBe(200);
  });

  it("returns 402 HTML for payment-error with isHtml", async () => {
    const mockServer = createMockHttpServer({
      type: "payment-error",
      response: {
        status: 402,
        headers: { "Content-Type": "text/html" },
        body: "<html>Payment Required</html>",
        isHtml: true,
      },
    });
    setupMockCreateHttpServer(mockServer);

    const proxy = paymentProxy(mockRoutes, {} as unknown as x402ResourceServer);
    const response = await proxy(createMockRequest());

    expect(response.status).toBe(402);
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(await response.text()).toBe("<html>Payment Required</html>");
  });

  it("returns 402 JSON for payment-error", async () => {
    const mockServer = createMockHttpServer({
      type: "payment-error",
      response: {
        status: 402,
        headers: { "X-Custom-Header": "custom-value" },
        body: { error: "Payment required" },
        isHtml: false,
      },
    });
    setupMockCreateHttpServer(mockServer);

    const proxy = paymentProxy(mockRoutes, {} as unknown as x402ResourceServer);
    const response = await proxy(createMockRequest());

    expect(response.status).toBe(402);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    const body = await response.json();
    expect(body).toEqual({ error: "Payment required" });
  });

  it("settles and returns response for payment-verified", async () => {
    const mockServer = createMockHttpServer(
      {
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
        declaredExtensions: {},
      },
      { success: true, headers: { "X-Settlement": "complete" } },
    );
    setupMockCreateHttpServer(mockServer);

    const proxy = paymentProxy(mockRoutes, {} as unknown as x402ResourceServer);
    const response = await proxy(createMockRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Settlement")).toBe("complete");
    expect(mockServer.processSettlement).toHaveBeenCalledWith(
      mockPaymentPayload,
      mockPaymentRequirements,
      {},
      expect.objectContaining({
        request: expect.objectContaining({
          path: "/api/test",
          method: "GET",
        }),
        responseBody: expect.any(Buffer),
      }),
    );
  });

  it("passes paywallConfig to processHTTPRequest", async () => {
    const mockServer = createMockHttpServer({ type: "no-payment-required" });
    setupMockCreateHttpServer(mockServer);
    const paywallConfig = { appName: "test-app", testnet: true };

    const proxy = paymentProxy(mockRoutes, {} as unknown as x402ResourceServer, paywallConfig);
    await proxy(createMockRequest());

    expect(mockServer.processHTTPRequest).toHaveBeenCalledWith(expect.anything(), paywallConfig);
  });

  it("registers custom paywall provider", () => {
    const mockServer = createMockHttpServer({ type: "no-payment-required" });
    setupMockCreateHttpServer(mockServer);
    const paywall: PaywallProvider = { generateHtml: vi.fn() };

    paymentProxy(mockRoutes, {} as unknown as x402ResourceServer, undefined, paywall);

    expect(x402HTTPResourceServer).toHaveBeenCalledWith(expect.anything(), mockRoutes);
  });

  it("returns 402 when settlement throws error", async () => {
    const mockServer = createMockHttpServer({
      type: "payment-verified",
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
    });
    vi.mocked(mockServer.processSettlement).mockRejectedValue(new Error("Settlement rejected"));
    setupMockCreateHttpServer(mockServer);

    const proxy = paymentProxy(mockRoutes, {} as unknown as x402ResourceServer);
    const response = await proxy(createMockRequest());

    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body).toEqual({});
  });

  it("returns 402 when settlement returns success: false, not the resource", async () => {
    const mockServer = createMockHttpServer(
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
    setupMockCreateHttpServer(mockServer);

    const proxy = paymentProxy(mockRoutes, {} as unknown as x402ResourceServer);
    const response = await proxy(createMockRequest());

    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body).toEqual({});
    expect(response.headers.get("PAYMENT-RESPONSE")).toBe("settlement-failed-encoded");
  });
});

describe("withX402", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls handler when no-payment-required", async () => {
    const mockServer = createMockHttpServer({ type: "no-payment-required" });
    setupMockCreateHttpServer(mockServer);
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ data: "protected" }));

    const wrappedHandler = withX402(handler, mockRouteConfig, {} as unknown as x402ResourceServer);
    const response = await wrappedHandler(createMockRequest());

    expect(handler).toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it("returns 402 without calling handler for payment-error", async () => {
    const mockServer = createMockHttpServer({
      type: "payment-error",
      response: {
        status: 402,
        headers: {},
        body: { error: "Payment required" },
        isHtml: false,
      },
    });
    setupMockCreateHttpServer(mockServer);
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ data: "protected" }));

    const wrappedHandler = withX402(handler, mockRouteConfig, {} as unknown as x402ResourceServer);
    const response = await wrappedHandler(createMockRequest());

    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(402);
  });

  it("calls handler and settles for payment-verified", async () => {
    const mockServer = createMockHttpServer(
      {
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
      },
      { success: true, headers: { "X-Settlement": "complete" } },
    );
    setupMockCreateHttpServer(mockServer);
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ data: "protected" }));

    const wrappedHandler = withX402(handler, mockRouteConfig, {} as unknown as x402ResourceServer);
    const response = await wrappedHandler(createMockRequest());

    expect(handler).toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Settlement")).toBe("complete");
  });

  it("skips settlement when handler returns >= 400", async () => {
    const mockServer = createMockHttpServer({
      type: "payment-verified",
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
    });
    setupMockCreateHttpServer(mockServer);
    const handler = vi
      .fn()
      .mockResolvedValue(
        new NextResponse(JSON.stringify({ error: "Bad request" }), { status: 400 }),
      );

    const wrappedHandler = withX402(handler, mockRouteConfig, {} as unknown as x402ResourceServer);
    const response = await wrappedHandler(createMockRequest());

    expect(handler).toHaveBeenCalled();
    expect(response.status).toBe(400);
    expect(mockServer.processSettlement).not.toHaveBeenCalled();
    const cancellationDispatcher = (
      await vi.mocked(mockServer.processHTTPRequest).mock.results[0].value
    ).cancellationDispatcher;
    expect(cancellationDispatcher.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "handler_failed",
        responseStatus: 400,
      }),
    );
  });

  it("returns 402 when settlement throws error, not the handler response", async () => {
    const mockServer = createMockHttpServer({
      type: "payment-verified",
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
    });
    vi.mocked(mockServer.processSettlement).mockRejectedValue(new Error("Settlement rejected"));
    setupMockCreateHttpServer(mockServer);
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ data: "protected" }));

    const wrappedHandler = withX402(handler, mockRouteConfig, {} as unknown as x402ResourceServer);
    const response = await wrappedHandler(createMockRequest());

    expect(handler).toHaveBeenCalled();
    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body).toEqual({});
  });

  it("returns 402 when settlement returns success: false, not the handler response", async () => {
    const mockServer = createMockHttpServer(
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
    setupMockCreateHttpServer(mockServer);
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ data: "protected" }));

    const wrappedHandler = withX402(handler, mockRouteConfig, {} as unknown as x402ResourceServer);
    const response = await wrappedHandler(createMockRequest());

    expect(handler).toHaveBeenCalled();
    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body).toEqual({});
    expect(response.headers.get("PAYMENT-RESPONSE")).toBe("settlement-failed-encoded");
  });
});

describe("paymentProxyFromConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates x402ResourceServer with facilitator clients", () => {
    const mockServer = createMockHttpServer({ type: "no-payment-required" });
    setupMockCreateHttpServer(mockServer);
    const facilitator = { verify: vi.fn(), settle: vi.fn() } as unknown as FacilitatorClient;

    paymentProxyFromConfig(mockRoutes, facilitator);

    expect(x402ResourceServer).toHaveBeenCalledWith(facilitator);
  });

  it("registers scheme servers for each network", () => {
    const mockServer = createMockHttpServer({ type: "no-payment-required" });
    setupMockCreateHttpServer(mockServer);
    const schemeServer = { verify: vi.fn(), settle: vi.fn() } as unknown as SchemeNetworkServer;
    const schemes: SchemeRegistration[] = [
      { network: "eip155:84532", server: schemeServer },
      { network: "eip155:8453", server: schemeServer },
    ];

    paymentProxyFromConfig(mockRoutes, undefined, schemes);

    const serverInstance = vi.mocked(x402ResourceServer).mock.results[0].value;
    expect(serverInstance.register).toHaveBeenCalledTimes(2);
    expect(serverInstance.register).toHaveBeenCalledWith("eip155:84532", schemeServer);
    expect(serverInstance.register).toHaveBeenCalledWith("eip155:8453", schemeServer);
  });

  it("returns a working proxy function", async () => {
    const mockServer = createMockHttpServer({ type: "no-payment-required" });
    setupMockCreateHttpServer(mockServer);

    const proxy = paymentProxyFromConfig(mockRoutes);
    const response = await proxy(createMockRequest());

    expect(response.status).toBe(200);
  });

  it("passes all config options through to paymentProxy", () => {
    const paywall: PaywallProvider = { generateHtml: vi.fn() };
    const paywallConfig = { appName: "test-app" };

    paymentProxyFromConfig(mockRoutes, undefined, undefined, paywallConfig, paywall, false);

    expect(x402HTTPResourceServer).toHaveBeenCalledWith(expect.anything(), mockRoutes);
  });
});
