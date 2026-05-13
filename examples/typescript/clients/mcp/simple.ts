/**
 * MCP Client with x402 Payment Support - Simple Example
 *
 * This example demonstrates the RECOMMENDED way to create an MCP client
 * using the high-level `createx402MCPClient` factory function.
 *
 * Run with: pnpm dev
 */

import { config } from "dotenv";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { createx402MCPClient } from "@x402/mcp";
import { privateKeyToAccount } from "viem/accounts";

config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
if (!evmPrivateKey) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

const serverUrl = process.env.MCP_SERVER_URL || "http://localhost:4022";

/**
 * Demonstrates the simple API using createx402MCPClient factory.
 *
 * @returns Promise that resolves when demo is complete
 */
export async function main(): Promise<void> {
  console.log("\n📦 Using SIMPLE API (createx402MCPClient factory)\n");
  console.log("🔌 Connecting to MCP server at:", serverUrl);

  const evmSigner = privateKeyToAccount(evmPrivateKey);
  console.log("💳 Using wallet:", evmSigner.address);

  // ========================================================================
  // SIMPLE: One-liner setup with factory function
  // ========================================================================
  const x402Mcp = createx402MCPClient({
    name: "x402-mcp-client-demo",
    version: "1.0.0",
    schemes: [
      { network: "eip155:84532", client: new ExactEvmScheme(evmSigner) },
      { network: "eip155:84532", client: new UptoEvmScheme(evmSigner) },
    ],
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

  // Connect using passthrough method
  const transport = new SSEClientTransport(new URL(`${serverUrl}/sse`));
  await x402Mcp.connect(transport);
  console.log("✅ Connected to MCP server\n");

  // List tools using passthrough method
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

  console.log("\n✅ Demo complete!");
  await x402Mcp.close();
  process.exit(0);
}
