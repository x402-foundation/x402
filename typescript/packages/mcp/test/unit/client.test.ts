/**
 * Unit tests for x402MCPClient
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { x402MCPClient, createx402MCPClient, wrapMCPClientWithPayment } from "../../src/client";
import {
  MCP_PAYMENT_REQUIRED_CODE,
  MCP_PAYMENT_META_KEY,
  JSONRPC_PAYMENT_REQUIRED_CODE,
} from "../../src/types";
import type { PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";

// ============================================================================
// Mock Types
// ============================================================================

interface MockMCPClient {
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  listResources: ReturnType<typeof vi.fn>;
  listPrompts: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
}

interface MockPaymentClient {
  createPaymentPayload: ReturnType<typeof vi.fn>;
  handlePaymentResponse: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  registerV1: ReturnType<typeof vi.fn>;
}

// ============================================================================
// Test Fixtures
// ============================================================================

const mockPaymentRequired: PaymentRequired = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000",
      asset: "0xtoken",
      payTo: "0xrecipient",
      maxTimeoutSeconds: 60,
      extra: {},
    },
  ],
  error: "Payment required",
  resource: {
    url: "mcp://tool/test",
    description: "Test tool",
    mimeType: "application/json",
  },
};

const mockPaymentPayload: PaymentPayload = {
  x402Version: 2,
  accepted: mockPaymentRequired.accepts[0],
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

const mockSettleResponse: SettleResponse = {
  success: true,
  transaction: "0xtxhash123",
  network: "eip155:84532",
};

/**
 * V1 PaymentRequired for interoperability testing (ethanniser/x402-mcp style)
 */
const mockPaymentRequiredV1 = {
  x402Version: 1,
  error: "Payment required",
  accepts: [
    {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000",
      asset: "0xtoken",
      payTo: "0xrecipient",
      maxTimeoutSeconds: 60,
      resource: "mcp://tool/test",
      mimeType: "application/json",
      description: "Test tool",
      extra: {},
    },
  ],
};

/**
 * Creates a PaymentRequired response in content format (per MCP transport spec)
 *
 * @param paymentRequired - The payment required object
 * @returns MCP tool result with direct PaymentRequired in content
 */
function createEmbeddedPaymentError(paymentRequired: PaymentRequired): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(paymentRequired),
      },
    ],
    isError: true,
  };
}

/**
 * Creates a structuredContent response with direct PaymentRequired (ethanniser/x402-mcp style)
 *
 * @param paymentRequired - The payment required object
 * @returns MCP tool result with structuredContent
 */
function createStructuredContentDirectPaymentError(
  paymentRequired: PaymentRequired | typeof mockPaymentRequiredV1,
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: true;
} {
  return {
    structuredContent: paymentRequired as Record<string, unknown>,
    content: [{ type: "text", text: JSON.stringify(paymentRequired) }],
    isError: true,
  };
}

/**
 * Creates a content-only response with direct PaymentRequired (V1 compatibility fallback)
 *
 * @param paymentRequired - The payment required object
 * @returns MCP tool result with content fallback
 */
function createContentDirectPaymentError(
  paymentRequired: PaymentRequired | typeof mockPaymentRequiredV1,
): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(paymentRequired) }],
    isError: true,
  };
}

// ============================================================================
// Mock Factories
// ============================================================================

/**
 * Creates a mock MCP client for testing
 *
 * @returns Mock MCP client instance
 */
function createMockMCPClient(): MockMCPClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    listResources: vi.fn().mockResolvedValue({ resources: [] }),
    listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
    callTool: vi.fn(),
  };
}

/**
 * Creates a mock x402 payment client for testing
 *
 * @returns Mock payment client instance
 */
function createMockPaymentClient(): MockPaymentClient {
  return {
    createPaymentPayload: vi.fn().mockResolvedValue(mockPaymentPayload),
    handlePaymentResponse: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockReturnThis(),
    registerV1: vi.fn().mockReturnThis(),
  };
}

// ============================================================================
// x402MCPClient Tests
// ============================================================================

