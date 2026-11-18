/**
 * Real SSE MCP Integration Tests
 *
 * These tests verify the complete MCP payment flow using:
 * - Real SSE transport (not mocked)
 * - Real EVM blockchain transactions on Base Sepolia
 * - Real x402 payment processing
 *
 * Required environment variables:
 * - CLIENT_PRIVATE_KEY: Private key for the client wallet (payer)
 * - FACILITATOR_PRIVATE_KEY: Private key for the facilitator wallet (settles payments)
 *
 * These tests make REAL blockchain transactions on Base Sepolia testnet.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Server } from "http";
import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

import { x402MCPClient, x402MCPServer } from "../../src";
import { x402Client } from "@x402/core/client";
import { x402ResourceServer, FacilitatorClient } from "@x402/core/server";
import { x402Facilitator } from "@x402/core/facilitator";
import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
  SupportedResponse,
} from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme as ExactEvmClientScheme } from "@x402/evm/exact/client";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { ExactEvmScheme as ExactEvmFacilitatorScheme } from "@x402/evm/exact/facilitator";

// ============================================================================
// Environment Setup
// ============================================================================

const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY as `0x${string}`;
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY as `0x${string}`;

// Skip tests if environment variables are not set
const SKIP_TESTS = !CLIENT_PRIVATE_KEY || !FACILITATOR_PRIVATE_KEY;

if (SKIP_TESTS) {
  console.warn(
    "⚠️  Skipping real SSE integration tests: CLIENT_PRIVATE_KEY and FACILITATOR_PRIVATE_KEY must be set",
  );
}

// ============================================================================
// Test Configuration
// ============================================================================

const TEST_PORT = 4099;
const TEST_NETWORK = "eip155:84532" as const; // Base Sepolia
// Base Sepolia USDC: 0x036CbD53842c5426634e7929541eC2318f3dCF7e

/**
 * EVM Facilitator Client wrapper for x402ResourceServer
 */
class EvmFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = TEST_NETWORK;
  readonly x402Version = 2;

  /**
   * Creates a new EvmFacilitatorClient instance
   *
   * @param facilitator - The x402 facilitator to wrap
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * Verifies a payment payload
   *
   * @param paymentPayload - The payment payload to verify
   * @param paymentRequirements - The payment requirements
   * @returns Promise resolving to verification response
   */
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  /**
   * Settles a payment
   *
   * @param paymentPayload - The payment payload to settle
   * @param paymentRequirements - The payment requirements
   * @returns Promise resolving to settlement response
   */
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.facilitator.settle(paymentPayload, paymentRequirements);
  }

  /**
   * Gets supported payment kinds
   *
   * @returns Promise resolving to supported response
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported());
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe.skipIf(SKIP_TESTS)("Real SSE MCP Integration Tests", () => {
  let httpServer: Server;
  let x402Server: x402MCPServer;
  let x402ClientInstance: x402MCPClient;
  let clientAddress: `0x${string}`;
  let recipientAddress: `0x${string}`;
  let transports: Map<string, SSEServerTransport>;

  beforeAll(async () => {
    // ========================================================================
    // Setup Client (Payer)
    // ========================================================================
    const clientAccount = privateKeyToAccount(CLIENT_PRIVATE_KEY);
    clientAddress = clientAccount.address;
    console.log(`\n🔑 Client address: ${clientAddress}`);

    const evmClientScheme = new ExactEvmClientScheme(clientAccount);
    const paymentClient = new x402Client().register(TEST_NETWORK, evmClientScheme);

    // ========================================================================
    // Setup Facilitator (Settles Payments)
    // ========================================================================
    const facilitatorAccount = privateKeyToAccount(FACILITATOR_PRIVATE_KEY);
    recipientAddress = facilitatorAccount.address; // Use facilitator as recipient for simplicity
    console.log(`🔑 Facilitator/Recipient address: ${recipientAddress}`);

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(),
    });

    const walletClient = createWalletClient({
      account: facilitatorAccount,
      chain: baseSepolia,
      transport: http(),
    });

    const facilitatorSigner = toFacilitatorEvmSigner({
      address: facilitatorAccount.address,
      readContract: args =>
        publicClient.readContract({
          ...args,
          args: args.args || [],
        } as never),
      verifyTypedData: args => publicClient.verifyTypedData(args as never),
      writeContract: args =>
        walletClient.writeContract({
          ...args,
          args: args.args || [],
        } as never),
      sendTransaction: args => walletClient.sendTransaction(args),
      waitForTransactionReceipt: args => publicClient.waitForTransactionReceipt(args),
      getCode: args => publicClient.getCode(args),
    });

    const evmFacilitator = new ExactEvmFacilitatorScheme(facilitatorSigner);
    const facilitator = new x402Facilitator().register(TEST_NETWORK, evmFacilitator);
    const facilitatorClient = new EvmFacilitatorClient(facilitator);

    // ========================================================================
    // Setup MCP Server with x402
    // ========================================================================
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const mcpServer = new McpServer({
      name: "x402 Test Server",
      version: "1.0.0",
    });

    const resourceServer = new x402ResourceServer(facilitatorClient);
    resourceServer.register(TEST_NETWORK, new ExactEvmServerScheme());
    await resourceServer.initialize();

    x402Server = new x402MCPServer(mcpServer, resourceServer);

    // Register a FREE tool
    x402Server.tool("ping", "A free health check tool", {}, async () => ({
      content: [{ type: "text" as const, text: "pong" }],
    }));

    // Register a PAID tool
    x402Server.paidTool(
      "get_weather",
      {
        description: "Get weather for a city. Requires payment.",
        inputSchema: {
          city: z.string().describe("The city name"),
        },
      },
      {
        scheme: "exact",
        network: TEST_NETWORK,
        price: "$0.001", // 0.001 USDC = 1000 atomic units
        payTo: recipientAddress,
        extra: { name: "USDC", version: "2" },
      },
      async ({ city }) => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ city, weather: "sunny", temperature: 72 }),
          },
        ],
      }),
    );

    await x402Server.initialize();

    // ========================================================================
    // Start Express Server for SSE
    // ========================================================================
    const app = express();
    transports = new Map<string, SSEServerTransport>();

    app.get("/sse", async (req, res) => {
      const transport = new SSEServerTransport("/messages", res);
      const sessionId = crypto.randomUUID();
      transports.set(sessionId, transport);
      res.on("close", () => {
        transports.delete(sessionId);
      });
      await mcpServer.connect(transport);
    });

    app.post("/messages", express.json(), async (req, res) => {
      const transport = Array.from(transports.values())[0];
      if (!transport) {
        res.status(400).json({ error: "No active SSE connection" });
        return;
      }
      await transport.handlePostMessage(req, res, req.body);
    });

    httpServer = app.listen(TEST_PORT);
    console.log(`\n🚀 Test MCP Server running on http://localhost:${TEST_PORT}\n`);

    // ========================================================================
    // Setup x402 MCP Client with SSE Transport
    // ========================================================================
    // Small delay to ensure server is ready
    await new Promise(resolve => setTimeout(resolve, 100));

    const sseTransport = new SSEClientTransport(new URL(`http://localhost:${TEST_PORT}/sse`));
    const mcpClient = new Client({ name: "x402-test-client", version: "1.0.0" });

    x402ClientInstance = new x402MCPClient(mcpClient, paymentClient, {
      autoPayment: true,
      onPaymentRequested: async ({ paymentRequired }) => {
        console.log(`\n💰 Payment requested: ${paymentRequired.accepts[0].amount} atomic units`);
        return true; // Auto-approve for tests
      },
    });

    await x402ClientInstance.connect(sseTransport);
    console.log("✅ x402 MCP Client connected via SSE\n");
  }, 30000); // 30s timeout for setup

  afterAll(async () => {
    if (x402ClientInstance) {
      await x402ClientInstance.close();
    }
    if (httpServer) {
      httpServer.close();
    }
  });

  // ==========================================================================
  // Test 1: SSE Connection works
  // ==========================================================================
  it("should establish SSE connection successfully", async () => {
    // If we got here, connection was established in beforeAll
    expect(x402ClientInstance).toBeDefined();
    expect(x402ClientInstance.client).toBeDefined();
  });

  // ==========================================================================
  // Test 2: list/tools works without payment
  // ==========================================================================
  it("should list tools without requiring payment", async () => {
    const result = await x402ClientInstance.listTools();

    expect(result.tools).toBeDefined();
    expect(result.tools.length).toBeGreaterThan(0);

    // Verify our tools are listed
    const toolNames = result.tools.map(t => t.name);
    expect(toolNames).toContain("ping");
    expect(toolNames).toContain("get_weather");

    console.log("📋 Available tools:", toolNames.join(", "));
  });

  // ==========================================================================
  // Test 3: Free tool works without payment
  // ==========================================================================
  it("should call free tool without payment", async () => {
    const result = await x402ClientInstance.callTool("ping");

    expect(result.paymentMade).toBe(false);
    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeGreaterThan(0);

    const textContent = result.content[0] as { type: string; text: string };
    expect(textContent.text).toBe("pong");

    console.log("🏓 Free tool result:", textContent.text);
  });

  // ==========================================================================
  // Test 4: Paid tool returns 402 without payment
  // ==========================================================================
  it("should receive 402 for paid tool without payment (manual test)", async () => {
    // Test with autoPayment disabled to see the 402
    const manualClient = new x402MCPClient(
      x402ClientInstance.client,
      x402ClientInstance.paymentClient,
      { autoPayment: false },
    );

    try {
      await manualClient.callTool("get_weather", { city: "San Francisco" });
      // Should not reach here
      expect.fail("Should have thrown 402 error");
    } catch (error) {
      const err = error as { code?: number; paymentRequired?: unknown };
      expect(err.code).toBe(402);
      expect(err.paymentRequired).toBeDefined();
      console.log("💳 402 Payment Required received as expected");
    }
  });

  // ==========================================================================
  // Test 5: Paid tool with payment succeeds (REAL BLOCKCHAIN TRANSACTION)
  // ==========================================================================
  it("should complete paid tool with auto-payment and settle on blockchain", async () => {
    console.log("\n🔄 Starting paid tool call with real blockchain settlement...\n");

    const result = await x402ClientInstance.callTool("get_weather", { city: "New York" });

    // Verify payment was made
    expect(result.paymentMade).toBe(true);
    expect(result.isError).toBeFalsy();

    // Verify we got the tool result
    expect(result.content.length).toBeGreaterThan(0);
    const textContent = result.content[0] as { type: string; text: string };
    const weatherData = JSON.parse(textContent.text);
    expect(weatherData.city).toBe("New York");

    console.log("🌤️ Weather data:", JSON.stringify(weatherData, null, 2));

    // Verify payment response (settlement result)
    expect(result.paymentResponse).toBeDefined();
    expect(result.paymentResponse?.success).toBe(true);
    expect(result.paymentResponse?.transaction).toBeDefined();
    expect(result.paymentResponse?.network).toBe(TEST_NETWORK);

    console.log("\n✅ Settlement successful!");
    console.log(`   Transaction: ${result.paymentResponse?.transaction}`);
    console.log(`   Network: ${result.paymentResponse?.network}`);
    console.log(
      `   View on BaseScan: https://sepolia.basescan.org/tx/${result.paymentResponse?.transaction}\n`,
    );
  }, 60000); // 60s timeout for blockchain transaction

  // ==========================================================================
  // Test 6: 402 response includes bazaar extensions
  // ==========================================================================
  it("should include bazaar extensions in 402 response", async () => {
    // Use a client with autoPayment disabled to see the 402
    const manualClient = new x402MCPClient(
      x402ClientInstance.client,
      x402ClientInstance.paymentClient,
      { autoPayment: false },
    );

    try {
      await manualClient.callTool("get_weather", { city: "Chicago" });
      expect.fail("Should have thrown 402 error");
    } catch (error) {
      const err = error as {
        code?: number;
        paymentRequired?: { extensions?: Record<string, unknown> };
      };
      expect(err.code).toBe(402);
      expect(err.paymentRequired).toBeDefined();
      // Verify bazaar extension is present — hard-fail if absent
      expect(err.paymentRequired?.extensions?.bazaar).toBeDefined();
      const bazaar = err.paymentRequired!.extensions!.bazaar as Record<string, unknown>;
      const info = bazaar.info as Record<string, unknown>;
      expect(info).toBeDefined();
      const input = info.input as Record<string, unknown>;
      expect(input.toolName).toBe("get_weather");
    }
  });

  // ==========================================================================
  // Test 7: Multiple paid tool calls work
  // ==========================================================================
  it("should handle multiple paid tool calls", async () => {
    console.log("\n🔄 Starting second paid tool call...\n");

    const result = await x402ClientInstance.callTool("get_weather", { city: "Los Angeles" });

    expect(result.paymentMade).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(result.paymentResponse?.success).toBe(true);

    const textContent = result.content[0] as { type: string; text: string };
    const weatherData = JSON.parse(textContent.text);
    expect(weatherData.city).toBe("Los Angeles");

    console.log("✅ Second settlement successful!");
    console.log(`   Transaction: ${result.paymentResponse?.transaction}\n`);
  }, 60000);
});
