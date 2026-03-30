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
  return {
    findMatchingRequirements: vi.fn().mockReturnValue(mockPaymentRequirements),
    verifyPayment: vi.fn().mockResolvedValue(mockVerifyResponse),
    settlePayment: vi.fn().mockResolvedValue(mockSettleResponse),
    createPaymentRequiredResponse: vi.fn().mockResolvedValue(mockPaymentRequired),
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
        return { content: [{ type: "text", text: "success" }] };
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
