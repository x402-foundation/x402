/**
 * MCP Client with x402 Payment Support - Advanced Example
 *
 * This example demonstrates the LOW-LEVEL API using `x402MCPClient` directly.
 * Use this approach when you need:
 * - Custom x402Client configuration
 * - Payment caching via onPaymentRequired hook
 * - Full control over the payment flow
 * - Integration with existing MCP clients
 *
 * Run with: pnpm dev:advanced
 */

import { config } from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { x402MCPClient } from "@x402/mcp";
import { x402Client } from "@x402/core/client";
import { privateKeyToAccount } from "viem/accounts";

config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
if (!evmPrivateKey) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

const serverUrl = process.env.MCP_SERVER_URL || "http://localhost:4022";

/**
 * Demonstrates the advanced API with manual setup and hooks.
 *
 * @returns Promise that resolves when demo is complete
 */
export async function main(): Promise<void> {
  console.log("\n📦 Using ADVANCED API (x402MCPClient with manual setup)\n");
  console.log("🔌 Connecting to MCP server at:", serverUrl);

  const evmSigner = privateKeyToAccount(evmPrivateKey);
  console.log("💳 Using wallet:", evmSigner.address);

  // ========================================================================
  // ADVANCED: Manual setup with full control
  // ========================================================================

  // Step 1: Create MCP client manually
  const mcpClient = new Client(
    {
      name: "x402-mcp-client-advanced",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Step 2: Create x402 payment client manually
  const paymentClient = new x402Client();
  paymentClient.register("eip155:84532", new ExactEvmScheme(evmSigner));
  paymentClient.register("eip155:84532", new UptoEvmScheme(evmSigner));

  // Step 3: Compose into x402MCPClient
  const x402Mcp = new x402MCPClient(mcpClient, paymentClient, {
    autoPayment: true,
    onPaymentRequested: async context => {
      const price = context.paymentRequired.accepts[0];
      console.log(`\n💰 Payment required for tool: ${context.toolName}`);
      console.log(`   Amount: ${price.amount} (${price.asset})`);
      console.log(`   Network: ${price.network}`);
      console.log(`   Approving payment...\n`);
      return true;
    },
  });

  // ========================================================================
  // ADVANCED: Register hooks for observability and control
  // ========================================================================

  // Hook: Called when 402 is received (before payment)
  // Can return custom payment or abort
  x402Mcp.onPaymentRequired(async context => {
    console.log(`🔔 [Hook] Payment required received for: ${context.toolName}`);
    console.log(`   Options: ${context.paymentRequired.accepts.length} payment option(s)`);
    // Return void to proceed with normal payment flow
    // Return { payment: ... } to use cached payment
    // Return { abort: true } to abort
  });

  // Hook: Called before payment is created
  x402Mcp.onBeforePayment(async context => {
    console.log(`📝 [Hook] Creating payment for: ${context.toolName}`);
  });

  // Hook: Called after payment is submitted
  x402Mcp.onAfterPayment(async context => {
    console.log(`✅ [Hook] Payment submitted for: ${context.toolName}`);
    if (context.settleResponse) {
      console.log(`   Transaction: ${context.settleResponse.transaction}`);
    }
  });

  // Connect and use
  const transport = new SSEClientTransport(new URL(`${serverUrl}/sse`));
  await x402Mcp.connect(transport);
  console.log("✅ Connected to MCP server");
  console.log("📊 Hooks enabled: onPaymentRequired, onBeforePayment, onAfterPayment\n");

  // List tools
  console.log("📋 Discovering available tools...");
  const tools = await x402Mcp.listTools();
  console.log("Available tools:");
  for (const tool of tools.tools) {
    console.log(`   - ${tool.name}: ${tool.description}`);
  }
  console.log();

  // Test free tool
  console.log("━".repeat(50));
  console.log("🆓 Test 1: Calling free tool (ping)");
  console.log("━".repeat(50));

  const pingResult = await x402Mcp.callTool("ping");
  console.log("Response:", pingResult.content[0]?.text);
  console.log("Payment made:", pingResult.paymentMade);
  console.log();

  // Test paid tool
  console.log("━".repeat(50));
  console.log("💰 Test 2: Calling paid tool (get_weather)");
  console.log("━".repeat(50));

  const weatherResult = await x402Mcp.callTool("get_weather", { city: "San Francisco" });
  console.log("Response:", weatherResult.content[0]?.text);
  console.log("Payment made:", weatherResult.paymentMade);

  if (weatherResult.paymentResponse) {
    console.log("\n📦 Payment Receipt:");
    console.log("   Success:", weatherResult.paymentResponse.success);
    if (weatherResult.paymentResponse.transaction) {
      console.log("   Transaction:", weatherResult.paymentResponse.transaction);
    }
  }

  // Test accessing underlying clients
  console.log("\n━".repeat(50));
  console.log("🔧 Test 3: Accessing underlying clients");
  console.log("━".repeat(50));
  console.log("MCP Client:", x402Mcp.client.constructor.name);
  console.log("Payment Client:", x402Mcp.paymentClient.constructor.name);

  console.log("\n✅ Demo complete!");
  await x402Mcp.close();
  process.exit(0);
}
