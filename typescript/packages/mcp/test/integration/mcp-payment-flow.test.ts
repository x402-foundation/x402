/**
 * Integration tests for MCP payment flow
 *
 * These tests verify the complete payment flow from client to server,
 * using mocked MCP transport but real x402 payment processing logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { x402MCPClient, x402MCPServer } from "../../src";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
  SupportedResponse,
  FacilitatorClient,
} from "@x402/core/types";
import { z } from "zod";

// ============================================================================
// Test Fixtures
// ============================================================================

const TEST_NETWORK = "eip155:84532" as const;
const TEST_RECIPIENT = "0x1234567890123456789012345678901234567890";
const TEST_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // USDC on Base Sepolia
const TEST_PRICE = "1000"; // 0.001 USDC

const mockPaymentRequirements: PaymentRequirements = {
  scheme: "exact",
  network: TEST_NETWORK,
  amount: TEST_PRICE,
  asset: TEST_ASSET,
  payTo: TEST_RECIPIENT,
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

const mockPaymentPayload: PaymentPayload = {
  x402Version: 2,
  payload: {
    signature: "0xmocksignature",
    authorization: {
      from: "0xclient",
      to: TEST_RECIPIENT,
      value: TEST_PRICE,
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 3600,
      nonce: "0x1",
    },
  },
};

const mockSettleResponse: SettleResponse = {
  success: true,
  transaction: "0xtxhash123456",
  network: TEST_NETWORK,
};

// ============================================================================
// Mock Implementations
// ============================================================================

/**
 * Mock facilitator client for testing
 */
class MockFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = TEST_NETWORK;
  readonly x402Version = 2;

  verify = vi.fn().mockResolvedValue({ isValid: true } as VerifyResponse);
  settle = vi.fn().mockResolvedValue(mockSettleResponse);
  getSupported = vi.fn().mockResolvedValue({
    x402Version: 2,
    kinds: [
      {
        scheme: "exact",
        network: TEST_NETWORK,
        asset: TEST_ASSET,
        extra: { name: "USDC", version: "2" },
      },
    ],
  } as SupportedResponse);
}

/**
 * Mock MCP client that simulates the transport layer
 *
 * @param serverHandler - The handler function for tool calls
 * @returns Mock MCP client instance
 */
function createMockMcpClient(
  serverHandler: (
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    _meta?: Record<string, unknown>;
  }>,
) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    listResources: vi.fn().mockResolvedValue({ resources: [] }),
    listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
    callTool: vi
      .fn()
      .mockImplementation(
        async (params: {
          name: string;
          arguments?: Record<string, unknown>;
          _meta?: Record<string, unknown>;
        }) => {
          return serverHandler(params.name, params.arguments ?? {}, params._meta);
        },
      ),
  };
}

/**
 * Mock payment client that creates mock payment payloads
 *
 * @returns Mock payment client instance
 */
function createMockPaymentClient() {
  return {
    createPaymentPayload: vi.fn().mockResolvedValue(mockPaymentPayload),
    register: vi.fn().mockReturnThis(),
    registerV1: vi.fn().mockReturnThis(),
  };
}

// ============================================================================
// Integration Tests
// ============================================================================

