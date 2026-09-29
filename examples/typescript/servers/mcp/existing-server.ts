/**
 * MCP Server with x402 Paid Tools - Existing Server Integration
 *
 * This example demonstrates the LOW-LEVEL API using `createPaymentWrapper`.
 * Use this approach when you have an EXISTING MCP server and want to add
 * x402 payment to specific tools without adopting the full x402MCPServer abstraction.
 *
 * Key benefits:
 * - Works with your existing McpServer instance
 * - Uses native McpServer.tool() API - nothing new to learn
 * - Mix paid and free tools naturally
 * - Minimal code changes to add payment
 *
 * NOTE ON HOOKS:
 * The base McpServer from @modelcontextprotocol/sdk does NOT have lifecycle hooks.
 * Hooks are available on the CLIENT side (see x402MCPClient):
 * - beforePayment: Called before payment is created
 * - afterPayment: Called after payment is submitted
 * - onPaymentRequired: Called when payment is required
 *
 * For server-side middleware, implement custom Express middleware or wrap tool handlers.
 *
 * Run with: pnpm dev:existing
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
 * @param city - The name of the city to get weather data for
 * @returns An object containing the city name, weather condition, and temperature
 */
function getWeatherData(city: string): { city: string; weather: string; temperature: number } {
  const conditions = ["sunny", "cloudy", "rainy", "snowy", "windy"];
  const weather = conditions[Math.floor(Math.random() * conditions.length)];
  const temperature = Math.floor(Math.random() * 40) + 40;
  return { city, weather, temperature };
}

/**
 * Main entry point - Demonstrates adding x402 to an existing MCP server.
 */
export async function main(): Promise<void> {
  console.log("\n📦 Using LOW-LEVEL API (createPaymentWrapper with existing server)\n");

  // ========================================================================
  // STEP 1: Your existing MCP server (this might already exist in your code)
  // ========================================================================
  const mcpServer = new McpServer({
    name: "Existing Weather Service",
    version: "1.0.0",
  });

  // ========================================================================
  // NOTE: The base McpServer from @modelcontextprotocol/sdk does NOT have
  // lifecycle hooks (onRequest, onResponse, etc.).
  //
  // Hooks are available on the CLIENT side via x402MCPClient:
  // - beforePayment: Called before payment is created
  // - afterPayment: Called after payment is submitted
  // - onPaymentRequired: Called when payment is required
  //
  // For server-side hooks, you can wrap the tool handlers or use middleware
  // in your transport layer (Express, etc.)
  // ========================================================================

  // ========================================================================
  // STEP 2: Set up x402 resource server for payment handling
  // ========================================================================
  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient);
  resourceServer.register("eip155:84532", new ExactEvmScheme());
  await resourceServer.initialize();

  // ========================================================================
  // STEP 3: Build payment requirements for different tools
  // ========================================================================
  const weatherAccepts = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network: "eip155:84532",
    payTo: evmAddress,
    price: "$0.001",
    extra: { name: "USDC", version: "2" }, // EIP-712 domain parameters
  });

  const forecastAccepts = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network: "eip155:84532",
    payTo: evmAddress,
    price: "$0.005",
    extra: { name: "USDC", version: "2" }, // EIP-712 domain parameters
  });

  // ========================================================================
  // STEP 4: Create payment wrappers with accepts arrays
  // ========================================================================
  const paidWeather = createPaymentWrapper(resourceServer, {
    accepts: weatherAccepts,
  });

  const paidForecast = createPaymentWrapper(resourceServer, {
    accepts: forecastAccepts,
  });

  // ========================================================================
  // STEP 5: Register tools using NATIVE McpServer.tool() API
  // ========================================================================

  // Free tool - works exactly as before, no changes needed
  mcpServer.tool("ping", "A free health check tool", {}, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));

  // Paid tools - wrap the handler with payment wrapper
  // Each wrapper has its own price configured in the accepts array
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

  mcpServer.tool(
    "get_forecast",
    "Get 7-day weather forecast. Requires payment of $0.005.",
    { city: z.string().describe("The city name to get forecast for") },
    paidForecast(async (args: { city: string }) => {
      const forecast = Array.from({ length: 7 }, (_, i) => ({
        day: i + 1,
        ...getWeatherData(args.city),
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(forecast, null, 2) }],
      };
    }),
  );

  // Start Express server
  startExpressServer(mcpServer, port);
}

/**
 * Helper to start Express SSE server
 *
 * @param mcpServer - The MCP server instance to connect to the Express server
 * @param port - The port number to listen on
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
    res.json({
      status: "ok",
      mode: "existing-server",
      tools: ["get_weather (paid: $0.001)", "get_forecast (paid: $0.005)", "ping (free)"],
    });
  });

  app.listen(port, () => {
    console.log(`🚀 Existing MCP Server with x402 running on http://localhost:${port}`);
    console.log(`\n📋 Available tools:`);
    console.log(`   - get_weather (paid: $0.001)`);
    console.log(`   - get_forecast (paid: $0.005)`);
    console.log(`   - ping (free)`);
    console.log(`\n🔗 Connect via SSE: http://localhost:${port}/sse`);
    console.log(`\n💡 This example shows how to add x402 to an EXISTING MCP server`);
    console.log(`   using the low-level createPaymentWrapper() API.\n`);
  });
}
