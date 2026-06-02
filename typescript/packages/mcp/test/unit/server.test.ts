/**
 * Unit tests for createPaymentWrapper
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPaymentWrapper } from "../../src/server";
import { MCP_PAYMENT_RESPONSE_META_KEY } from "../../src/types";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

// ============================================================================
// Mock Types
// ============================================================================

interface MockResourceServer {
  findMatchingRequirements: ReturnType<typeof vi.fn>;
  verifyPayment: ReturnType<typeof vi.fn>;
  settlePayment: ReturnType<typeof vi.fn>;
  createPaymentRequiredResponse: ReturnType<typeof vi.fn>;
  createPaymentCancellationDispatcher: ReturnType<typeof vi.fn>;
}

// ============================================================================
// Test Fixtures
// ============================================================================

const mockPaymentRequirements: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "1000",
  asset: "0xtoken",
  payTo: "0xrecipient",
  maxTimeoutSeconds: 60,
  extra: {},
};

const mockPaymentPayload: PaymentPayload = {
  x402Version: 2,
  accepted: mockPaymentRequirements,
  payload: {
    signature: "0x123",
    authorization: {
      from: "0xabc",
      to: "0xdef",
      value: "1000",
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 3600,
      nonce: "0x1",
    },
  },
};

const mockVerifyResponse: VerifyResponse = {
  isValid: true,
};

const mockSettleResponse: SettleResponse = {
  success: true,
  transaction: "0xtxhash123",
  network: "eip155:84532",
};

const mockPaymentRequired = {
  x402Version: 2,
  accepts: [mockPaymentRequirements],
  error: "Payment required",
  resource: {
    url: "mcp://tool/test",
    description: "Test tool",
    mimeType: "application/json",
  },
};

// ============================================================================
// Mock Factory
// ============================================================================

/**
 * Creates a mock resource server for testing
 *
 * @returns Mock resource server instance
 */
function createMockResourceServer(): MockResourceServer {
  const cancel = vi.fn().mockResolvedValue(undefined);
  return {
    findMatchingRequirements: vi.fn().mockReturnValue(mockPaymentRequirements),
    verifyPayment: vi.fn().mockResolvedValue(mockVerifyResponse),
    settlePayment: vi.fn().mockResolvedValue(mockSettleResponse),
    createPaymentRequiredResponse: vi.fn().mockResolvedValue(mockPaymentRequired),
    createPaymentCancellationDispatcher: vi.fn().mockReturnValue({ cancel }),
  };
}

// ============================================================================
// createPaymentWrapper Tests
// ============================================================================