describe("MCP Payment Flow Integration", () => {
  let facilitator: MockFacilitatorClient;
  let server: x402MCPServer;
  let serverToolHandlers: Map<
    string,
    (
      args: Record<string, unknown>,
      extra: { _meta?: Record<string, unknown> },
    ) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
      _meta?: Record<string, unknown>;
    }>
  >;

  beforeEach(async () => {
    facilitator = new MockFacilitatorClient();
    serverToolHandlers = new Map();

    // Create server with mock facilitator
    const mockMcpServer = {
      tool: vi
        .fn()
        .mockImplementation(
          (
            name: string,
            _desc: string,
            _schema: unknown,
            handler: typeof serverToolHandlers extends Map<string, infer H> ? H : never,
          ) => {
            serverToolHandlers.set(name, handler);
          },
        ),
      resource: vi.fn(),
      prompt: vi.fn(),
    };

    const mockResourceServer = {
      initialize: vi.fn().mockResolvedValue(undefined),
      register: vi.fn(),
      verifyPayment: facilitator.verify,
      settlePayment: facilitator.settle,
      buildPaymentRequirements: vi.fn().mockResolvedValue([mockPaymentRequirements]),
      createPaymentRequiredResponse: vi
        .fn()
        .mockImplementation((_requirements, resourceInfo, errorMessage) => ({
          x402Version: 2,
          accepts: [mockPaymentRequirements],
          error: errorMessage,
          resource: resourceInfo,
        })),
    };

    server = new x402MCPServer(
      mockMcpServer as unknown as ConstructorParameters<typeof x402MCPServer>[0],
      mockResourceServer as unknown as ConstructorParameters<typeof x402MCPServer>[1],
    );

    // Register test tools
    server.paidTool(
      "get_weather",
      {
        description: "Get weather for a city",
        inputSchema: { city: z.string() },
      },
      {
        scheme: "exact",
        network: TEST_NETWORK,
        price: "$0.001",
        payTo: TEST_RECIPIENT,
        extra: { name: "USDC", version: "2" },
      },
      async ({ city }) => ({
        content: [
          { type: "text" as const, text: JSON.stringify({ city, weather: "sunny", temp: 72 }) },
        ],
      }),
    );

    server.tool("ping", "Health check", {}, async () => ({
      content: [{ type: "text" as const, text: "pong" }],
    }));

    await server.initialize();
  });

  describe("complete payment flow", () => {
    it("should handle free tool calls without payment", async () => {
      const mockPaymentClient = createMockPaymentClient();

      // Create mock MCP client that routes to server handlers
      const mockMcpClient = createMockMcpClient(async (name, args, meta) => {
        const handler = serverToolHandlers.get(name);
        if (!handler) throw new Error(`Tool ${name} not found`);
        return handler(args, { _meta: meta });
      });

      const client = new x402MCPClient(
        mockMcpClient as unknown as ConstructorParameters<typeof x402MCPClient>[0],
        mockPaymentClient as unknown as ConstructorParameters<typeof x402MCPClient>[1],
      );

      const result = await client.callTool("ping");

      expect(result.paymentMade).toBe(false);
      expect(result.content[0]?.text).toBe("pong");
      expect(mockPaymentClient.createPaymentPayload).not.toHaveBeenCalled();
    });

    it("should complete paid tool flow with auto-payment", async () => {
      const mockPaymentClient = createMockPaymentClient();

      // Track call sequence
      let callCount = 0;

      const mockMcpClient = createMockMcpClient(async (name, args, meta) => {
        callCount++;
        const handler = serverToolHandlers.get(name);
        if (!handler) throw new Error(`Tool ${name} not found`);
        return handler(args, { _meta: meta });
      });

      const client = new x402MCPClient(
        mockMcpClient as unknown as ConstructorParameters<typeof x402MCPClient>[0],
        mockPaymentClient as unknown as ConstructorParameters<typeof x402MCPClient>[1],
        { autoPayment: true },
      );

      const result = await client.callTool("get_weather", { city: "San Francisco" });

      // Should have made 2 calls: initial (402) + retry (with payment)
      expect(callCount).toBe(2);

      // Payment should have been made
      expect(result.paymentMade).toBe(true);
      expect(mockPaymentClient.createPaymentPayload).toHaveBeenCalled();

      // Should have valid result
      const content = JSON.parse(result.content[0]?.text ?? "{}");
      expect(content.city).toBe("San Francisco");
      expect(content.weather).toBe("sunny");

      // Payment response should be present
      expect(result.paymentResponse).toEqual(mockSettleResponse);
    });

    it("should call approval hook before payment", async () => {
      const approvalHook = vi.fn().mockResolvedValue(true);
      const mockPaymentClient = createMockPaymentClient();

      const mockMcpClient = createMockMcpClient(async (name, args, meta) => {
        const handler = serverToolHandlers.get(name);
        if (!handler) throw new Error(`Tool ${name} not found`);
        return handler(args, { _meta: meta });
      });

      const client = new x402MCPClient(
        mockMcpClient as unknown as ConstructorParameters<typeof x402MCPClient>[0],
        mockPaymentClient as unknown as ConstructorParameters<typeof x402MCPClient>[1],
        { autoPayment: true, onPaymentRequested: approvalHook },
      );

      await client.callTool("get_weather", { city: "NYC" });

      expect(approvalHook).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "get_weather",
          arguments: { city: "NYC" },
          paymentRequired: expect.objectContaining({
            x402Version: 2,
            accepts: expect.any(Array),
          }),
        }),
      );
    });

    it("should abort if payment request denied", async () => {
      const approvalHook = vi.fn().mockResolvedValue(false);
      const mockPaymentClient = createMockPaymentClient();

      const mockMcpClient = createMockMcpClient(async (name, args, meta) => {
        const handler = serverToolHandlers.get(name);
        if (!handler) throw new Error(`Tool ${name} not found`);
        return handler(args, { _meta: meta });
      });

      const client = new x402MCPClient(
        mockMcpClient as unknown as ConstructorParameters<typeof x402MCPClient>[0],
        mockPaymentClient as unknown as ConstructorParameters<typeof x402MCPClient>[1],
        { autoPayment: true, onPaymentRequested: approvalHook },
      );

      await expect(client.callTool("get_weather", { city: "NYC" })).rejects.toThrow(
        "Payment request denied",
      );

      // Payment should not have been created
      expect(mockPaymentClient.createPaymentPayload).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should handle payment verification failure", async () => {
      // Make verification fail
      facilitator.verify.mockResolvedValueOnce({
        isValid: false,
        invalidReason: "Invalid signature",
      });

      const mockPaymentClient = createMockPaymentClient();

      const mockMcpClient = createMockMcpClient(async (name, args, meta) => {
        const handler = serverToolHandlers.get(name);
        if (!handler) throw new Error(`Tool ${name} not found`);
        return handler(args, { _meta: meta });
      });

      const client = new x402MCPClient(
        mockMcpClient as unknown as ConstructorParameters<typeof x402MCPClient>[0],
        mockPaymentClient as unknown as ConstructorParameters<typeof x402MCPClient>[1],
        { autoPayment: true },
      );

      // The second attempt with payment will also get 402 due to verification failure
      // This will cause infinite retry unless we limit it
      // For this test, we expect the result to have isError: true
      const result = await client.callTool("get_weather", { city: "NYC" });

      // After first 402, client retries with payment
      // Server verifies, fails, returns 402 again
      // Client sees 402 again and (since payment was already made) returns the error result
      expect(result.isError).toBe(true);
    });

    it("should handle settlement failure gracefully", async () => {
      // Make settlement fail
      facilitator.settle.mockRejectedValueOnce(new Error("Network error during settlement"));

      const mockPaymentClient = createMockPaymentClient();

      const mockMcpClient = createMockMcpClient(async (name, args, meta) => {
        const handler = serverToolHandlers.get(name);
        if (!handler) throw new Error(`Tool ${name} not found`);
        return handler(args, { _meta: meta });
      });

      const client = new x402MCPClient(
        mockMcpClient as unknown as ConstructorParameters<typeof x402MCPClient>[0],
        mockPaymentClient as unknown as ConstructorParameters<typeof x402MCPClient>[1],
        { autoPayment: true },
      );

      const result = await client.callTool("get_weather", { city: "NYC" });

      // Per MCP spec, settlement failure returns a 402 error (not content with error in _meta)
      // The client should see this as an error response
      expect(result.paymentMade).toBe(true);
      expect(result.isError).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      // The error content contains the settlement failure info
      const errorText = result.content[0].type === "text" ? result.content[0].text : "";
      expect(errorText).toContain("Payment settlement failed");
      expect(errorText).toContain("Network error");
    });
  });
});
