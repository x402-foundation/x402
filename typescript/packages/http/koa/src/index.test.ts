import { describe, it, expect, vi, beforeEach } from "vitest";
import Koa from "koa";
import http from "http";
import mount from "koa-mount";
import { Readable } from "stream";
import type {
  HTTPProcessResult,
  HTTPRequestContext,
  x402HTTPResourceServer,
} from "@x402/core/server";
import { x402HTTPResourceServer as HTTPResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "./index";

// --- Test Fixtures ---
const mockRoutes = {
  "/api/*": {
    accepts: { scheme: "exact", payTo: "0x123", price: "$0.01", network: "eip155:84532" },
  },
  "/premium/*": {
    accepts: { scheme: "exact", payTo: "0x456", price: "$1.00", network: "eip155:84532" },
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

const mockPremiumRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  maxAmountRequired: "100000",
  payTo: "0x456",
} as unknown as PaymentRequirements;

// --- Mock setup ---
let mockProcessHTTPRequest: ReturnType<typeof vi.fn>;
let mockProcessSettlement: ReturnType<typeof vi.fn>;
let mockRegisterPaywallProvider: ReturnType<typeof vi.fn>;
let mockRequiresPayment: ReturnType<typeof vi.fn>;
let mockInitialize: ReturnType<typeof vi.fn>;

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
    initialize: mockInitialize,
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
  checkIfBazaarNeeded: vi.fn().mockReturnValue(false),
}));

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
        response: {
          status: number;
          headers: Record<string, string>;
          body?: unknown;
          isHtml?: boolean;
        };
      } = {
    success: true,
    headers: {
      "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ settled: true })).toString("base64"),
    },
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
 * Helper to create a test Koa app with middleware and make a request.
 *
 * @param middleware - The Koa middleware to test.
 * @param handler - Optional handler to run after middleware.
 * @param requestOptions - Options for the request.
 * @param requestOptions.path - The request path.
 * @param requestOptions.method - The HTTP method.
 * @param requestOptions.headers - HTTP headers to include.
 * @returns Response data.
 */
async function testRequest(
  middleware: Koa.Middleware,
  handler?: (ctx: Koa.Context) => Promise<void> | void,
  requestOptions: {
    path?: string;
    method?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  const app = new Koa();

  app.use(middleware);
  if (handler) {
    app.use(async ctx => {
      await handler(ctx);
    });
  }

  const server = http.createServer(app.callback());
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}${requestOptions.path || "/api/test"}`, {
    method: requestOptions.method || "GET",
    headers: requestOptions.headers || {},
  });
  const body = await res.text();

  server.close();

  return {
    status: res.status,
    body,
    headers: Object.fromEntries(res.headers.entries()),
  };
}

// --- Tests ---
describe("paymentMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessHTTPRequest = vi.fn();
    mockProcessSettlement = vi.fn();
    mockRegisterPaywallProvider = vi.fn();
    mockRequiresPayment = vi.fn().mockReturnValue(true);
    mockInitialize = vi.fn().mockResolvedValue(undefined);

    // Reset the mock implementation
    vi.mocked(HTTPResourceServer).mockImplementation(
      (server, routes) =>
        ({
          initialize: mockInitialize,
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

  // Case 1: Unmatched route
  it("passes through unmatched routes without 402", async () => {
    mockRequiresPayment.mockReturnValue(false);

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const res = await testRequest(
      middleware,
      async ctx => {
        ctx.status = 200;
        ctx.body = { success: true };
      },
      { path: "/public/resource" },
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    expect(mockProcessHTTPRequest).not.toHaveBeenCalled();
  });

  // Case 2: Matched route, no payment header
  it("returns 402 with decodable PAYMENT-REQUIRED header when no payment", async () => {
    const paymentRequiredBody = { x402Version: 2, accepts: [], error: "Payment required" };
    setupMockHttpServer({
      type: "payment-error",
      response: {
        status: 402,
        body: paymentRequiredBody,
        headers: {
          "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequiredBody)).toString("base64"),
        },
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
    const res = await testRequest(middleware, async ctx => {
      ctx.body = { secret: "should not see" };
    });

    expect(res.status).toBe(402);
    expect(res.headers["payment-required"]).toBeDefined();
    const decoded = JSON.parse(
      Buffer.from(res.headers["payment-required"] as string, "base64").toString(),
    );
    expect(decoded.x402Version).toBe(2);
    expect(res.body).not.toContain("should not see");
  });

  // Case 3: Malformed base64 in PAYMENT-SIGNATURE
  it("returns 402 for malformed base64 payment signature", async () => {
    setupMockHttpServer({
      type: "payment-error",
      response: {
        status: 402,
        body: { error: "Invalid payment" },
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
    const res = await testRequest(
      middleware,
      async ctx => {
        ctx.body = { handler: "ran" };
      },
      { headers: { "payment-signature": "not-valid-base64!!!" } },
    );

    expect(res.status).toBe(402);
  });

  // Case 4: Truncated/invalid payload
  it("returns 402 for truncated payload", async () => {
    setupMockHttpServer({
      type: "payment-error",
      response: {
        status: 402,
        body: { error: "Invalid payment structure" },
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
    // Valid base64, invalid JSON
    const invalidPayload = Buffer.from("{truncated").toString("base64");
    const res = await testRequest(middleware, undefined, {
      headers: { "payment-signature": invalidPayload },
    });

    expect(res.status).toBe(402);
  });

  // Case 5: Oversized header
  // SKIPPED: Oversized headers (>16KB) are rejected by Node's HTTP parser with 431 status
  // before the middleware executes. This is documented in NOTES.md.

  // Case 6: Valid payment, verify fails
  it("returns 402 when verification fails, handler not run, settle not called", async () => {
    setupMockHttpServer({
      type: "payment-error",
      response: {
        status: 402,
        body: { error: "Verification failed" },
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
    const res = await testRequest(
      middleware,
      async ctx => {
        ctx.body = { handler: "ran" };
      },
      { headers: { "payment-signature": "valid-looking-signature" } },
    );

    expect(res.status).toBe(402);
    expect(mockProcessSettlement).not.toHaveBeenCalled();
  });

  // Case 7: Valid payment, verify + settle succeed
  it("returns 200 with PAYMENT-RESPONSE when payment succeeds", async () => {
    const settleResponse = { settled: true, amount: "1000" };
    setupMockHttpServer(
      {
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
        declaredExtensions: {},
      },
      {
        success: true,
        headers: {
          "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(settleResponse)).toString("base64"),
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
    const res = await testRequest(
      middleware,
      async ctx => {
        ctx.status = 200;
        ctx.body = { data: "protected content" };
      },
      { headers: { "payment-signature": "valid" } },
    );

    expect(res.status).toBe(200);
    expect(res.headers["payment-response"]).toBeDefined();
    const decoded = JSON.parse(
      Buffer.from(res.headers["payment-response"] as string, "base64").toString(),
    );
    expect(decoded.settled).toBe(true);
    expect(JSON.parse(res.body)).toEqual({ data: "protected content" });
  });

  // Case 8: Handler throws
  it("propagates error when handler throws, settle not called", async () => {
    setupMockHttpServer({
      type: "payment-verified",
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
      declaredExtensions: {},
    });

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const app = new Koa();
    app.on("error", () => {}); // Suppress error logging
    app.use(middleware);
    app.use(async () => {
      throw new Error("Handler error");
    });

    const server = http.createServer(app.callback());
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    const res = await fetch(`http://localhost:${port}/api/test`, {
      headers: { "payment-signature": "valid" },
    });

    expect(res.status).toBe(500);
    expect(mockProcessSettlement).not.toHaveBeenCalled();
    server.close();
  });

  // Case 9: Handler sets 500
  it("returns 500 when handler sets 500, settle not called", async () => {
    setupMockHttpServer({
      type: "payment-verified",
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
      declaredExtensions: {},
    });

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const res = await testRequest(
      middleware,
      async ctx => {
        ctx.status = 500;
        ctx.body = { error: "Internal error" };
      },
      { headers: { "payment-signature": "valid" } },
    );

    expect(res.status).toBe(500);
    expect(mockProcessSettlement).not.toHaveBeenCalled();
  });

  // Case 10: Handler sets 404
  it("returns 404 when handler sets 404, settle not called", async () => {
    setupMockHttpServer({
      type: "payment-verified",
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
      declaredExtensions: {},
    });

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const res = await testRequest(
      middleware,
      async ctx => {
        ctx.status = 404;
        ctx.body = { error: "Not found" };
      },
      { headers: { "payment-signature": "valid" } },
    );

    expect(res.status).toBe(404);
    expect(mockProcessSettlement).not.toHaveBeenCalled();
  });

  // Case 11: Settle fails after successful handler
  it("returns 402 when settlement fails, handler body absent", async () => {
    setupMockHttpServer(
      {
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
        declaredExtensions: {},
      },
      {
        success: false,
        errorReason: "Settlement failed",
        headers: {},
        response: {
          status: 402,
          headers: {},
          body: { error: "Settlement failed" },
          isHtml: false,
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
    const res = await testRequest(
      middleware,
      async ctx => {
        ctx.status = 200;
        ctx.body = { secret: "should not appear" };
      },
      { headers: { "payment-signature": "valid" } },
    );

    expect(res.status).toBe(402);
    expect(res.body).not.toContain("should not appear");
    expect(mockProcessSettlement).toHaveBeenCalled();
  });

  // Case 12: Mounted under koa-mount
  it("matches on mount-relative path, resource is full external URL", async () => {
    let capturedContext: HTTPRequestContext | undefined;
    mockProcessHTTPRequest.mockImplementation(context => {
      capturedContext = context;
      return Promise.resolve({
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
        declaredExtensions: {},
        cancellationDispatcher: createMockPaymentCancellationDispatcher(),
      });
    });
    mockProcessSettlement.mockResolvedValue({
      success: true,
      headers: { "PAYMENT-RESPONSE": "test" },
    });

    const subApp = new Koa();
    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    subApp.use(middleware);
    subApp.use(async ctx => {
      ctx.status = 200;
      ctx.body = { mounted: true };
    });

    const mainApp = new Koa();
    mainApp.use(mount("/v1", subApp));

    const server = http.createServer(mainApp.callback());
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    const res = await fetch(`http://localhost:${port}/v1/api/test`, {
      headers: { "payment-signature": "valid" },
    });

    expect(res.status).toBe(200);
    // ctx.path should be mount-relative (/api/test)
    expect(capturedContext!.path).toBe("/api/test");
    // adapter.getUrl() should return full external URL
    expect(capturedContext!.adapter.getUrl()).toContain("/v1/api/test");
    server.close();
  });

  // Case 13: Multiple routes, correct requirement selected
  it("selects correct requirements for multiple routes", async () => {
    let capturedPath: string | undefined;
    mockProcessHTTPRequest.mockImplementation(context => {
      capturedPath = context.path;
      // Return different requirements based on path
      const requirements = context.path.startsWith("/premium/")
        ? mockPremiumRequirements
        : mockPaymentRequirements;
      return Promise.resolve({
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: requirements,
        declaredExtensions: {},
        cancellationDispatcher: createMockPaymentCancellationDispatcher(),
      });
    });
    mockProcessSettlement.mockResolvedValue({
      success: true,
      headers: { "PAYMENT-RESPONSE": "test" },
    });

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const res = await testRequest(
      middleware,
      async ctx => {
        ctx.status = 200;
        ctx.body = { premium: true };
      },
      { path: "/premium/content", headers: { "payment-signature": "valid" } },
    );

    expect(res.status).toBe(200);
    expect(capturedPath).toBe("/premium/content");
  });

  // Case 14: Handler sets 3xx (redirect)
  it("returns redirect when handler sets 3xx, settle not called", async () => {
    setupMockHttpServer({
      type: "payment-verified",
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
      declaredExtensions: {},
    });

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    // Manual test to prevent fetch from following redirect
    const app = new Koa();
    app.use(middleware);
    app.use(async ctx => {
      ctx.status = 302;
      ctx.redirect("/other");
    });

    const server = http.createServer(app.callback());
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    const res = await fetch(`http://localhost:${port}/api/test`, {
      headers: { "payment-signature": "valid" },
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    expect(mockProcessSettlement).not.toHaveBeenCalled();
    server.close();
  });

  // Case 15: ctx.respond = false
  it("throws error when ctx.respond = false", async () => {
    setupMockHttpServer({
      type: "payment-verified",
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
      declaredExtensions: {},
    });

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const app = new Koa();
    let errorMessage = "";
    app.on("error", err => {
      errorMessage = err.message;
    });
    app.use(middleware);
    app.use(async ctx => {
      ctx.respond = false;
      ctx.res.statusCode = 200;
      ctx.res.end("direct response");
    });

    const server = http.createServer(app.callback());
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    await fetch(`http://localhost:${port}/api/test`, {
      headers: { "payment-signature": "valid" },
    });

    expect(errorMessage).toContain("ctx.respond = false");
    expect(errorMessage).toContain("Content was served without settlement");
    server.close();
  });

  // Case 16: ctx.res.headersSent = true
  it("throws error when headers already sent", async () => {
    setupMockHttpServer({
      type: "payment-verified",
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
      declaredExtensions: {},
    });

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const app = new Koa();
    let errorMessage = "";
    app.on("error", err => {
      errorMessage = err.message;
    });
    app.use(middleware);
    app.use(async ctx => {
      ctx.res.writeHead(200, { "Content-Type": "text/plain" });
      ctx.res.write("partial");
      ctx.res.end(" response");
    });

    const server = http.createServer(app.callback());
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    await fetch(`http://localhost:${port}/api/test`, {
      headers: { "payment-signature": "valid" },
    });

    expect(errorMessage).toContain("headers flushed");
    expect(errorMessage).toContain("Content was served without settlement");
    server.close();
  });

  // Case 17: Settlement-Overrides header removed on handler 500
  it("removes Settlement-Overrides header on handler 500", async () => {
    setupMockHttpServer({
      type: "payment-verified",
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
      declaredExtensions: {},
    });

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const res = await testRequest(
      middleware,
      async ctx => {
        setSettlementOverrides(ctx, { amount: "500" });
        ctx.status = 500;
        ctx.body = { error: "Server error" };
      },
      { headers: { "payment-signature": "valid" } },
    );

    expect(res.status).toBe(500);
    expect(res.headers["settlement-overrides"]).toBeUndefined();
  });

  // Case 18: Settlement-Overrides header removed on handler throw
  it("removes Settlement-Overrides header on handler throw", async () => {
    setupMockHttpServer({
      type: "payment-verified",
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
      declaredExtensions: {},
    });

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );

    const app = new Koa();
    app.on("error", () => {});
    app.use(middleware);
    app.use(async ctx => {
      setSettlementOverrides(ctx, { amount: "500" });
      throw new Error("Handler error");
    });

    const server = http.createServer(app.callback());
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    const res = await fetch(`http://localhost:${port}/api/test`, {
      headers: { "payment-signature": "valid" },
    });

    expect(res.status).toBe(500);
    expect(res.headers.get("settlement-overrides")).toBeNull();
    server.close();
  });

  // Case 19: Settlement-Overrides header removed on settle success
  it("removes Settlement-Overrides header on settle success", async () => {
    setupMockHttpServer(
      {
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
        declaredExtensions: {},
      },
      { success: true, headers: { "PAYMENT-RESPONSE": "test" } },
    );

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const res = await testRequest(
      middleware,
      async ctx => {
        setSettlementOverrides(ctx, { amount: "500" });
        ctx.status = 200;
        ctx.body = { data: "test" };
      },
      { headers: { "payment-signature": "valid" } },
    );

    expect(res.status).toBe(200);
    expect(res.headers["settlement-overrides"]).toBeUndefined();
  });

  // Case 20: Settlement-Overrides header removed on settle failure
  it("removes Settlement-Overrides header on settle failure", async () => {
    setupMockHttpServer(
      {
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
        declaredExtensions: {},
      },
      {
        success: false,
        errorReason: "Settlement failed",
        headers: {},
        response: { status: 402, headers: {}, body: { error: "Failed" } },
      },
    );

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const res = await testRequest(
      middleware,
      async ctx => {
        setSettlementOverrides(ctx, { amount: "500" });
        ctx.status = 200;
        ctx.body = { data: "test" };
      },
      { headers: { "payment-signature": "valid" } },
    );

    expect(res.status).toBe(402);
    expect(res.headers["settlement-overrides"]).toBeUndefined();
  });

  // Case 21: Stream body on settle failure
  it("destroys stream and returns 402 on settle failure", async () => {
    let streamDestroyed = false;
    setupMockHttpServer(
      {
        type: "payment-verified",
        paymentPayload: mockPaymentPayload,
        paymentRequirements: mockPaymentRequirements,
        declaredExtensions: {},
      },
      {
        success: false,
        errorReason: "Settlement failed",
        headers: {},
        response: { status: 402, headers: {}, body: { error: "Failed" } },
      },
    );

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const res = await testRequest(
      middleware,
      async ctx => {
        ctx.status = 200;
        const stream = new Readable({
          read() {
            this.push("stream data");
            this.push(null);
          },
          destroy() {
            streamDestroyed = true;
          },
        });
        ctx.body = stream;
      },
      { headers: { "payment-signature": "valid" } },
    );

    expect(res.status).toBe(402);
    expect(streamDestroyed).toBe(true);
    expect(res.body).not.toContain("stream data");
  });

  // Case 22: upto route with override set
  it("settles with override amount, not authorized maximum", async () => {
    let settledOverrides: Record<string, string> | undefined;
    // Set up processHTTPRequest first
    mockProcessHTTPRequest.mockResolvedValue({
      type: "payment-verified",
      paymentPayload: mockPaymentPayload,
      paymentRequirements: mockPaymentRequirements,
      declaredExtensions: {},
      cancellationDispatcher: createMockPaymentCancellationDispatcher(),
    });
    // Then set up processSettlement to capture overrides
    mockProcessSettlement.mockImplementation(
      (_payload, _requirements, _extensions, _context, overrides) => {
        settledOverrides = overrides;
        return Promise.resolve({
          success: true,
          headers: { "PAYMENT-RESPONSE": "test" },
        });
      },
    );

    const middleware = paymentMiddleware(
      mockRoutes,
      {} as unknown as x402ResourceServer,
      undefined,
      undefined,
      false,
    );
    const res = await testRequest(
      middleware,
      async ctx => {
        // Handler uses 500 units out of 1000 authorized
        setSettlementOverrides(ctx, { amount: "500" });
        ctx.status = 200;
        ctx.body = { usage: 500 };
      },
      { headers: { "payment-signature": "valid" } },
    );

    expect(res.status).toBe(200);
    expect(settledOverrides).toEqual({ amount: "500" });
  });
});

describe("KoaAdapter", () => {
  // Basic adapter tests if needed
  it("exports KoaAdapter", async () => {
    const { KoaAdapter } = await import("./adapter");
    expect(KoaAdapter).toBeDefined();
  });
});
