/**
 * Unit tests for createPaymentWrapper
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  x402ResourceServer,
  AfterSettleAbortError,
  type FacilitatorClient,
} from "@x402/core/server";
import { WorkServerScheme, type WorkJobIssuer } from "@x402/work/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkServer,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { createPaymentWrapper } from "../../src/server";
import { MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY } from "../../src/types";

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

    it("should preserve a work job through an MCP paid retry", async () => {
      const network = "quai:9" as Network;
      const issuer: WorkJobIssuer = {
        profile: "quai/sha256d-v1",
        asset: "hash",
        networks: [network],
        issue: vi.fn(async () => ({
          id: "mcp-job",
          expiresAt: Math.floor(Date.now() / 1000) + 30,
          work: { header: "native" },
        })),
      };
      const facilitator: FacilitatorClient = {
        getSupported: async () => ({
          kinds: [
            {
              x402Version: 2,
              scheme: "work",
              network,
              extra: {
                name: "x402-work",
                version: "1",
                profiles: [issuer.profile],
              },
            },
          ],
          extensions: [],
          signers: {},
        }),
        verify: async () => ({ isValid: true }),
        settle: async () => ({ success: true, transaction: "0xwork", network }),
      };
      const server = new x402ResourceServer(facilitator).register(
        network,
        new WorkServerScheme({ issuers: [issuer] }),
      );
      await server.initialize();
      const accepts = await server.buildPaymentRequirements({
        scheme: "work",
        network,
        payTo: "0x0123456789abcdef0123456789abcdef01234567",
        price: { amount: "65536", asset: "hash", extra: { profile: issuer.profile } },
      });
      const paid = createPaymentWrapper(server, { accepts });
      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "success" }],
      });
      const unpaid = await paid(handler)({ test: "arg" }, {});
      const accepted = (unpaid.structuredContent as { accepts: PaymentRequirements[] }).accepts[0];
      const payment: PaymentPayload = {
        x402Version: 2,
        accepted,
        payload: { solution: { nonce: "7" } },
      };
      const result = await paid(handler)({ test: "arg" }, { _meta: { "x402/payment": payment } });
      expect(result.isError).not.toBe(true);
      expect(handler).toHaveBeenCalledOnce();
      expect(issuer.issue).toHaveBeenCalledOnce();
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

    it("cancels without before-handler settle and rethrows when handler throws", async () => {
      const cancel = vi.fn().mockResolvedValue({
        success: true,
        amount: "0",
        transaction: "0xcancel",
        network: "eip155:84532",
      } satisfies SettleResponse);
      mockResourceServer.createPaymentCancellationDispatcher.mockReturnValue({ cancel });

      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
        },
      );
      const handlerError = new Error("handler failed");
      const wrappedHandler = paid(vi.fn().mockRejectedValue(handlerError));

      await expect(
        wrappedHandler({ test: "arg" }, { _meta: { "x402/payment": mockPaymentPayload } }),
      ).rejects.toBe(handlerError);
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it("should settle skipHandler under upfront without re-settling when handler is skipped", async () => {
      mockResourceServer.getPaymentFlow.mockReturnValue("upfront");
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
      const handler = vi.fn();
      const wrappedHandler = paid(handler);

      const result = await wrappedHandler(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(handler).not.toHaveBeenCalled();
      expect(mockResourceServer.settlePayment).not.toHaveBeenCalled();
      expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toBeUndefined();
    });

    it("should call onAfterSettlement after a successful upfront payment", async () => {
      mockResourceServer.getPaymentFlow.mockReturnValue("upfront");
      const settlementHook = vi.fn();
      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
          hooks: { onAfterSettlement: settlementHook },
        },
      );
      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "success" }],
        _meta: { traceId: "upfront_ok" },
      });
      const wrappedHandler = paid(handler);

      const result = await wrappedHandler(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(result._meta?.traceId).toBe("upfront_ok");
      expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toEqual(mockSettleResponse);
      expect(settlementHook).toHaveBeenCalledWith(
        expect.objectContaining({ settlement: mockSettleResponse }),
      );
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
        mockPaymentPayload,
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

  describe("payment matching", () => {
    it("should return 402 when no payment requirement matches the payload", async () => {
      mockResourceServer.findMatchingRequirements.mockReturnValueOnce(null);
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
      expect(handler).not.toHaveBeenCalled();
      expect(mockResourceServer.verifyPayment).not.toHaveBeenCalled();
    });

    it("should return 402 when extension validation fails", async () => {
      mockResourceServer.validateExtensions.mockReturnValueOnce({
        valid: false,
        invalidReason: "bazaar extension mismatch",
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
      expect(handler).not.toHaveBeenCalled();
      expect(mockResourceServer.verifyPayment).not.toHaveBeenCalled();
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

  describe("resource metadata", () => {
    it("should forward discovery fields into PaymentRequired resource info", async () => {
      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        {
          accepts: [mockPaymentRequirements],
          resource: {
            url: "mcp://tool/discoverable",
            description: "Discoverable tool",
            mimeType: "application/json",
            serviceName: "weather-service",
            tags: ["weather", "paid"],
            iconUrl: "https://example.com/icon.png",
          },
        },
      );

      const handler = vi.fn();
      const result = await paid(handler)({ city: "NYC" }, {});

      expect(result.isError).toBe(true);
      expect(handler).not.toHaveBeenCalled();
      expect(mockResourceServer.createPaymentRequiredResponse).toHaveBeenCalledWith(
        [mockPaymentRequirements],
        {
          url: "mcp://tool/discoverable",
          description: "Discoverable tool",
          mimeType: "application/json",
          serviceName: "weather-service",
          tags: ["weather", "paid"],
          iconUrl: "https://example.com/icon.png",
        },
        "Payment required to access this tool",
        undefined,
        expect.any(Object),
        undefined,
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

    it("should withhold tool output when settlement returns success false", async () => {
      mockResourceServer.settlePayment.mockResolvedValueOnce({
        success: false,
        errorReason: "AuthorizationAlreadyUsed",
        transaction: "",
        network: "eip155:84532",
      });

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
        content: [{ type: "text", text: "should-not-be-returned" }],
      });

      const wrappedHandler = paid(handler);
      const result = await wrappedHandler(
        { test: "arg" },
        { _meta: { "x402/payment": mockPaymentPayload } },
      );

      expect(handler).toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).not.toContain("should-not-be-returned");
      expect(JSON.stringify(result.structuredContent)).not.toContain("should-not-be-returned");
      expect(mockResourceServer.createPaymentRequiredResponse).toHaveBeenCalledWith(
        [mockPaymentRequirements],
        expect.any(Object),
        "Payment settlement failed: AuthorizationAlreadyUsed",
        undefined,
        expect.any(Object),
        undefined,
      );
      expect(settlementHook).not.toHaveBeenCalled();
    });

    it("attaches the onchain receipt when an afterSettle abort fails the settle closed", async () => {
      const mockFacilitator: FacilitatorClient = {
        verify: async () => ({ isValid: true, payer: "test-payer" }),
        settle: async () => ({
          success: true,
          transaction: "0xdeposit",
          amount: "1000",
          network: "x402:cash",
          payer: "test-payer",
        }),
        getSupported: async () => ({
          kinds: [{ x402Version: 2, scheme: "cash", network: "x402:cash" }],
          extensions: [],
          signers: {},
        }),
      };
      const scheme: SchemeNetworkServer = {
        scheme: "cash",
        defaultAssetTransferMethod: "default",
        paymentFlows: {
          default: { supported: ["authorization"], default: "authorization" },
        },
        parsePrice: async () => ({ amount: "1000", asset: "USD", extra: {} }),
        enhancePaymentRequirements: async requirements => requirements,
      };
      const server = new x402ResourceServer(mockFacilitator);
      server.register("x402:cash", scheme);
      await server.initialize();
      server.onAfterSettle(async () => {
        throw new AfterSettleAbortError("voucher_store_unavailable", "store down");
      });

      const cashRequirements: PaymentRequirements = {
        scheme: "cash",
        network: "x402:cash",
        amount: "1000",
        payTo: "test-recipient",
        asset: "",
        maxTimeoutSeconds: 0,
        extra: {},
      };
      const paid = createPaymentWrapper(server, { accepts: [cashRequirements] });
      const wrappedHandler = paid(async () => ({
        content: [{ type: "text", text: "ok" }],
      }));
      const payload: PaymentPayload = {
        x402Version: 2,
        accepted: cashRequirements,
        payload: { signature: "~test-payer" },
      };

      const result = await wrappedHandler({}, { _meta: { [MCP_PAYMENT_META_KEY]: payload } });

      expect(result.isError).toBe(true);
      expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toMatchObject({
        success: false,
        transaction: "0xdeposit",
        errorReason: "voucher_store_unavailable",
      });
    });

    it("attaches the receipt when the server and abort come from another bundled copy of core", async () => {
      const mockFacilitator: FacilitatorClient = {
        verify: async () => ({ isValid: true, payer: "test-payer" }),
        settle: async () => ({
          success: true,
          transaction: "0xdeposit",
          amount: "1000",
          network: "x402:cash",
          payer: "test-payer",
        }),
        getSupported: async () => ({
          kinds: [{ x402Version: 2, scheme: "cash", network: "x402:cash" }],
          extensions: [],
          signers: {},
        }),
      };
      const scheme: SchemeNetworkServer = {
        scheme: "cash",
        defaultAssetTransferMethod: "default",
        paymentFlows: {
          default: { supported: ["authorization"], default: "authorization" },
        },
        parsePrice: async () => ({ amount: "1000", asset: "USD", extra: {} }),
        enhancePaymentRequirements: async requirements => requirements,
      };
      vi.resetModules();
      const otherCopy = await import("@x402/core/server");
      expect(otherCopy.x402ResourceServer).not.toBe(x402ResourceServer);
      const server = new otherCopy.x402ResourceServer(mockFacilitator);
      server.register("x402:cash", scheme);
      await server.initialize();
      server.onAfterSettle(async () => {
        throw new otherCopy.AfterSettleAbortError("voucher_store_unavailable", "store down");
      });

      const cashRequirements: PaymentRequirements = {
        scheme: "cash",
        network: "x402:cash",
        amount: "1000",
        payTo: "test-recipient",
        asset: "",
        maxTimeoutSeconds: 0,
        extra: {},
      };
      const paid = createPaymentWrapper(server, { accepts: [cashRequirements] });
      const wrappedHandler = paid(async () => ({
        content: [{ type: "text", text: "ok" }],
      }));
      const payload: PaymentPayload = {
        x402Version: 2,
        accepted: cashRequirements,
        payload: { signature: "~test-payer" },
      };

      const result = await wrappedHandler({}, { _meta: { [MCP_PAYMENT_META_KEY]: payload } });

      expect(result.isError).toBe(true);
      expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toMatchObject({
        success: false,
        transaction: "0xdeposit",
        errorReason: "voucher_store_unavailable",
      });
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

  describe("corrective 402 accept snapshot", () => {
    it("does not mutate config accepts when a 402 enricher writes extra in place", async () => {
      mockResourceServer.createPaymentRequiredResponse.mockImplementation(async accepts => {
        for (const requirement of accepts) {
          requirement.extra.channelState = { chargedCumulativeAmount: "2000" };
        }
        return mockPaymentRequired;
      });
      const accepts: PaymentRequirements[] = [{ ...mockPaymentRequirements, extra: {} }];
      const paid = createPaymentWrapper(
        mockResourceServer as unknown as Parameters<typeof createPaymentWrapper>[0],
        { accepts },
      );
      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "success" }],
      });

      await paid(handler)({ test: "arg" }, {});

      expect(accepts[0].extra).toEqual({});
    });

    it("does not mutate wrapper config accepts when building a corrective 402", async () => {
      const reason = "invalid_batch_settlement_evm_cumulative_amount_mismatch";
      let verifyCalls = 0;
      let abortOnce = true;
      const mockFacilitator: FacilitatorClient = {
        verify: async () => {
          verifyCalls += 1;
          return { isValid: true, payer: "test-payer" };
        },
        settle: async () => ({
          success: true,
          transaction: "0xtx",
          network: "x402:cash",
          payer: "test-payer",
        }),
        getSupported: async () => ({
          kinds: [{ x402Version: 2, scheme: "cash", network: "x402:cash" }],
          extensions: [],
          signers: {},
        }),
      };

      let enricherCalls = 0;
      const scheme: SchemeNetworkServer = {
        scheme: "cash",
        defaultAssetTransferMethod: "default",
        paymentFlows: {
          default: { supported: ["authorization"], default: "authorization" },
        },
        parsePrice: async () => ({ amount: "1000", asset: "USD", extra: {} }),
        enhancePaymentRequirements: async requirements => requirements,
        enrichPaymentRequiredResponse: async ctx => {
          if (ctx.error !== reason || !ctx.paymentPayload) {
            return;
          }
          enricherCalls += 1;
          for (const requirement of ctx.requirements) {
            if (!requirement.extra) {
              requirement.extra = {};
            }
            requirement.extra.channelState = { chargedCumulativeAmount: "2000" };
          }
        },
      };

      const server = new x402ResourceServer(mockFacilitator);
      server.register("x402:cash", scheme);
      await server.initialize();
      server.onBeforeVerify(async () => {
        if (!abortOnce) {
          return;
        }
        abortOnce = false;
        return {
          abort: true,
          reason,
          message: "Client voucher base does not match server state",
        };
      });

      const cashRequirements = (): PaymentRequirements => ({
        scheme: "cash",
        network: "x402:cash",
        amount: "1000",
        payTo: "test-recipient",
        asset: "",
        maxTimeoutSeconds: 0,
        extra: {},
      });
      const config = { accepts: [cashRequirements()] };
      const paid = createPaymentWrapper(server, config);
      const wrappedHandler = paid(async () => ({
        content: [{ type: "text", text: "ok" }],
      }));
      const payload: PaymentPayload = {
        x402Version: 2,
        accepted: cashRequirements(),
        payload: { signature: "~test-payer" },
      };
      const extra = { _meta: { [MCP_PAYMENT_META_KEY]: payload } };

      const first = await wrappedHandler({}, extra);
      expect(first.isError).toBe(true);
      expect(enricherCalls).toBe(1);
      expect(config.accepts[0].extra).toEqual({});

      const second = await wrappedHandler({}, extra);
      expect(second.isError).toBeFalsy();
      expect(verifyCalls).toBe(1);
    });
  });
});
