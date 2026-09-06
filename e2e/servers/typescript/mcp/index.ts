/**
 * MCP E2E Test Server with x402 Payment-Wrapped Tools
 *
 * Thin MCP adapter over the same mechanisms catalog the HTTP frameworks use:
 * one tool per resolved route, each wrapped with `createPaymentWrapper` using
 * payment requirements built from the same `accepts` config `buildPaymentRoutes`
 * feeds `paymentMiddleware`. Tools take no arguments and return the fixed
 * `{ message, timestamp }` body every HTTP route returns.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createPaymentWrapper } from "@x402/mcp";
import { x402ResourceServer, type ResourceConfig } from "@x402/core/server";
import express from "express";
import {
  loadServerEnv,
  createFacilitatorClients,
  configureResourceServer,
  catalogRoutes,
  resolvedRoutes,
  HEALTH_PATH,
  CLOSE_PATH,
  buildHealthResponse,
  buildCloseResponse,
  formatStartupBanner,
} from "../index.ts";
import { buildResolvedRouteConfig } from "../config";
import { PROTECTED_ROUTE_MESSAGE, sdkRouteToEndpoint, mcpToolName } from "../../../src/mechanisms";

const cfg = loadServerEnv();
const { PORT, facilitatorUrl } = cfg;

/** Tool descriptions derived from the catalog (unresolved routes, so unconfigured networks are covered too). */
const toolDescriptions = new Map(
  catalogRoutes().map(route => [route.path, sdkRouteToEndpoint(route, "mcp").description]),
);

async function main(): Promise<void> {
  const mcpServer = new McpServer({
    name: "x402 MCP E2E Server",
    version: "1.0.0",
  });

  const facilitatorClients = createFacilitatorClients(facilitatorUrl);
  const resourceServer = new x402ResourceServer(facilitatorClients);
  await configureResourceServer(resourceServer, cfg);
  // Unlike x402HTTPResourceServer (used by paymentMiddleware), the raw
  // x402ResourceServer used by createPaymentWrapper doesn't lazily initialize
  // on first call, so this must run before any buildPaymentRequirements call.
  await resourceServer.initialize();

  for (const route of resolvedRoutes(cfg)) {
    const toolName = mcpToolName(route.path);
    const description = toolDescriptions.get(route.path) ?? `Paid MCP tool for ${route.path}`;
    const { accepts, extensions } = buildResolvedRouteConfig(route, "mcp") as {
      accepts: ResourceConfig;
      extensions?: Record<string, unknown>;
    };
    const paymentRequirements = await resourceServer.buildPaymentRequirements(accepts);
    const paid = createPaymentWrapper(resourceServer, {
      accepts: paymentRequirements,
      resource: { url: `mcp://tool/${toolName}`, description },
      ...(extensions ? { extensions } : {}),
    });

    mcpServer.tool(
      toolName,
      description,
      {},
      paid(async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ message: PROTECTED_ROUTE_MESSAGE, timestamp: new Date().toISOString() }),
          },
        ],
      })),
    );
  }

  // Free tool for basic connectivity check
  mcpServer.tool("ping", "A free health check tool", {}, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));

  // Start Express server for SSE transport
  const app = express();
  const transports = new Map<string, SSEServerTransport>();

  app.get("/sse", async (_req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    // Key by the transport's own session id (the same id it sends the client
    // via the `endpoint` SSE event and expects back as `?sessionId=` on
    // POST /messages), not an unrelated locally generated id. This lets
    // /messages route each request to its actual session instead of
    // guessing "the first one" -- which would misroute if more than one
    // SSE session is ever open at once (e.g. a readiness probe connection
    // that hasn't fully torn down yet when a new client connects).
    transports.set(transport.sessionId, transport);
    res.on("close", () => {
      transports.delete(transport.sessionId);
    });
    await mcpServer.connect(transport);
  });

  app.post("/messages", express.json(), async (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    const transport = sessionId ? transports.get(sessionId) : Array.from(transports.values())[0];
    if (!transport) {
      res.status(400).json({ error: "No active SSE connection" });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  app.get(HEALTH_PATH, (_req, res) => {
    res.json(buildHealthResponse(cfg));
  });

  app.post(CLOSE_PATH, (_req, res) => {
    res.json(buildCloseResponse());
    setTimeout(() => {
      process.exit(0);
    }, 100);
  });

  app.listen(parseInt(PORT), () => {
    console.log(
      formatStartupBanner(cfg, {
        title: "x402 MCP E2E Server",
        address: `http://localhost:${PORT}`,
      }),
    );
  });
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
