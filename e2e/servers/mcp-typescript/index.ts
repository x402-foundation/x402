/**
 * MCP E2E Test Server with x402 Payment-Wrapped Tools
 *
 * This server exposes paid MCP tools over SSE transport for e2e testing.
 * Adapted from examples/typescript/servers/mcp/simple.ts for the e2e framework.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import { createPaymentWrapper, x402ResourceServer } from "@x402/mcp";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import express from "express";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const PORT = process.env.PORT || "4022";
const EVM_NETWORK = (process.env.EVM_NETWORK || "eip155:84532") as `${string}:${string}`;
const EVM_PAYEE_ADDRESS = process.env.EVM_PAYEE_ADDRESS as `0x${string}`;
const EVM_PERMIT2_ASSET = process.env.EVM_PERMIT2_ASSET as `0x${string}`;
const facilitatorUrl = process.env.FACILITATOR_URL;

if (!EVM_PAYEE_ADDRESS) {
  console.error("❌ EVM_PAYEE_ADDRESS environment variable is required");
  process.exit(1);
}

if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}

/**
 * Simulates fetching weather data for a city.
 */
function getWeatherData(city: string): { city: string; weather: string; temperature: number } {
  const conditions = ["sunny", "cloudy", "rainy", "snowy", "windy"];
  const weather = conditions[Math.floor(Math.random() * conditions.length)];
  const temperature = Math.floor(Math.random() * 40) + 40;
  return { city, weather, temperature };
}

function getBatchSettlementData(method: string): { message: string; timestamp: string; method: string } {
  return {
    message: "Batch-settlement MCP tool accessed successfully",
    timestamp: new Date().toISOString(),
    method,
  };
}

async function main(): Promise<void> {
  // Step 1: Create standard MCP server
  const mcpServer = new McpServer({
    name: "x402 MCP E2E Server",
    version: "1.0.0",
  });

  // Step 2: Set up x402 resource server for payment handling
  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient);
  resourceServer.register("eip155:*", new ExactEvmScheme());
  const receiverAuthorizerPrivateKey = process.env.EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY as
    | `0x${string}`
    | undefined;
  const receiverAuthorizerSigner = receiverAuthorizerPrivateKey
    ? privateKeyToAccount(receiverAuthorizerPrivateKey)
    : undefined;
  resourceServer.register(
    "eip155:*",
    new BatchSettlementEvmScheme(EVM_PAYEE_ADDRESS, {
      ...(receiverAuthorizerSigner ? { receiverAuthorizerSigner } : {}),
    }),
  );
  await resourceServer.initialize();

  // Step 3: Build payment requirements
  const weatherAccepts = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network: EVM_NETWORK,
    payTo: EVM_PAYEE_ADDRESS,
    price: "$0.001",
    extra: { name: "USDC", version: "2" },
  });
  const batchEip3009Accepts = await resourceServer.buildPaymentRequirements({
    scheme: "batch-settlement",
    network: EVM_NETWORK,
    payTo: EVM_PAYEE_ADDRESS,
    price: "$0.001",
  });
  const batchPermit2Accepts = await resourceServer.buildPaymentRequirements({
    scheme: "batch-settlement",
    network: EVM_NETWORK,
    payTo: EVM_PAYEE_ADDRESS,
    price: {
      amount: "1000",
      asset: EVM_PERMIT2_ASSET,
      extra: {
        assetTransferMethod: "permit2",
        name: EVM_NETWORK === "eip155:84532" ? "USDC" : "USD Coin",
        version: "2",
      },
    },
  });

  // Step 4: Declare bazaar discovery extension for the weather tool
  const weatherExtensions = declareDiscoveryExtension({
    toolName: "get_weather",
    description: "Get current weather for a city. Requires payment of $0.001.",
    transport: "sse",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "The city name to get weather for" },
      },
      required: ["city"],
    },
  });
  const batchEip3009Extensions = declareDiscoveryExtension({
    toolName: "batch_settlement_eip3009",
    description: "Batch-settlement EIP-3009 MCP tool. Requires payment of $0.001.",
    transport: "sse",
    inputSchema: {
      type: "object",
      properties: {},
    },
  });
  const batchPermit2Extensions = declareDiscoveryExtension({
    toolName: "batch_settlement_permit2",
    description: "Batch-settlement Permit2 MCP tool. Requires payment of $0.001.",
    transport: "sse",
    inputSchema: {
      type: "object",
      properties: {},
    },
  });

  // Step 5: Create payment wrapper with extensions
  const paidWeather = createPaymentWrapper(resourceServer, {
    accepts: weatherAccepts,
    resource: { url: "mcp://tool/get_weather", description: "Get current weather for a city" },
    extensions: weatherExtensions,
  });
  const paidBatchEip3009 = createPaymentWrapper(resourceServer, {
    accepts: batchEip3009Accepts,
    resource: {
      url: "mcp://tool/batch_settlement_eip3009",
      description: "Batch-settlement EIP-3009 MCP tool",
    },
    extensions: batchEip3009Extensions,
  });
  const paidBatchPermit2 = createPaymentWrapper(resourceServer, {
    accepts: batchPermit2Accepts,
    resource: {
      url: "mcp://tool/batch_settlement_permit2",
      description: "Batch-settlement Permit2 MCP tool",
    },
    extensions: batchPermit2Extensions,
  });

  // Step 6: Register tools
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
    "batch_settlement_eip3009",
    "Batch-settlement EIP-3009 tool. Requires payment of $0.001.",
    {},
    paidBatchEip3009(async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(getBatchSettlementData("batch-settlement-eip3009"), null, 2),
        },
      ],
    })),
  );

  mcpServer.tool(
    "batch_settlement_permit2",
    "Batch-settlement Permit2 tool. Requires payment of $0.001.",
    {},
    paidBatchPermit2(async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(getBatchSettlementData("batch-settlement-permit2"), null, 2),
        },
      ],
    })),
  );

  // Free tool for basic connectivity check
  mcpServer.tool("ping", "A free health check tool", {}, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));

  // Start Express server for SSE transport
  const app = express();
  const transports = new Map<string, SSEServerTransport>();

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

  app.get("/health", (_, res) => {
    res.json({
      status: "ok",
      tools: [
        "get_weather (paid: $0.001)",
        "batch_settlement_eip3009 (paid: $0.001)",
        "batch_settlement_permit2 (paid: $0.001)",
        "ping (free)",
      ],
    });
  });

  app.post("/close", (_, res) => {
    res.json({ message: "Server shutting down gracefully" });
    setTimeout(() => {
      process.exit(0);
    }, 100);
  });

  app.listen(parseInt(PORT), () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
    console.log(`Health: http://localhost:${PORT}/health`);
  });
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