describe("x402MCPClient", () => {
  let mockMcpClient: MockMCPClient;
  let mockPaymentClient: MockPaymentClient;
  let client: x402MCPClient;

  beforeEach(() => {
    mockMcpClient = createMockMCPClient();
    mockPaymentClient = createMockPaymentClient();
    client = new x402MCPClient(
      mockMcpClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[0],
      mockPaymentClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[1],
    );
  });

  describe("constructor and accessors", () => {
    it("should expose underlying MCP client", () => {
      expect(client.client).toBe(mockMcpClient);
    });

    it("should expose underlying payment client", () => {
      expect(client.paymentClient).toBe(mockPaymentClient);
    });

    it("should default autoPayment to true", async () => {
      // Test by calling a paid tool - should auto-pay
      mockMcpClient.callTool
        .mockResolvedValueOnce(createEmbeddedPaymentError(mockPaymentRequired))
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "success" }],
          _meta: { "x402/payment-response": mockSettleResponse },
        });

      // Should not throw because autoPayment is enabled
      await expect(client.callTool("test")).resolves.toBeDefined();
    });
  });

  describe("passthrough methods", () => {
    it("should passthrough connect()", async () => {
      const transport = {} as Parameters<typeof client.connect>[0];
      await client.connect(transport);
      expect(mockMcpClient.connect).toHaveBeenCalledWith(transport);
    });

    it("should passthrough close()", async () => {
      await client.close();
      expect(mockMcpClient.close).toHaveBeenCalled();
    });

    it("should passthrough listTools()", async () => {
      const tools = { tools: [{ name: "test", description: "Test tool" }] };
      mockMcpClient.listTools.mockResolvedValue(tools);

      const result = await client.listTools();
      expect(result).toEqual(tools);
      expect(mockMcpClient.listTools).toHaveBeenCalled();
    });

    it("should passthrough listResources()", async () => {
      await client.listResources();
      expect(mockMcpClient.listResources).toHaveBeenCalled();
    });

    it("should passthrough listPrompts()", async () => {
      await client.listPrompts();
      expect(mockMcpClient.listPrompts).toHaveBeenCalled();
    });
  });

  describe("callTool - free tools", () => {
    it("should call free tool without payment", async () => {
      mockMcpClient.callTool.mockResolvedValue({
        content: [{ type: "text", text: "pong" }],
        isError: false,
      });

      const result = await client.callTool("ping");

      expect(result.paymentMade).toBe(false);
      expect(result.content[0]?.text).toBe("pong");
      expect(mockMcpClient.callTool).toHaveBeenCalledTimes(1);
    });
  });

  describe("callTool - paid tools with autoPayment", () => {
    it("should auto-pay and retry on 402", async () => {
      // First call returns 402, second call with payment succeeds
      mockMcpClient.callTool
        .mockResolvedValueOnce(createEmbeddedPaymentError(mockPaymentRequired))
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "paid result" }],
          _meta: { "x402/payment-response": mockSettleResponse },
        });

      const result = await client.callTool("paid_tool", { arg: "value" });

      expect(result.paymentMade).toBe(true);
      expect(result.content[0]?.text).toBe("paid result");
      expect(result.paymentResponse).toEqual(mockSettleResponse);
      expect(mockMcpClient.callTool).toHaveBeenCalledTimes(2);
      expect(mockPaymentClient.createPaymentPayload).toHaveBeenCalledWith(mockPaymentRequired);
    });

    it("should include payment in _meta on retry", async () => {
      mockMcpClient.callTool
        .mockResolvedValueOnce(createEmbeddedPaymentError(mockPaymentRequired))
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "result" }],
        });

      await client.callTool("paid_tool");

      // Second call should include payment in _meta
      const secondCall = mockMcpClient.callTool.mock.calls[1][0];
      expect(secondCall._meta?.[MCP_PAYMENT_META_KEY]).toEqual(mockPaymentPayload);
    });
  });

  describe("callTool - paid tools without autoPayment", () => {
    beforeEach(() => {
      client = new x402MCPClient(
        mockMcpClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[0],
        mockPaymentClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[1],
        { autoPayment: false },
      );
    });

    it("should throw with payment info when autoPayment is disabled", async () => {
      mockMcpClient.callTool.mockResolvedValue(createEmbeddedPaymentError(mockPaymentRequired));

      await expect(client.callTool("paid_tool")).rejects.toMatchObject({
        message: "Payment required",
        code: MCP_PAYMENT_REQUIRED_CODE,
        paymentRequired: mockPaymentRequired,
      });
    });
  });

  describe("callTool - approval flow", () => {
    it("should call onPaymentRequested hook", async () => {
      const approvalHook = vi.fn().mockResolvedValue(true);
      client = new x402MCPClient(
        mockMcpClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[0],
        mockPaymentClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[1],
        { autoPayment: true, onPaymentRequested: approvalHook },
      );

      mockMcpClient.callTool
        .mockResolvedValueOnce(createEmbeddedPaymentError(mockPaymentRequired))
        .mockResolvedValueOnce({ content: [{ type: "text", text: "result" }] });

      await client.callTool("paid_tool", { arg: "value" });

      expect(approvalHook).toHaveBeenCalledWith({
        toolName: "paid_tool",
        arguments: { arg: "value" },
        paymentRequired: mockPaymentRequired,
      });
    });

    it("should throw if payment request is denied", async () => {
      const approvalHook = vi.fn().mockResolvedValue(false);
      client = new x402MCPClient(
        mockMcpClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[0],
        mockPaymentClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[1],
        { autoPayment: true, onPaymentRequested: approvalHook },
      );

      mockMcpClient.callTool.mockResolvedValue(createEmbeddedPaymentError(mockPaymentRequired));

      await expect(client.callTool("paid_tool")).rejects.toThrow("Payment request denied");
    });
  });

  describe("hooks", () => {
    it("should call beforePayment hooks", async () => {
      const beforeHook = vi.fn();
      client.onBeforePayment(beforeHook);

      mockMcpClient.callTool
        .mockResolvedValueOnce(createEmbeddedPaymentError(mockPaymentRequired))
        .mockResolvedValueOnce({ content: [{ type: "text", text: "result" }] });

      await client.callTool("paid_tool");

      expect(beforeHook).toHaveBeenCalledWith({
        toolName: "paid_tool",
        arguments: {},
        paymentRequired: mockPaymentRequired,
      });
    });

    it("should call afterPayment hooks", async () => {
      const afterHook = vi.fn();
      client.onAfterPayment(afterHook);

      mockMcpClient.callTool
        .mockResolvedValueOnce(createEmbeddedPaymentError(mockPaymentRequired))
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "result" }],
          _meta: { "x402/payment-response": mockSettleResponse },
        });

      await client.callTool("paid_tool");

      expect(afterHook).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "paid_tool",
          paymentPayload: mockPaymentPayload,
          settleResponse: mockSettleResponse,
        }),
      );
    });

    it("should call core payment response hooks with settlement metadata", async () => {
      mockMcpClient.callTool
        .mockResolvedValueOnce(createEmbeddedPaymentError(mockPaymentRequired))
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "result" }],
          _meta: { "x402/payment-response": mockSettleResponse },
        });

      await client.callTool("paid_tool");

      expect(mockPaymentClient.handlePaymentResponse).toHaveBeenCalledWith({
        paymentPayload: mockPaymentPayload,
        requirements: mockPaymentPayload.accepted,
        settleResponse: mockSettleResponse,
      });
    });

    it("should retry once with a fresh payload when core hook recovers", async () => {
      const correctivePaymentRequired: PaymentRequired = {
        ...mockPaymentRequired,
        accepts: [
          {
            ...mockPaymentRequired.accepts[0],
            extra: {
              ...mockPaymentRequired.accepts[0].extra,
              channelState: { chargedCumulativeAmount: "2000" },
            },
          },
        ],
      };
      const freshPayload: PaymentPayload = {
        ...mockPaymentPayload,
        payload: { ...mockPaymentPayload.payload, signature: "0xfresh" },
      };
      mockPaymentClient.createPaymentPayload
        .mockResolvedValueOnce(mockPaymentPayload)
        .mockResolvedValueOnce(freshPayload);
      mockPaymentClient.handlePaymentResponse
        .mockResolvedValueOnce({ recovered: true })
        .mockResolvedValueOnce(undefined);
      mockMcpClient.callTool
        .mockResolvedValueOnce(createEmbeddedPaymentError(mockPaymentRequired))
        .mockResolvedValueOnce(createEmbeddedPaymentError(correctivePaymentRequired))
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "recovered result" }],
          _meta: { "x402/payment-response": mockSettleResponse },
        });

      const result = await client.callTool("paid_tool");

      expect(result.content[0]?.text).toBe("recovered result");
      expect(mockMcpClient.callTool).toHaveBeenCalledTimes(3);
      expect(mockPaymentClient.createPaymentPayload).toHaveBeenCalledTimes(2);
      expect(mockPaymentClient.createPaymentPayload).toHaveBeenNthCalledWith(
        2,
        correctivePaymentRequired,
      );
      expect(mockPaymentClient.handlePaymentResponse).toHaveBeenCalledTimes(2);
      expect(mockPaymentClient.handlePaymentResponse).toHaveBeenNthCalledWith(1, {
        paymentPayload: mockPaymentPayload,
        requirements: mockPaymentPayload.accepted,
        paymentRequired: correctivePaymentRequired,
      });
      const retryCall = mockMcpClient.callTool.mock.calls[2][0];
      expect(retryCall._meta?.[MCP_PAYMENT_META_KEY]).toEqual(freshPayload);
    });

    it("should support chaining hooks", () => {
      const result = client.onBeforePayment(() => {}).onAfterPayment(() => {});
      expect(result).toBe(client);
    });
  });

  describe("callToolWithPayment", () => {
    it("should call tool with explicit payment", async () => {
      mockMcpClient.callTool.mockResolvedValue({
        content: [{ type: "text", text: "result" }],
        _meta: { "x402/payment-response": mockSettleResponse },
      });

      const result = await client.callToolWithPayment("tool", { arg: "value" }, mockPaymentPayload);

      expect(result.paymentMade).toBe(true);
      expect(result.paymentResponse).toEqual(mockSettleResponse);

      const callArgs = mockMcpClient.callTool.mock.calls[0][0];
      expect(callArgs._meta?.[MCP_PAYMENT_META_KEY]).toEqual(mockPaymentPayload);
    });
  });

  describe("getToolPaymentRequirements", () => {
    it("should return payment requirements for paid tools", async () => {
      mockMcpClient.callTool.mockResolvedValue(createEmbeddedPaymentError(mockPaymentRequired));

      const result = await client.getToolPaymentRequirements("paid_tool");

      expect(result).toEqual(mockPaymentRequired);
    });

    it("should return null for free tools", async () => {
      mockMcpClient.callTool.mockResolvedValue({
        content: [{ type: "text", text: "result" }],
        isError: false,
      });

      const result = await client.getToolPaymentRequirements("free_tool");

      expect(result).toBeNull();
    });
  });
});

