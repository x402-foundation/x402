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
vi.mock("@x402/core/server", () => {
  const MockHTTPResourceServer = vi.fn().mockImplementation(() => ({
    initialize: mockInitialize,
    registerPaywallProvider: vi.fn(),
    processSettlement: vi.fn(),
    requiresPayment: vi.fn().mockReturnValue(true),
  }));
  return {
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
    mockPaymentCancellationDispatcher = {
      cancel: vi.fn().mockResolvedValue(undefined),
    } as unknown as PaymentCancellationDispatcher;
    mockHttpServer = {
      processSettlement: vi
        .fn()
        .mockResolvedValue({ success: true, headers: { "PAYMENT-RESPONSE": "settled" } }),
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
    );

    expect(result.status).toBe(500);
    expect(mockHttpServer.processSettlement).not.toHaveBeenCalled();
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
    );

    expect(result.status).toBe(400);
    expect(mockHttpServer.processSettlement).not.toHaveBeenCalled();
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
    );

    expect(result.status).toBe(200);
    expect(result.headers.get("PAYMENT-RESPONSE")).toBe("settled");
    expect(mockHttpServer.processSettlement).toHaveBeenCalledWith(
      mockPaymentPayload,
      mockRequirements,
      mockDeclaredExtensions,
      undefined,
    );
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
    );

    expect(result.status).toBe(402);
    const body = await result.json();
    expect(body).toEqual({});
  });
});