describe("createPaymentWrapper", () => {
  let mockResourceServer: MockResourceServer;

  beforeEach(() => {
    mockResourceServer = createMockResourceServer();
  });

  describe("basic payment flow", () => {
    it("should require payment when no payment provided", async () => {
      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );

      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "success" }],
      });

      const wrappedHandler = paid(handler);
      const result = await wrappedHandler({ test: "arg" }, {});

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(mockPaymentRequired);
      expect(handler).not.toHaveBeenCalled();
    });

    it("should verify payment and execute tool when payment provided", async () => {
      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );

      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "success" }],
      });

      const wrappedHandler = paid(handler);
      const result = await wrappedHandler(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(mockResourceServer.verifyPayment).toHaveBeenCalledWith(
        mockPaymentPayload,
        mockPaymentRequirements,
        {},
        expect.objectContaining({
          toolName: "paid_tool",
          arguments: { test: "arg" },
        }),
      );
      expect(handler).toHaveBeenCalled();
      expect(result.content).toEqual([{ type: "text", text: "success" }]);
      expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toEqual(mockSettleResponse);
    });

    it("should settle payment after successful execution", async () => {
      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );

      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "success" }],
      });

      const wrappedHandler = paid(handler);
      await wrappedHandler({ test: "arg" }, { _meta: { "x402/payment": mockPaymentPayload } });

      expect(mockResourceServer.settlePayment).toHaveBeenCalledWith(
        mockPaymentPayload,
        mockPaymentRequirements,
        {},
        expect.objectContaining({
          toolName: "paid_tool",
          arguments: { test: "arg" },
        }),
      );
    });

    it("should preserve structuredContent from handler result", async () => {
      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );

      const structuredData = { query: "test", results: [{ id: 1 }], count: 1 };
      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify(structuredData) }],
        structuredContent: structuredData,
      });

      const wrappedHandler = paid(handler);
      const result = await wrappedHandler(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(result.structuredContent).toEqual(structuredData);
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(structuredData) }]);
      expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toEqual(mockSettleResponse);
    });

    it("should preserve existing metadata from handler result", async () => {
      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );

      const handlerMeta = {
        traceId: "trace_123",
        evidence: { ledgerId: "ledger_1" },
      };
      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "success" }],
        _meta: handlerMeta,
      });

      const wrappedHandler = paid(handler);
      const result = await wrappedHandler(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(result._meta?.traceId).toBe("trace_123");
      expect(result._meta?.evidence).toEqual({ ledgerId: "ledger_1" });
      expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toEqual(mockSettleResponse);
    });

    it("should not settle payment if tool returns error", async () => {
      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );

      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "error" }],
        isError: true,
      });

      const wrappedHandler = paid(handler);
      const result = await wrappedHandler(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(result.isError).toBe(true);
      expect(mockResourceServer.settlePayment).not.toHaveBeenCalled();
      const dispatcher = mockResourceServer.createPaymentCancellationDispatcher.mock.results[0]
        .value as { cancel: ReturnType<typeof vi.fn> };
      expect(dispatcher.cancel).toHaveBeenCalledWith({ reason: "handler_failed" });
    });

    it("should cancel verified payment if tool handler throws", async () => {
      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );
      const error = new Error("handler failed");
      const handler = vi.fn().mockRejectedValue(error);
      const wrappedHandler = paid(handler);

      await expect(
        wrappedHandler({ test: "arg" }, { _meta: { "x402/payment": mockPaymentPayload } }),
      ).rejects.toThrow("handler failed");

      const dispatcher = mockResourceServer.createPaymentCancellationDispatcher.mock.results[0]
        .value as { cancel: ReturnType<typeof vi.fn> };
      expect(dispatcher.cancel).toHaveBeenCalledWith({
        reason: "handler_threw",
        error,
      });
      expect(mockResourceServer.settlePayment).not.toHaveBeenCalled();
    });

    it("should settle skipHandler responses without executing the tool", async () => {
      mockResourceServer.verifyPayment.mockResolvedValueOnce({
        isValid: true,
        skipHandler: { body: { refunded: true } },
      });
      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );
      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "should not run" }],
      });
      const wrappedHandler = paid(handler);

      const result = await wrappedHandler(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(handler).not.toHaveBeenCalled();
      expect(mockResourceServer.settlePayment).toHaveBeenCalled();
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ refunded: true }) }]);
      expect(result.structuredContent).toEqual({ refunded: true });
      expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toEqual(mockSettleResponse);
    });

    it("should pass MCP transport context through core lifecycle calls", async () => {
      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
          resource: { url: "mcp://tool/context_tool" },
        },
      );
      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "success" }],
      });
      const wrappedHandler = paid(handler);
      const extra = { _meta: { "x402/payment": mockPaymentPayload, traceId: "trace-1" } };

      await wrappedHandler({ test: "arg" }, extra);

      const expectedContext = expect.objectContaining({
        toolName: "context_tool",
        arguments: { test: "arg" },
        meta: extra._meta,
      });
      expect(mockResourceServer.createPaymentRequiredResponse).toHaveBeenCalledWith(
        [mockPaymentRequirements],
        expect.any(Object),
        undefined,
        undefined,
        expectedContext,
      );
      expect(mockResourceServer.verifyPayment).toHaveBeenCalledWith(
        mockPaymentPayload,
        mockPaymentRequirements,
        {},
        expectedContext,
      );
      expect(mockResourceServer.createPaymentCancellationDispatcher).toHaveBeenCalledWith(
        mockPaymentPayload,
        mockPaymentRequirements,
        {},
        expectedContext,
      );
      expect(mockResourceServer.settlePayment).toHaveBeenCalledWith(
        mockPaymentPayload,
        mockPaymentRequirements,
        {},
        expect.objectContaining({
          toolName: "context_tool",
          result: expect.objectContaining({
            content: [{ type: "text", text: "success" }],
          }),
        }),
      );
    });

    it("should return 402 if payment verification fails", async () => {
      mockResourceServer.verifyPayment.mockResolvedValueOnce({
        isValid: false,
        invalidReason: "Insufficient funds",
      });

      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );

      const handler = vi.fn();
      const wrappedHandler = paid(handler);
      const result = await wrappedHandler(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(mockPaymentRequired);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("accepts array validation", () => {
    it("should throw error if accepts array is empty", () => {
      expect(() =>
        createPaymentWrapper(
          mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
          {
            accepts: [],
          },
        ),
      ).toThrow("PaymentWrapperConfig.accepts must have at least one payment requirement");
    });

    it("should throw error if accepts is not provided", () => {
      expect(() =>
        createPaymentWrapper(
          mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
          {} as Parameters<typeof createPaymentWrapper>[1],
        ),
      ).toThrow("PaymentWrapperConfig.accepts must have at least one payment requirement");
    });
  });

  describe("hooks", () => {
    it("should call onBeforeExecution hook before tool execution", async () => {
      const beforeHook = vi.fn().mockResolvedValue(true);
      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
          hooks: {
            onBeforeExecution: beforeHook,
          },
        },
      );

      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "success" }],
      });

      const wrappedHandler = paid(handler);
      await wrappedHandler({ test: "arg" }, { _meta: { "x402/payment": mockPaymentPayload } });

      expect(beforeHook).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: expect.any(String),
          arguments: { test: "arg" },
          paymentPayload: mockPaymentPayload,
          paymentRequirements: mockPaymentRequirements,
        }),
      );
      expect(handler).toHaveBeenCalled();
    });

    it("should abort execution when onBeforeExecution returns false", async () => {
      const beforeHook = vi.fn().mockResolvedValue(false);
      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
          hooks: {
            onBeforeExecution: beforeHook,
          },
        },
      );

      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "success" }],
      });

      const wrappedHandler = paid(handler);
      const result = await wrappedHandler(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(beforeHook).toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeDefined();
    });

    it("should call onAfterExecution hook after tool execution", async () => {
      const afterHook = vi.fn();
      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
          hooks: {
            onAfterExecution: afterHook,
          },
        },
      );

      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "success" }],
      });

      const wrappedHandler = paid(handler);
      await wrappedHandler({ test: "arg" }, { _meta: { "x402/payment": mockPaymentPayload } });

      expect(afterHook).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: expect.any(String),
          arguments: { test: "arg" },
          paymentPayload: mockPaymentPayload,
          paymentRequirements: mockPaymentRequirements,
          result: expect.objectContaining({
            content: [{ type: "text", text: "success" }],
          }),
        }),
      );
    });

    it("should call onAfterSettlement hook after successful settlement", async () => {
      const settlementHook = vi.fn();
      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
          hooks: {
            onAfterSettlement: settlementHook,
          },
        },
      );

      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "success" }],
      });

      const wrappedHandler = paid(handler);
      await wrappedHandler({ test: "arg" }, { _meta: { "x402/payment": mockPaymentPayload } });

      expect(settlementHook).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: expect.any(String),
          arguments: { test: "arg" },
          paymentPayload: mockPaymentPayload,
          paymentRequirements: mockPaymentRequirements,
          settlement: mockSettleResponse,
        }),
      );
    });

    it("should call all hooks in correct order", async () => {
      const callOrder: string[] = [];
      const beforeHook = vi.fn(async () => {
        callOrder.push("before");
        return true;
      });
      const afterHook = vi.fn(async () => {
        callOrder.push("after");
      });
      const settlementHook = vi.fn(async () => {
        callOrder.push("settlement");
      });

      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
          hooks: {
            onBeforeExecution: beforeHook,
            onAfterExecution: afterHook,
            onAfterSettlement: settlementHook,
          },
        },
      );

      const handler = vi.fn(async () => {
        callOrder.push("handler");
        return { content: [{ type: "text" as const, text: "success" }] };
      });

      const wrappedHandler = paid(handler);
      await wrappedHandler({ test: "arg" }, { _meta: { "x402/payment": mockPaymentPayload } });

      expect(callOrder).toEqual(["before", "handler", "after", "settlement"]);
    });
  });

  describe("multiple payment requirements", () => {
    it("should use first payment requirement from accepts array", async () => {
      const alternateRequirements: PaymentRequirements = {
        scheme: "subscription",
        network: "eip155:1",
        amount: "5000",
        asset: "0xalternate",
        payTo: "0xalt",
        maxTimeoutSeconds: 120,
        extra: {},
      };

      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements, alternateRequirements],
        },
      );

      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "success" }],
      });

      const wrappedHandler = paid(handler);
      await wrappedHandler({ test: "arg" }, { _meta: { "x402/payment": mockPaymentPayload } });

      // Should verify with first requirement
      expect(mockResourceServer.verifyPayment).toHaveBeenCalledWith(
        mockPaymentPayload,
        mockPaymentRequirements,
        {},
        expect.any(Object),
      );
    });
  });

  describe("extensions", () => {
    it("should include extensions in 402 response when configured", async () => {
      const extensions = {
        bazaar: {
          info: {
            input: {
              type: "mcp",
              toolName: "test",
            },
          },
        },
      };

      const mockPaymentRequiredWithExtensions = {
        ...mockPaymentRequired,
        extensions,
      };

      mockResourceServer.createPaymentRequiredResponse.mockResolvedValueOnce(
        mockPaymentRequiredWithExtensions,
      );

      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
          extensions,
        },
      );

      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "success" }],
      });

      const wrappedHandler = paid(handler);
      const result = await wrappedHandler({ test: "arg" }, {});

      expect(result.isError).toBe(true);
      expect(mockResourceServer.createPaymentRequiredResponse).toHaveBeenCalledWith(
        [mockPaymentRequirements],
        expect.any(Object),
        "Payment required to access this tool",
        extensions,
        expect.any(Object),
        undefined,
      );
      expect((result.structuredContent as Record<string, unknown>)?.extensions).toEqual(extensions);
    });

    it("should not include extensions when not configured", async () => {
      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );

      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "success" }],
      });

      const wrappedHandler = paid(handler);
      await wrappedHandler({ test: "arg" }, {});

      expect(mockResourceServer.createPaymentRequiredResponse).toHaveBeenCalledWith(
        [mockPaymentRequirements],
        expect.any(Object),
        "Payment required to access this tool",
        undefined,
        expect.any(Object),
        undefined,
      );
    });
  });

  describe("settlement failures", () => {
    it("should return 402 error when settlement fails", async () => {
      mockResourceServer.settlePayment.mockRejectedValueOnce(new Error("Settlement failed"));

      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );

      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "success" }],
      });

      const wrappedHandler = paid(handler);
      const result = await wrappedHandler(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(handler).toHaveBeenCalled(); // Handler executed
      expect(result.isError).toBe(true); // But error returned due to settlement failure
      expect(result.structuredContent).toBeDefined();
    });
  });
});