// ============================================================================
// Factory Function Tests
// ============================================================================

describe("wrapMCPClientWithPayment", () => {
  it("should create x402MCPClient instance", () => {
    const mockMcpClient = createMockMCPClient();
    const mockPaymentClient = createMockPaymentClient();

    const client = wrapMCPClientWithPayment(
      mockMcpClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[0],
      mockPaymentClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[1],
    );

    expect(client).toBeInstanceOf(x402MCPClient);
  });
});

describe("createx402MCPClient", () => {
  it("should create client with config", () => {
    const mockSchemeClient = {
      createPaymentPayload: vi.fn(),
    };

    const client = createx402MCPClient({
      name: "test-client",
      version: "1.0.0",
      schemes: [
        {
          network: "eip155:84532",
          client: mockSchemeClient as unknown as Parameters<
            typeof createx402MCPClient
          >[0]["schemes"][0]["client"],
        },
      ],
    });

    expect(client).toBeInstanceOf(x402MCPClient);
  });
});

// ============================================================================
// Response Format Interoperability Tests
// ============================================================================

describe("x402MCPClient response format interoperability", () => {
  let mockMcpClient: MockMCPClient;
  let mockPaymentClient: MockPaymentClient;
  let client: x402MCPClient;

  beforeEach(() => {
    mockMcpClient = createMockMCPClient();
    mockPaymentClient = createMockPaymentClient();
    client = new x402MCPClient(
      mockMcpClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[0],
      mockPaymentClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[1],
    );
  });

  describe("structuredContent formats", () => {
    it("should parse structuredContent with direct PaymentRequired V2", async () => {
      mockMcpClient.callTool
        .mockResolvedValueOnce(createStructuredContentDirectPaymentError(mockPaymentRequired))
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "success" }],
          _meta: { "x402/payment-response": mockSettleResponse },
        });

      const result = await client.callTool("paid_tool");

      expect(result.paymentMade).toBe(true);
      expect(mockPaymentClient.createPaymentPayload).toHaveBeenCalledWith(mockPaymentRequired);
    });

    it("should parse structuredContent with direct PaymentRequired V1 (ethanniser/x402-mcp style)", async () => {
      mockMcpClient.callTool
        .mockResolvedValueOnce(createStructuredContentDirectPaymentError(mockPaymentRequiredV1))
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "success" }],
          _meta: { "x402/payment-response": mockSettleResponse },
        });

      const result = await client.callTool("paid_tool");

      expect(result.paymentMade).toBe(true);
      expect(mockPaymentClient.createPaymentPayload).toHaveBeenCalledWith(mockPaymentRequiredV1);
    });
  });

  describe("content fallback formats", () => {
    it("should parse content with direct PaymentRequired V2", async () => {
      mockMcpClient.callTool
        .mockResolvedValueOnce(createContentDirectPaymentError(mockPaymentRequired))
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "success" }],
          _meta: { "x402/payment-response": mockSettleResponse },
        });

      const result = await client.callTool("paid_tool");

      expect(result.paymentMade).toBe(true);
      expect(mockPaymentClient.createPaymentPayload).toHaveBeenCalledWith(mockPaymentRequired);
    });

    it("should parse content with direct PaymentRequired V1 (no wrapper)", async () => {
      mockMcpClient.callTool
        .mockResolvedValueOnce(createContentDirectPaymentError(mockPaymentRequiredV1))
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "success" }],
          _meta: { "x402/payment-response": mockSettleResponse },
        });

      const result = await client.callTool("paid_tool");

      expect(result.paymentMade).toBe(true);
      expect(mockPaymentClient.createPaymentPayload).toHaveBeenCalledWith(mockPaymentRequiredV1);
    });
  });

  describe("priority order", () => {
    it("should prefer structuredContent over content fallback", async () => {
      const contentFallbackPaymentRequired = {
        ...mockPaymentRequired,
        error: "From content fallback",
      };
      const mixedResponse = {
        structuredContent: mockPaymentRequired as Record<string, unknown>,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(contentFallbackPaymentRequired),
          },
        ],
        isError: true as const,
      };

      mockMcpClient.callTool.mockResolvedValueOnce(mixedResponse).mockResolvedValueOnce({
        content: [{ type: "text", text: "success" }],
        _meta: { "x402/payment-response": mockSettleResponse },
      });

      const result = await client.callTool("paid_tool");

      expect(result.paymentMade).toBe(true);
      // Should use the structuredContent version (original mockPaymentRequired)
      expect(mockPaymentClient.createPaymentPayload).toHaveBeenCalledWith(mockPaymentRequired);
    });
  });

  describe("getToolPaymentRequirements with different formats", () => {
    it("should extract requirements from structuredContent format", async () => {
      mockMcpClient.callTool.mockResolvedValue(
        createStructuredContentDirectPaymentError(mockPaymentRequired),
      );

      const result = await client.getToolPaymentRequirements("paid_tool");

      expect(result).toEqual(mockPaymentRequired);
    });

    it("should extract V1 requirements from structuredContent format", async () => {
      mockMcpClient.callTool.mockResolvedValue(
        createStructuredContentDirectPaymentError(mockPaymentRequiredV1),
      );

      const result = await client.getToolPaymentRequirements("paid_tool");

      expect(result).toEqual(mockPaymentRequiredV1);
    });
  });
});

