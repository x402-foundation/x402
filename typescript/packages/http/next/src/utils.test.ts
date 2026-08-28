import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type {
  x402HTTPResourceServer,
  x402ResourceServer,
  PaywallProvider,
  PaymentCancellationDispatcher,
} from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  createHttpServer,
  createRequestContext,
  handlePaymentError,
  handleSettlement,
} from "./utils";

let mockInitialize: ReturnType<typeof vi.fn>;

// Mock @x402/core/server
vi.mock("@x402/core/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@x402/core/server")>();
  const MockHTTPResourceServer = vi.fn().mockImplementation(() => ({
    initialize: mockInitialize,
    registerPaywallProvider: vi.fn(),
    processSettlement: vi.fn(),
    requiresPayment: vi.fn().mockReturnValue(true),
  }));
  return {
    ...actual,
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
    SETTLEMENT_OVERRIDES_HEADER: "Settlement-Overrides",
    x402HTTPResourceServer: MockHTTPResourceServer,
    x402ResourceServer: vi.fn(),
    checkIfBazaarNeeded: vi.fn().mockReturnValue(false),
  };
});

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
  return new NextRequest(url, {
    method: options.method || "GET",
    headers: options.headers,
  });
}

/**
 * Factory for creating a mock x402ResourceServer.
 *
 * @returns A mock x402ResourceServer.
 */
function createMockResourceServer(): x402ResourceServer {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
  } as unknown as x402ResourceServer;
}

