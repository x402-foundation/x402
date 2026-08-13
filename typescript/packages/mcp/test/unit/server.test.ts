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
  validateExtensions: ReturnType<typeof vi.fn>;
  getRegisteredScheme: ReturnType<typeof vi.fn>;
  getPaymentFlow: ReturnType<typeof vi.fn>;
  verifyPayment: ReturnType<typeof vi.fn>;
  settlePayment: ReturnType<typeof vi.fn>;
  createPaymentRequiredResponse: ReturnType<typeof vi.fn>;
  createPaymentCancellationDispatcher: ReturnType<typeof vi.fn>;
}

const mockSchemeServer = {
  scheme: "exact",
  defaultAssetTransferMethod: "default",
  paymentFlows: {
    default: {
      supported: ["authorization", "upfront", "escrow"] as const,
      default: "authorization" as const,
    },
  },
};

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
    validateExtensions: vi.fn().mockReturnValue({ valid: true }),
    getRegisteredScheme: vi.fn().mockReturnValue(mockSchemeServer),
    getPaymentFlow: vi.fn().mockReturnValue("authorization"),
    verifyPayment: vi.fn().mockResolvedValue(mockVerifyResponse),
    settlePayment: vi.fn().mockResolvedValue(mockSettleResponse),
    createPaymentRequiredResponse: vi.fn().mockResolvedValue(mockPaymentRequired),
    createPaymentCancellationDispatcher: vi.fn().mockReturnValue({
      cancel,
    }),
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
        undefined,
        "after-handler",
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
      expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toBeUndefined();
      const dispatcher = mockResourceServer.createPaymentCancellationDispatcher.mock.results[0]
        .value as { cancel: ReturnType<typeof vi.fn> };
      expect(dispatcher.cancel).toHaveBeenCalledWith({ reason: "handler_failed" });
    });

    it("should echo before-handler settlement when tool returns error under upfront", async () => {
      mockResourceServer.getPaymentFlow.mockReturnValue("upfront");
      // verify is skipped for upfront; settle runs before handler
      mockResourceServer.settlePayment.mockResolvedValue(mockSettleResponse);

      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );

      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "error" }],
        isError: true,
        _meta: { traceId: "trace_err" },
      });

      const wrappedHandler = paid(handler);
      const result = await wrappedHandler(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(result.isError).toBe(true);
      expect(mockResourceServer.settlePayment).toHaveBeenCalledTimes(1);
      expect(mockResourceServer.settlePayment).toHaveBeenCalledWith(
        mockPaymentPayload,
        mockPaymentRequirements,
        expect.anything(),
        expect.anything(),
        undefined,
        "before-handler",
      );
      expect(result._meta?.traceId).toBe("trace_err");
      expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toEqual(mockSettleResponse);
      expect(mockResourceServer.createPaymentCancellationDispatcher).toHaveBeenCalledWith(
        mockPaymentPayload,
        mockPaymentRequirements,
        expect.anything(),
        expect.anything(),
        ["before-handler"],
      );
      const dispatcher = mockResourceServer.createPaymentCancellationDispatcher.mock.results[0]
        .value as { cancel: ReturnType<typeof vi.fn> };
      expect(dispatcher.cancel).toHaveBeenCalledWith({ reason: "handler_failed" });
    });

    it("should return 402 when before-handler settlement fails under upfront", async () => {
      mockResourceServer.getPaymentFlow.mockReturnValue("upfront");
      mockResourceServer.settlePayment.mockResolvedValue({
        success: false,
        errorReason: "insufficient_funds",
        transaction: "",
        network: "eip155:84532",
      });

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

      expect(handler).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(mockResourceServer.settlePayment).toHaveBeenCalledTimes(1);
      expect(mockResourceServer.settlePayment).toHaveBeenCalledWith(
        mockPaymentPayload,
        mockPaymentRequirements,
        expect.anything(),
        expect.anything(),
        undefined,
        "before-handler",
      );
      expect(mockResourceServer.createPaymentRequiredResponse).toHaveBeenCalledWith(
        [mockPaymentRequirements],
        expect.any(Object),
        "Payment settlement failed: insufficient_funds",
        undefined,
        expect.any(Object),
        undefined,
      );
      expect(mockResourceServer.createPaymentCancellationDispatcher).not.toHaveBeenCalled();
    });

    it("should return 402 when before-handler settlement throws under upfront", async () => {
      mockResourceServer.getPaymentFlow.mockReturnValue("upfront");
      mockResourceServer.settlePayment.mockRejectedValue(new Error("facilitator unavailable"));

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

      expect(handler).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(mockResourceServer.createPaymentRequiredResponse).toHaveBeenCalledWith(
        [mockPaymentRequirements],
        expect.any(Object),
        "Payment settlement failed: Settlement failed",
        undefined,
        expect.any(Object),
        undefined,
      );
      expect(mockResourceServer.createPaymentCancellationDispatcher).not.toHaveBeenCalled();
    });

    it("should settle before and after handler under escrow", async () => {
      mockResourceServer.getPaymentFlow.mockReturnValue("escrow");
      mockResourceServer.settlePayment
        .mockResolvedValueOnce({
          ...mockSettleResponse,
          transaction: "0xdeposit",
        })
        .mockResolvedValueOnce({
          ...mockSettleResponse,
          transaction: "0xcharge",
        });

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

      expect(handler).toHaveBeenCalled();
      expect(mockResourceServer.verifyPayment).toHaveBeenCalled();
      expect(mockResourceServer.settlePayment).toHaveBeenCalledTimes(2);
      expect(mockResourceServer.settlePayment).toHaveBeenNthCalledWith(
        1,
        mockPaymentPayload,
        mockPaymentRequirements,
        expect.anything(),
        expect.anything(),
        undefined,
        "before-handler",
      );
      expect(mockResourceServer.settlePayment).toHaveBeenNthCalledWith(
        2,
        mockPaymentPayload,
        mockPaymentRequirements,
        expect.anything(),
        expect.anything(),
        undefined,
        "after-handler",
      );
      expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toEqual({
        ...mockSettleResponse,
        transaction: "0xcharge",
      });
      expect(mockResourceServer.createPaymentCancellationDispatcher).toHaveBeenCalledWith(
        mockPaymentPayload,
        mockPaymentRequirements,
        expect.anything(),
        expect.anything(),
        ["before-handler"],
      );
    });

    it("should cancel with before-handler settledPhases and echo receipt when escrow tool errors", async () => {
      mockResourceServer.getPaymentFlow.mockReturnValue("escrow");
      mockResourceServer.settlePayment.mockResolvedValue({
        ...mockSettleResponse,
        transaction: "0xdeposit",
      });

      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );

      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "error" }],
        isError: true,
        _meta: { traceId: "trace_escrow_err" },
      });

      const wrappedHandler = paid(handler);
      const result = await wrappedHandler(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(result.isError).toBe(true);
      expect(mockResourceServer.settlePayment).toHaveBeenCalledTimes(1);
      expect(mockResourceServer.settlePayment).toHaveBeenCalledWith(
        mockPaymentPayload,
        mockPaymentRequirements,
        expect.anything(),
        expect.anything(),
        undefined,
        "before-handler",
      );
      expect(result._meta?.traceId).toBe("trace_escrow_err");
      expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toEqual({
        ...mockSettleResponse,
        transaction: "0xdeposit",
      });
      expect(mockResourceServer.createPaymentCancellationDispatcher).toHaveBeenCalledWith(
        mockPaymentPayload,
        mockPaymentRequirements,
        expect.anything(),
        expect.anything(),
        ["before-handler"],
      );
      const dispatcher = mockResourceServer.createPaymentCancellationDispatcher.mock.results[0]
        .value as { cancel: ReturnType<typeof vi.fn> };
      expect(dispatcher.cancel).toHaveBeenCalledWith({ reason: "handler_failed" });
    });

    it("prefers cancel refund receipt over deposit echo when tool returns error", async () => {
      mockResourceServer.getPaymentFlow.mockReturnValue("escrow");
      mockResourceServer.settlePayment.mockResolvedValue({
        ...mockSettleResponse,
        amount: "100000",
        transaction: "0xdeposit",
      });
      const cancelReceipt: SettleResponse = {
        success: true,
        amount: "0",
        transaction: "0xrefund",
        network: "eip155:84532",
      };
      mockResourceServer.createPaymentCancellationDispatcher.mockReturnValue({
        cancel: vi.fn().mockResolvedValue(cancelReceipt),
      });

      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );

      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "error" }],
        isError: true,
        _meta: { traceId: "trace_refund" },
      });

      const wrappedHandler = paid(handler);
      const result = await wrappedHandler(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(result.isError).toBe(true);
      expect(result._meta?.traceId).toBe("trace_refund");
      expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toEqual(cancelReceipt);
      expect(mockResourceServer.settlePayment).toHaveBeenCalledTimes(1);
    });

    it("surfaces failed cancel with deposit recovery extra when tool returns error", async () => {
      mockResourceServer.getPaymentFlow.mockReturnValue("escrow");
      mockResourceServer.settlePayment.mockResolvedValue({
        ...mockSettleResponse,
        amount: "100000",
        transaction: "0xdeposit",
      });
      mockResourceServer.createPaymentCancellationDispatcher.mockReturnValue({
        cancel: vi.fn().mockResolvedValue({
          success: false,
          errorReason: "refund_failed",
          transaction: "should-not-appear",
          network: "eip155:84532",
        }),
      });
      const paymentPayload: PaymentPayload = {
        ...mockPaymentPayload,
        payload: { channelId: "channel-123" },
      };

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
        { _meta: { "x402/payment": paymentPayload } },
      );

      expect(result.isError).toBe(true);
      expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toEqual({
        success: false,
        errorReason: "refund_failed",
        errorMessage: undefined,
        payer: undefined,
        transaction: "",
        network: "eip155:84532",
        extensions: undefined,
        extra: {
          depositTransaction: "0xdeposit",
          depositAmount: "100000",
          channelId: "channel-123",
        },
      });
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

    it("should echo before-handler settlement when tool handler throws under upfront", async () => {
      mockResourceServer.getPaymentFlow.mockReturnValue("upfront");
      mockResourceServer.settlePayment.mockResolvedValue(mockSettleResponse);

      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );
      const error = new Error("handler failed");
      const handler = vi.fn().mockRejectedValue(error);
      const wrappedHandler = paid(handler);

      const result = await wrappedHandler(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "Internal Server Error" }]);
      expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toEqual(mockSettleResponse);
      expect(mockResourceServer.settlePayment).toHaveBeenCalledTimes(1);
      const dispatcher = mockResourceServer.createPaymentCancellationDispatcher.mock.results[0]
        .value as { cancel: ReturnType<typeof vi.fn> };
      expect(dispatcher.cancel).toHaveBeenCalledWith({
        reason: "handler_threw",
        error,
      });
    });

    it("prefers cancel refund receipt over deposit echo when tool handler throws", async () => {
      mockResourceServer.getPaymentFlow.mockReturnValue("escrow");
      mockResourceServer.settlePayment.mockResolvedValue({
        ...mockSettleResponse,
        amount: "100000",
        transaction: "0xdeposit",
      });
      const cancelReceipt: SettleResponse = {
        success: true,
        amount: "0",
        transaction: "0xrefund",
        network: "eip155:84532",
      };
      mockResourceServer.createPaymentCancellationDispatcher.mockReturnValue({
        cancel: vi.fn().mockResolvedValue(cancelReceipt),
      });

      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );
      const handler = vi.fn().mockRejectedValue(new Error("handler failed"));
      const wrappedHandler = paid(handler);

      const result = await wrappedHandler(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "Internal Server Error" }]);
      expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toEqual(cancelReceipt);
    });

    it("returns internal error with cancel receipt when handler throws without before-handler settle", async () => {
      const cancelReceipt: SettleResponse = {
        success: true,
        amount: "0",
        transaction: "0xrefund",
        network: "eip155:84532",
      };
      mockResourceServer.createPaymentCancellationDispatcher.mockReturnValue({
        cancel: vi.fn().mockResolvedValue(cancelReceipt),
      });

      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );
      const handler = vi.fn().mockRejectedValue(new Error("handler failed"));
      const wrappedHandler = paid(handler);

      const result = await wrappedHandler(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "Internal Server Error" }]);
      expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toEqual(cancelReceipt);
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
        [],
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
        undefined,
        "after-handler",
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

    it("should throw at creation for unsupported paymentFlow", () => {
      expect(() =>
        createPaymentWrapper(
          mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
          {
            accepts: [
              {
                ...mockPaymentRequirements,
                extra: { paymentFlow: "not-a-real-flow" },
              },
            ],
          },
        ),
      ).toThrow(/does not support paymentFlow/);
    });

    it("should throw at creation when scheme is not registered", () => {
      mockResourceServer.getRegisteredScheme.mockReturnValueOnce(undefined);
      expect(() =>
        createPaymentWrapper(
          mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
          {
            accepts: [mockPaymentRequirements],
          },
        ),
      ).toThrow(/No scheme implementation registered/);
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

  describe("unexpected errors", () => {
    it("returns a generic Internal Server Error without leaking internals", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mockResourceServer.getPaymentFlow.mockImplementationOnce(() => {
        throw new Error('[x402] Scheme "exact" does not support paymentFlow "escrow"');
      });

      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );

      const handler = vi.fn();
      const result = await paid(handler)(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "Internal Server Error" }]);
      expect(JSON.stringify(result)).not.toContain("does not support paymentFlow");
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });
});