// ============================================================================
// onPaymentRequired Hook Tests
// ============================================================================

describe("x402MCPClient onPaymentRequired hook", () => {
  let mockMcpClient: ReturnType<typeof createMockMCPClient>;
  let mockPaymentClient: ReturnType<typeof createMockPaymentClient>;
  let client: x402MCPClient;

  beforeEach(() => {
    mockMcpClient = createMockMCPClient();
    mockPaymentClient = createMockPaymentClient();

    client = new x402MCPClient(
      mockMcpClient as unknown as ConstructorParameters<typeof x402MCPClient>[0],
      mockPaymentClient as unknown as ConstructorParameters<typeof x402MCPClient>[1],
      { autoPayment: true },
    );
  });

  it("should call hook when payment required is received", async () => {
    const hook = vi.fn();
    client.onPaymentRequired(hook);

    // First call returns 402
    mockMcpClient.callTool.mockResolvedValueOnce(createEmbeddedPaymentError(mockPaymentRequired));
    // Second call (with payment) returns success
    mockMcpClient.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "result" }],
      _meta: { "x402/payment-response": mockSettleResponse },
    });

    await client.callTool("tool", { arg: "value" });

    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "tool",
        arguments: { arg: "value" },
        paymentRequired: mockPaymentRequired,
      }),
    );
  });

  it("should use hook-provided payment instead of auto-generating", async () => {
    const customPayment = {
      ...mockPaymentPayload,
      payload: { ...mockPaymentPayload.payload, signature: "0xcustom" },
    };
    client.onPaymentRequired(() => ({ payment: customPayment }));

    // First call returns 402
    mockMcpClient.callTool.mockResolvedValueOnce(createEmbeddedPaymentError(mockPaymentRequired));
    // Second call (with payment) returns success
    mockMcpClient.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "result" }],
      _meta: { "x402/payment-response": mockSettleResponse },
    });

    await client.callTool("tool", {});

    // Should not auto-generate payment
    expect(mockPaymentClient.createPaymentPayload).not.toHaveBeenCalled();

    // Should use custom payment
    const callArgs = mockMcpClient.callTool.mock.calls[1][0];
    expect(callArgs._meta?.[MCP_PAYMENT_META_KEY]).toEqual(customPayment);
  });

  it("should abort payment when hook returns abort: true", async () => {
    client.onPaymentRequired(() => ({ abort: true }));

    mockMcpClient.callTool.mockResolvedValueOnce(createEmbeddedPaymentError(mockPaymentRequired));

    await expect(client.callTool("tool", {})).rejects.toThrow("Payment aborted by hook");
  });

  it("should continue to next hook if first returns void", async () => {
    const hook1 = vi.fn();
    const hook2 = vi.fn().mockReturnValue({ abort: true });

    client.onPaymentRequired(hook1).onPaymentRequired(hook2);

    mockMcpClient.callTool.mockResolvedValueOnce(createEmbeddedPaymentError(mockPaymentRequired));

    await expect(client.callTool("tool", {})).rejects.toThrow("Payment aborted by hook");

    expect(hook1).toHaveBeenCalled();
    expect(hook2).toHaveBeenCalled();
  });

  it("should return this for method chaining", () => {
    const result = client.onPaymentRequired(() => {});
    expect(result).toBe(client);
  });
});

