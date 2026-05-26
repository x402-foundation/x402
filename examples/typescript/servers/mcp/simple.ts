/**
 * MCP Server with x402 Paid Tools - Simple Example
 *
 * This example demonstrates creating an MCP server with payment-wrapped tools.
 * Uses the createPaymentWrapper function to add x402 payment to individual tools.
 *
 * Run with: pnpm dev
 */

import { config } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createPaymentWrapper, x402ResourceServer } from "@x402/mcp";
import { HTTPFacilitatorClient } from "@x402/core/server";
import express from "express";
import { z } from "zod";

config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
if (!evmAddress) {
  console.error("❌ EVM_ADDRESS environment variable is required");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}

const port = parseInt(process.env.PORT || "4022", 10);

/**
 * Simulates fetching weather data for a city.
 *
 * @param city - The city name to get weather for
 * @returns Weather data object
 */
function getWeatherData(city: string): { city: string; weather: string; temperature: number } {
  const conditions = ["sunny", "cloudy", "rainy", "snowy", "windy"];
  const weather = conditions[Math.floor(Math.random() * conditions.length)];
  const temperature = Math.floor(Math.random() * 40) + 40;
  return { city, weather, temperature };
}

/**
 * Main entry point - demonstrates the payment wrapper API.
 *
 * @returns Promise that resolves when server is running
 */
export async function main(): Promise<void> {
  console.log("\n📦 Using Payment Wrapper API\n");

  // ========================================================================
  // STEP 1: Create standard MCP server
  // ========================================================================
  const mcpServer = new McpServer({
    name: "x402 Weather Service",
    version: "1.0.0",
  });

  // ========================================================================
  // STEP 2: Set up x402 resource server for payment handling
  // ========================================================================
  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient);
  resourceServer.register("eip155:84532", new ExactEvmScheme());
  await resourceServer.initialize();

  // ========================================================================
  // STEP 3: Build payment requirements
  // ========================================================================
  const weatherAccepts = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network: "eip155:84532",
    payTo: evmAddress,
    price: "$0.001",
    extra: { name: "USDC", version: "2" }, // EIP-712 domain parameters
  });

  // ========================================================================
  // STEP 4: Create payment wrapper with accepts array
  // ========================================================================
  const paidWeather = createPaymentWrapper(resourceServer, {
    accepts: weatherAccepts,
  });

  // ========================================================================
  // STEP 5: Register tools using native McpServer.tool() API
  // ========================================================================

  // Paid tool - wrap handler with payment
  mcpServer.tool(
    "get_weather",
    "Get current weather for a city. Requires payment of $0.001.",
    { city: z.string().describe("The city name to get weather for") },
    paidWeather(async (args: { city: string }) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(getWeatherData(args.city), null, 2),
        },
      ],
    })),
  );

  // Free tool - no wrapper needed
  mcpServer.tool("ping", "A free health check tool", {}, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));

  // Start Express server for SSE transport
  startExpressServer(mcpServer, port);
}

/**
 * Helper to start Express SSE server
 *
 * @param mcpServer - The MCP server instance
 * @param port - Port to listen on
 */
function startExpressServer(mcpServer: McpServer, port: number): void {
  const app = express();
  const transports = new Map<string, SSEServerTransport>();

  app.get("/sse", async (req, res) => {
    console.log("📡 New SSE connection");
    const transport = new SSEServerTransport("/messages", res);
    const sessionId = crypto.randomUUID();
    transports.set(sessionId, transport);
    res.on("close", () => {
      console.log("📡 SSE connection closed");
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

  app.get("/health", (_, res) => {
    res.json({ status: "ok", tools: ["get_weather (paid: $0.001)", "ping (free)"] });
  });

  app.listen(port, () => {
    console.log(`🚀 x402 MCP Server running on http://localhost:${port}`);
    console.log(`\n📋 Available tools:`);
    console.log(`   - get_weather (paid: $0.001)`);
    console.log(`   - ping (free)`);
    console.log(`\n🔗 Connect via SSE: http://localhost:${port}/sse`);
    console.log(`\n💡 This example uses createPaymentWrapper() to add payment to tools.\n`);
  });
}