describe("createHttpServer", () => {
  beforeEach(() => {
    mockInitialize = vi.fn().mockResolvedValue(undefined);
  });

  it("creates server and initializes on start by default", async () => {
    const routes = {
      "/api/*": {
        accepts: { scheme: "exact", payTo: "0x123", price: "$0.01", network: "eip155:84532" },
      },
    } as const;
    const server = createMockResourceServer();

    const { httpServer, init } = createHttpServer(routes, server);

    expect(httpServer).toBeDefined();
    await init();
    // httpServer.initialize() is called (which internally calls server.initialize() and validates)
    expect(httpServer.initialize).toHaveBeenCalled();
  });

  it("does not initialize when syncFacilitatorOnStart is false", async () => {
    const routes = {
      "/api/*": {
        accepts: { scheme: "exact", payTo: "0x123", price: "$0.01", network: "eip155:84532" },
      },
    } as const;
    const server = createMockResourceServer();

    const { httpServer, init } = createHttpServer(routes, server, undefined, false);

    await init();
    expect(httpServer.initialize).not.toHaveBeenCalled();
  });

  it("registers custom paywall provider when provided", async () => {
    const routes = {
      "/api/*": {
        accepts: { scheme: "exact", payTo: "0x123", price: "$0.01", network: "eip155:84532" },
      },
    } as const;
    const server = createMockResourceServer();
    const paywall: PaywallProvider = { generateHtml: vi.fn() };

    const { httpServer, init } = createHttpServer(routes, server, paywall);

    // Wait for initialization to complete to avoid warnings
    await init();
    expect(httpServer.registerPaywallProvider).toHaveBeenCalledWith(paywall);
  });

  it("retries initialization after a facilitator init failure", async () => {
    mockInitialize = vi
      .fn()
      .mockRejectedValueOnce(new Error("not-json"))
      .mockResolvedValueOnce(undefined);
    const routes = {
      "/api/*": {
        accepts: { scheme: "exact", payTo: "0x123", price: "$0.01", network: "eip155:84532" },
      },
    } as const;
    const server = createMockResourceServer();

    const { init } = createHttpServer(routes, server);

    await expect(init()).rejects.toThrow("not-json");
    await expect(init()).resolves.toBeUndefined();
    expect(mockInitialize).toHaveBeenCalledTimes(2);
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
      mockInitialize = ((): Promise<void> => {
        initializeCalls += 1;
        return initializeCalls === 1
          ? Promise.reject(new Error("facilitator request timed out"))
          : Promise.resolve(undefined);
      }) as unknown as ReturnType<typeof vi.fn>;
      const routes = {
        "/api/*": {
          accepts: { scheme: "exact", payTo: "0x123", price: "$0.01", network: "eip155:84532" },
        },
      } as const;
      const server = createMockResourceServer();

      const { init } = createHttpServer(routes, server);
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(unhandled).toHaveLength(0);

      await expect(init()).rejects.toThrow("facilitator request timed out");
      await expect(init()).resolves.toBeUndefined();
      expect(initializeCalls).toBe(2);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});

describe("createRequestContext", () => {
  it("extracts path and method from request", () => {
    const req = createMockRequest({ url: "https://example.com/api/weather", method: "POST" });

    const context = createRequestContext(req);

    expect(context.path).toBe("/api/weather");
    expect(context.method).toBe("POST");
    expect(context.adapter).toBeDefined();
  });

  it("extracts x-payment header", () => {
    const req = createMockRequest({ headers: { "X-Payment": "payment-data" } });

    const context = createRequestContext(req);

    expect(context.paymentHeader).toBe("payment-data");
  });

  it("extracts payment-signature header (v2)", () => {
    const req = createMockRequest({ headers: { "Payment-Signature": "sig-data" } });

    const context = createRequestContext(req);

    expect(context.paymentHeader).toBe("sig-data");
  });

  it("prefers payment-signature over x-payment", () => {
    const req = createMockRequest({
      headers: { "Payment-Signature": "sig-data", "X-Payment": "x-payment-data" },
    });

    const context = createRequestContext(req);

    expect(context.paymentHeader).toBe("sig-data");
  });

  it("returns undefined paymentHeader when no payment headers present", () => {
    const req = createMockRequest();

    const context = createRequestContext(req);

    expect(context.paymentHeader).toBeUndefined();
  });
});

describe("handlePaymentError", () => {
  it("returns HTML response when isHtml is true", () => {
    const response = handlePaymentError({
      status: 402,
      body: "<html>Paywall</html>",
      headers: { "X-Custom": "value" },
      isHtml: true,
    });

    expect(response.status).toBe(402);
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(response.headers.get("X-Custom")).toBe("value");
  });

  it("returns JSON response when isHtml is false", async () => {
    const body = { error: "Payment required", accepts: [] };
    const response = handlePaymentError({
      status: 402,
      body,
      headers: {},
      isHtml: false,
    });

    expect(response.status).toBe(402);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual(body);
  });

  it("handles empty body in JSON response", async () => {
    const response = handlePaymentError({
      status: 402,
      headers: {},
    });

    expect(await response.json()).toEqual({});
  });
});

describe("handleSettlement", () => {
  let mockHttpServer: x402HTTPResourceServer;
  let mockHttpContext: ReturnType<typeof createRequestContext>;
  const mockPaymentPayload = {
    scheme: "exact",
    network: "eip155:84532",
  } as unknown as PaymentPayload;
  const mockRequirements = {
    scheme: "exact",
    network: "eip155:84532",
  } as unknown as PaymentRequirements;
  const mockDeclaredExtensions = {};
  let mockPaymentCancellationDispatcher: PaymentCancellationDispatcher;

  beforeEach(() => {
    mockHttpContext = createRequestContext(createMockRequest());
    mockPaymentCancellationDispatcher = {
      cancel: vi.fn().mockResolvedValue(undefined),
    } as unknown as PaymentCancellationDispatcher;
    mockHttpServer = {
      processSettlement: vi
        .fn()
        .mockResolvedValue({ success: true, headers: { "PAYMENT-RESPONSE": "settled" } }),
      createCompletedSettlementHeaders: vi.fn((_settlement, existingCacheControl) => ({
        "PAYMENT-RESPONSE": "before-handler-receipt",
        "Cache-Control": existingCacheControl ? `${existingCacheControl}, private` : "private",
      })),
      createFailurePathSettlementHeaders: vi.fn((cancelSettlement, settlement) => {
        if (cancelSettlement) {
          return {
            "PAYMENT-RESPONSE": cancelSettlement.success
              ? "cancel-receipt"
              : "cancel-failure-receipt",
            "Cache-Control": "private",
          };
        }
        if (settlement) {
          return {
            "PAYMENT-RESPONSE": "before-handler-receipt",
            "Cache-Control": "private",
          };
        }
        return undefined;
      }),
    } as unknown as x402HTTPResourceServer;
  });

  it("returns original response when status >= 400 without settling", async () => {
    const response = new NextResponse("Error", { status: 500 });

    const result = await handleSettlement(
      mockHttpServer,
      response,
      mockPaymentPayload,
      mockRequirements,
      mockDeclaredExtensions,
      mockPaymentCancellationDispatcher,
      mockHttpContext,
    );

    expect(result.status).toBe(500);
    expect(mockHttpServer.processSettlement).not.toHaveBeenCalled();
    expect(mockHttpServer.createFailurePathSettlementHeaders).toHaveBeenCalledWith(
      undefined,
      undefined,
      mockPaymentPayload,
      null,
    );
    expect(mockPaymentCancellationDispatcher.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "handler_failed",
        responseStatus: 500,
      }),
    );
  });

  it("returns original response when status is exactly 400", async () => {
    const response = new NextResponse("Bad Request", { status: 400 });

    const result = await handleSettlement(
      mockHttpServer,
      response,
      mockPaymentPayload,
      mockRequirements,
      mockDeclaredExtensions,
      mockPaymentCancellationDispatcher,
      mockHttpContext,
    );

    expect(result.status).toBe(400);
    expect(mockHttpServer.processSettlement).not.toHaveBeenCalled();
  });

  it("echoes before-handler PAYMENT-RESPONSE when status >= 400", async () => {
    const beforeHandlerSettlement = {
      phase: "before-handler" as const,
      flow: "upfront" as const,
      result: {
        success: true,
        transaction: "0xdeposit",
        network: "eip155:84532" as const,
      },
      requirements: mockRequirements,
    };
    const response = new NextResponse("Error", { status: 500 });

    const result = await handleSettlement(
      mockHttpServer,
      response,
      mockPaymentPayload,
      mockRequirements,
      mockDeclaredExtensions,
      mockPaymentCancellationDispatcher,
      mockHttpContext,
      beforeHandlerSettlement,
    );

    expect(result.status).toBe(500);
    expect(mockHttpServer.processSettlement).not.toHaveBeenCalled();
    expect(mockHttpServer.createFailurePathSettlementHeaders).toHaveBeenCalledWith(
      undefined,
      beforeHandlerSettlement,
      mockPaymentPayload,
      null,
    );
    expect(result.headers.get("PAYMENT-RESPONSE")).toBe("before-handler-receipt");
    expect(result.headers.get("Cache-Control")).toBe("private");
  });

  it("adds settlement headers on successful settlement", async () => {
    const response = new NextResponse("OK", { status: 200 });

    const result = await handleSettlement(
      mockHttpServer,
      response,
      mockPaymentPayload,
      mockRequirements,
      mockDeclaredExtensions,
      mockPaymentCancellationDispatcher,
      mockHttpContext,
    );

    expect(result.status).toBe(200);
    expect(result.headers.get("PAYMENT-RESPONSE")).toBe("settled");
    expect(result.headers.get("Cache-Control")).toBe("private");
    expect(mockHttpServer.processSettlement).toHaveBeenCalledWith(
      mockPaymentPayload,
      mockRequirements,
      mockDeclaredExtensions,
      expect.objectContaining({
        request: mockHttpContext,
        responseBody: expect.any(Buffer),
        responseHeaders: expect.any(Object),
      }),
      undefined,
      undefined,
    );
  });

  it("merges private into existing Cache-Control on successful settlement", async () => {
    const response = new NextResponse("OK", {
      status: 200,
      headers: { "Cache-Control": "max-age=60" },
    });

    const result = await handleSettlement(
      mockHttpServer,
      response,
      mockPaymentPayload,
      mockRequirements,
      mockDeclaredExtensions,
      mockPaymentCancellationDispatcher,
      mockHttpContext,
    );

    expect(result.headers.get("Cache-Control")).toBe("max-age=60, private");
  });

  it("forwards response headers to processSettlement for settlement overrides", async () => {
    const response = new NextResponse("OK", { status: 200 });
    response.headers.set("Settlement-Overrides", JSON.stringify({ amount: "32%" }));
    const httpContext = createRequestContext(createMockRequest());

    await handleSettlement(
      mockHttpServer,
      response,
      mockPaymentPayload,
      mockRequirements,
      mockDeclaredExtensions,
      mockPaymentCancellationDispatcher,
      httpContext,
    );

    expect(mockHttpServer.processSettlement).toHaveBeenCalledWith(
      mockPaymentPayload,
      mockRequirements,
      mockDeclaredExtensions,
      expect.objectContaining({
        request: httpContext,
        responseBody: expect.any(Buffer),
        responseHeaders: expect.objectContaining({
          "settlement-overrides": JSON.stringify({ amount: "32%" }),
        }),
      }),
      undefined,
      undefined,
    );
  });

  it("strips settlement override header from client response", async () => {
    const response = new NextResponse("OK", { status: 200 });
    response.headers.set("Settlement-Overrides", JSON.stringify({ amount: "32%" }));

    const result = await handleSettlement(
      mockHttpServer,
      response,
      mockPaymentPayload,
      mockRequirements,
      mockDeclaredExtensions,
      mockPaymentCancellationDispatcher,
      mockHttpContext,
    );

    expect(result.headers.has("Settlement-Overrides")).toBe(false);
    expect(result.headers.get("PAYMENT-RESPONSE")).toBe("settled");
  });

  it("strips settlement override header when handler returns >= 400", async () => {
    const response = new NextResponse("Error", { status: 500 });
    response.headers.set("Settlement-Overrides", JSON.stringify({ amount: "32%" }));

    const result = await handleSettlement(
      mockHttpServer,
      response,
      mockPaymentPayload,
      mockRequirements,
      mockDeclaredExtensions,
      mockPaymentCancellationDispatcher,
      mockHttpContext,
    );

    expect(result.status).toBe(500);
    expect(result.headers.has("Settlement-Overrides")).toBe(false);
    expect(mockHttpServer.processSettlement).not.toHaveBeenCalled();
  });

  it("returns 402 error response when settlement returns failure", async () => {
    vi.mocked(mockHttpServer.processSettlement).mockResolvedValue({
      success: false,
      errorReason: "Insufficient funds",
      transaction: "",
      network: "eip155:84532",
      headers: { "PAYMENT-RESPONSE": "settlement-failed-encoded" },
      response: {
        status: 402,
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-RESPONSE": "settlement-failed-encoded",
        },
        body: {},
      },
    });
    const response = new NextResponse("OK", { status: 200 });

    const result = await handleSettlement(
      mockHttpServer,
      response,
      mockPaymentPayload,
      mockRequirements,
      mockDeclaredExtensions,
      mockPaymentCancellationDispatcher,
      mockHttpContext,
    );

    expect(result.status).toBe(402);
    const body = await result.json();
    expect(body).toEqual({});
    expect(result.headers.get("PAYMENT-RESPONSE")).toBe("settlement-failed-encoded");
  });

  it("returns 402 error response when settlement throws", async () => {
    vi.mocked(mockHttpServer.processSettlement).mockRejectedValue(new Error("Settlement rejected"));
    const response = new NextResponse("OK", { status: 200 });

    const result = await handleSettlement(
      mockHttpServer,
      response,
      mockPaymentPayload,
      mockRequirements,
      mockDeclaredExtensions,
      mockPaymentCancellationDispatcher,
      mockHttpContext,
    );

    expect(result.status).toBe(402);
    const body = await result.json();
    expect(body).toEqual({});
  });
});