// ============================================================================
// McpError(-32042) Payment Error Tests
// ============================================================================

/**
 * Creates a mock McpError(-32042) with PaymentRequired in error.data
 *
 * @param data - The error data payload
 * @returns A mock McpError with code -32042
 */
function createMcpError32042(
  data: Record<string, unknown>,
): Error & { code: number; data: Record<string, unknown> } {
  const err = new Error("Payment Required") as Error & {
    code: number;
    data: Record<string, unknown>;
  };
  err.code = JSONRPC_PAYMENT_REQUIRED_CODE;
  err.data = data;
  return err;
}

describe("x402MCPClient McpError(-32042) handling", () => {
  let mockMcpClient: MockMCPClient;
  let mockPaymentClient: MockPaymentClient;
  let client: x402MCPClient;

  beforeEach(() => {
    mockMcpClient = createMockMCPClient();
    mockPaymentClient = createMockPaymentClient();
    client = new x402MCPClient(
      mockMcpClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[0],
      mockPaymentClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[1],
    );
  });

  describe("callTool with thrown -32042 errors", () => {
    it("should handle -32042 with direct PaymentRequired in error.data", async () => {
      mockMcpClient.callTool
        .mockRejectedValueOnce(
          createMcpError32042(mockPaymentRequired as unknown as Record<string, unknown>),
        )
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "paid result" }],
          _meta: { "x402/payment-response": mockSettleResponse },
        });

      const result = await client.callTool("paid_tool", { arg: "value" });

      expect(result.paymentMade).toBe(true);
      expect(result.content[0]?.text).toBe("paid result");
      expect(result.paymentResponse).toEqual(mockSettleResponse);
      expect(mockMcpClient.callTool).toHaveBeenCalledTimes(2);
      expect(mockPaymentClient.createPaymentPayload).toHaveBeenCalledWith(mockPaymentRequired);
    });

    it("should handle -32042 with PaymentRequired namespaced under error.data.x402", async () => {
      const namespacedData = {
        challenges: [{ method: "tempo", intent: "charge" }],
        x402: mockPaymentRequired,
      };
      mockMcpClient.callTool
        .mockRejectedValueOnce(
          createMcpError32042(namespacedData as unknown as Record<string, unknown>),
        )
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "paid result" }],
          _meta: { "x402/payment-response": mockSettleResponse },
        });

      const result = await client.callTool("paid_tool");

      expect(result.paymentMade).toBe(true);
      expect(mockPaymentClient.createPaymentPayload).toHaveBeenCalledWith(mockPaymentRequired);
    });

    it("should re-throw non-payment errors", async () => {
      const genericError = new Error("Some other error");
      mockMcpClient.callTool.mockRejectedValueOnce(genericError);

      await expect(client.callTool("tool")).rejects.toThrow("Some other error");
    });

    it("should re-throw -32042 errors without valid PaymentRequired data", async () => {
      const err = createMcpError32042({ unrelated: "data" });
      mockMcpClient.callTool.mockRejectedValueOnce(err);

      await expect(client.callTool("tool")).rejects.toBe(err);
    });

    it("should include payment in _meta on retry after -32042", async () => {
      mockMcpClient.callTool
        .mockRejectedValueOnce(
          createMcpError32042(mockPaymentRequired as unknown as Record<string, unknown>),
        )
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "result" }],
        });

      await client.callTool("paid_tool");

      const secondCall = mockMcpClient.callTool.mock.calls[1][0];
      expect(secondCall._meta?.[MCP_PAYMENT_META_KEY]).toEqual(mockPaymentPayload);
    });
  });

  describe("callTool -32042 with autoPayment disabled", () => {
    beforeEach(() => {
      client = new x402MCPClient(
        mockMcpClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[0],
        mockPaymentClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[1],
        { autoPayment: false },
      );
    });

    it("should throw with payment info when autoPayment is disabled", async () => {
      mockMcpClient.callTool.mockRejectedValueOnce(
        createMcpError32042(mockPaymentRequired as unknown as Record<string, unknown>),
      );

      await expect(client.callTool("paid_tool")).rejects.toMatchObject({
        message: "Payment required",
        code: MCP_PAYMENT_REQUIRED_CODE,
        paymentRequired: mockPaymentRequired,
      });
    });
  });

  describe("callTool -32042 with approval flow", () => {
    it("should call onPaymentRequested hook for -32042 errors", async () => {
      const approvalHook = vi.fn().mockResolvedValue(true);
      client = new x402MCPClient(
        mockMcpClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[0],
        mockPaymentClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[1],
        { autoPayment: true, onPaymentRequested: approvalHook },
      );

      mockMcpClient.callTool
        .mockRejectedValueOnce(
          createMcpError32042(mockPaymentRequired as unknown as Record<string, unknown>),
        )
        .mockResolvedValueOnce({ content: [{ type: "text", text: "result" }] });

      await client.callTool("paid_tool", { arg: "value" });

      expect(approvalHook).toHaveBeenCalledWith({
        toolName: "paid_tool",
        arguments: { arg: "value" },
        paymentRequired: mockPaymentRequired,
      });
    });

    it("should throw if payment request is denied for -32042 error", async () => {
      const approvalHook = vi.fn().mockResolvedValue(false);
      client = new x402MCPClient(
        mockMcpClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[0],
        mockPaymentClient as unknown as Parameters<typeof wrapMCPClientWithPayment>[1],
        { autoPayment: true, onPaymentRequested: approvalHook },
      );

      mockMcpClient.callTool.mockRejectedValueOnce(
        createMcpError32042(mockPaymentRequired as unknown as Record<string, unknown>),
      );

      await expect(client.callTool("paid_tool")).rejects.toThrow("Payment request denied");
    });
  });

  describe("callTool -32042 with hooks", () => {
    it("should call onPaymentRequired hook for -32042 errors", async () => {
      const customPayment = {
        ...mockPaymentPayload,
        payload: { ...mockPaymentPayload.payload, signature: "0xcustom" },
      };
      client.onPaymentRequired(() => ({ payment: customPayment }));

      mockMcpClient.callTool
        .mockRejectedValueOnce(
          createMcpError32042(mockPaymentRequired as unknown as Record<string, unknown>),
        )
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "result" }],
          _meta: { "x402/payment-response": mockSettleResponse },
        });

      await client.callTool("tool", {});

      expect(mockPaymentClient.createPaymentPayload).not.toHaveBeenCalled();
      const callArgs = mockMcpClient.callTool.mock.calls[1][0];
      expect(callArgs._meta?.[MCP_PAYMENT_META_KEY]).toEqual(customPayment);
    });

    it("should abort payment from hook for -32042 errors", async () => {
      client.onPaymentRequired(() => ({ abort: true }));

      mockMcpClient.callTool.mockRejectedValueOnce(
        createMcpError32042(mockPaymentRequired as unknown as Record<string, unknown>),
      );

      await expect(client.callTool("tool", {})).rejects.toThrow("Payment aborted by hook");
    });
  });

  describe("getToolPaymentRequirements with -32042 errors", () => {
    it("should extract requirements from thrown -32042 error", async () => {
      mockMcpClient.callTool.mockRejectedValueOnce(
        createMcpError32042(mockPaymentRequired as unknown as Record<string, unknown>),
      );

      const result = await client.getToolPaymentRequirements("paid_tool");

      expect(result).toEqual(mockPaymentRequired);
    });

    it("should extract requirements from namespaced -32042 error", async () => {
      mockMcpClient.callTool.mockRejectedValueOnce(
        createMcpError32042({ challenges: [], x402: mockPaymentRequired } as unknown as Record<
          string,
          unknown
        >),
      );

      const result = await client.getToolPaymentRequirements("paid_tool");

      expect(result).toEqual(mockPaymentRequired);
    });

    it("should re-throw non-payment errors instead of swallowing them", async () => {
      const networkError = new Error("Network error");
      mockMcpClient.callTool.mockRejectedValueOnce(networkError);

      await expect(client.getToolPaymentRequirements("tool")).rejects.toThrow(networkError);
    });
  });
});
