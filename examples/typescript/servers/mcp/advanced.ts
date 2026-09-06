/**
 * MCP Server with x402 Paid Tools - Advanced Example with Hooks
 *
 * This example demonstrates using createPaymentWrapper with hooks for:
 * - Logging and observability
 * - Rate limiting and access control
 * - Custom settlement handling
 * - Production monitoring
 *
 * Run with: pnpm dev:advanced
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
 * Main entry point - demonstrates hooks with payment wrapper.
 *
 * @returns Promise that resolves when server is running
 */
export async function main(): Promise<void> {
  console.log("\n📦 Using Payment Wrapper with Hooks\n");

  // ========================================================================
  // STEP 1: Create standard MCP server
  // ========================================================================
  const mcpServer = new McpServer({
    name: "x402 Weather Service (Advanced)",
    version: "1.0.0",
  });

  // ========================================================================
  // STEP 2: Set up x402 resource server
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
  // STEP 4: Create payment wrappers with hooks for production features
  // ========================================================================

  // Shared hooks for all paid tools
  const sharedHooks = {
    // Hook 1: Before execution - can abort based on business logic
    onBeforeExecution: async (context: {
      toolName: string;
      arguments: Record<string, unknown>;
      paymentPayload: { payload: { authorization: { from: string } } };
      paymentRequirements: { amount: string };
    }) => {
      console.log(`\n🔧 [Hook] Before execution: ${context.toolName}`);
      console.log(`   Payment from: ${context.paymentPayload.payload.authorization.from}`);
      console.log(`   Amount: ${context.paymentRequirements.amount}`);

      // Example: Rate limiting (return false to abort)
      // if (await isRateLimited(context.paymentPayload.payer)) {
      //   console.log(`   ⛔ Rate limit exceeded`);
      //   return false;
      // }

      return true; // Continue execution
    },

    // Hook 2: After execution - logging and metrics
    onAfterExecution: async (context: { toolName: string; result: { isError?: boolean } }) => {
      console.log(`✅ [Hook] After execution: ${context.toolName}`);
      console.log(`   Result error: ${context.result.isError ?? false}`);

      // Example: Log to analytics
      // await analytics.trackToolExecution(context.toolName, context.result);
    },

    // Hook 3: After settlement - receipts and notifications
    onAfterSettlement: async (context: {
      toolName: string;
      settlement: { transaction: string; success: boolean };
    }) => {
      console.log(`💸 [Hook] Settlement complete: ${context.toolName}`);
      console.log(`   Transaction: ${context.settlement.transaction}`);
      console.log(`   Success: ${context.settlement.success}\n`);

      // Example: Send receipt to user
      // await sendReceipt(context.paymentPayload.payer, context.settlement);
    },
  };

  const paidWeather = createPaymentWrapper(resourceServer, {
    accepts: weatherAccepts,
    hooks: sharedHooks,
  });

  const paidForecast = createPaymentWrapper(resourceServer, {
    accepts: forecastAccepts,
    hooks: sharedHooks,
  });

  // ========================================================================
  // STEP 5: Register tools - each wrapper has its own price and hooks
  // ========================================================================

  // Weather tool - $0.001
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

  // Forecast tool - $0.005
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

  // Free tool - no wrapper, no hooks
  mcpServer.tool("ping", "A free health check tool", {}, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));

  // Start Express server
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
    res.json({
      status: "ok",
      mode: "advanced-with-hooks",
      tools: ["get_weather (paid: $0.001)", "ping (free)"],
    });
  });

  app.listen(port, () => {
    console.log(`🚀 x402 MCP Server (Advanced) running on http://localhost:${port}`);
    console.log(`\n📋 Available tools:`);
    console.log(`   - get_weather (paid: $0.001) [with hooks]`);
    console.log(`   - ping (free)`);
    console.log(`\n🔗 Connect via SSE: http://localhost:${port}/sse`);
    console.log(`\n📊 Hooks enabled:`);
    console.log(`   - onBeforeExecution: Rate limiting, validation`);
    console.log(`   - onAfterExecution: Logging, metrics`);
    console.log(`   - onAfterSettlement: Receipts, notifications\n`);
  });
}
