/**
 * Tests for exposing the raw MCP `tools/call` request to payment schemes.
 *
 * These run a real McpServer and Client over the SDK's in-memory transport so
 * the SDK's own input validation (defaults, unknown-key stripping) sits between
 * the wire and the paid tool, exactly as in production.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { captureRawToolCalls, createPaymentWrapper } from "../../src/server";
import type { MCPPaymentTransportContext } from "../../src/server";

// ============================================================================
// Fixtures
// ============================================================================

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "1000",
  asset: "0xtoken",
  payTo: "0xrecipient",
  maxTimeoutSeconds: 60,
  extra: {},
};

const payment: PaymentPayload = {
  x402Version: 2,
  accepted: requirements,
  payload: { signature: "0x123" },
};

const settled: SettleResponse = {
  success: true,
  transaction: "0xtx",
  network: "eip155:84532",
};

/**
 * Copies a transport context as JSON so later mutation cannot affect
 * assertions. JSON drops functions and `undefined` members, which also keeps
 * the recorder working when a test deliberately sends a non-JSON value.
 *
 * @param context - Transport context handed to the resource server
 * @returns A detached JSON copy
 */
function snapshot(context: MCPPaymentTransportContext): MCPPaymentTransportContext {
  return JSON.parse(JSON.stringify(context)) as MCPPaymentTransportContext;
}

/**
 * Builds a resource server double that records every transport context it is
 * handed. Payment logic itself is not under test here.
 *
 * @returns The double and the recorded contexts
 */
function createRecordingResourceServer() {
  const contexts = {
    paymentRequired: [] as MCPPaymentTransportContext[],
    verify: [] as MCPPaymentTransportContext[],
    settle: [] as MCPPaymentTransportContext[],
  };
  const server = {
    getRegisteredScheme: vi.fn().mockReturnValue({
      scheme: "exact",
      defaultAssetTransferMethod: "default",
      paymentFlows: {
        default: { supported: ["authorization"] as const, default: "authorization" as const },
      },
    }),
    createPaymentRequiredResponse: vi.fn(
      async (
        accepts: PaymentRequirements[],
        resource: { url: string },
        error: string | undefined,
        _extensions: unknown,
        transportContext: MCPPaymentTransportContext,
      ) => {
        contexts.paymentRequired.push(snapshot(transportContext));
        return { x402Version: 2, accepts, resource, error };
      },
    ),
    findMatchingRequirements: vi.fn().mockReturnValue(requirements),
    validateExtensions: vi.fn().mockReturnValue({ valid: true }),
    getPaymentFlow: vi.fn().mockReturnValue("authorization"),
    verifyPayment: vi.fn(
      async (_p: unknown, _r: unknown, _e: unknown, ctx: MCPPaymentTransportContext) => {
        contexts.verify.push(snapshot(ctx));
        return { isValid: true };
      },
    ),
    settlePayment: vi.fn(
      async (_p: unknown, _r: unknown, _e: unknown, ctx: MCPPaymentTransportContext) => {
        contexts.settle.push(snapshot(ctx));
        return settled;
      },
    ),
    createPaymentCancellationDispatcher: vi.fn().mockReturnValue({
      cancel: vi.fn().mockResolvedValue(undefined),
    }),
  };
  return {
    resourceServer: server as unknown as Parameters<typeof createPaymentWrapper>[0],
    mock: server,
    contexts,
  };
}

/**
 * Connects a client to the given server over a linked in-memory transport pair.
 *
 * @param server - The MCP server (high- or low-level) to connect
 * @returns A connected client
 */
async function connect(server: McpServer | Server): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const articleSchema = { article: z.string(), lang: z.string().default("en") };
const okResult = { content: [{ type: "text" as const, text: "article body" }] };

// ============================================================================
// Tests
// ============================================================================

describe("raw tools/call capture", () => {
  let recording: ReturnType<typeof createRecordingResourceServer>;
  let client: Client | undefined;

  beforeEach(() => {
    recording = createRecordingResourceServer();
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  describe("with captureRawToolCalls", () => {
    it("binds the raw arguments, not the schema-defaulted ones, and the real tool name", async () => {
      const mcpServer = new McpServer({ name: "s", version: "1.0.0" });
      captureRawToolCalls(mcpServer);
      const paid = createPaymentWrapper(recording.resourceServer, { accepts: [requirements] });
      const handler = vi.fn().mockResolvedValue(okResult);
      mcpServer.registerTool(
        "get_article",
        { description: "paid", inputSchema: articleSchema },
        paid(handler),
      );
      client = await connect(mcpServer);

      await client.callTool({ name: "get_article", arguments: { article: "A" } });

      expect(recording.contexts.paymentRequired).toHaveLength(1);
      const context = recording.contexts.paymentRequired[0];
      expect(context.rawToolCall).toEqual({ name: "get_article", arguments: { article: "A" } });
      // Existing fields are unchanged except that the name is now the actual one.
      expect(context.arguments).toEqual({ article: "A", lang: "en" });
      expect(context.toolName).toBe("get_article");
      expect(context.meta).toBeUndefined();
      expect(handler).not.toHaveBeenCalled();
    });

    it("derives the default resource URL from the actual tool name", async () => {
      const mcpServer = new McpServer({ name: "s", version: "1.0.0" });
      captureRawToolCalls(mcpServer);
      const paid = createPaymentWrapper(recording.resourceServer, { accepts: [requirements] });
      mcpServer.registerTool("get_article", { inputSchema: articleSchema }, paid(vi.fn()));
      client = await connect(mcpServer);

      await client.callTool({ name: "get_article", arguments: { article: "A" } });

      expect(recording.mock.createPaymentRequiredResponse).toHaveBeenCalledWith(
        [requirements],
        expect.objectContaining({
          url: "mcp://tool/get_article",
          description: "Tool: get_article",
        }),
        "Payment required to access this tool",
        undefined,
        expect.anything(),
        undefined,
      );
    });

    it("keeps a configured resource URL while binding the actual tool name", async () => {
      const mcpServer = new McpServer({ name: "s", version: "1.0.0" });
      captureRawToolCalls(mcpServer);
      const paid = createPaymentWrapper(recording.resourceServer, {
        accepts: [requirements],
        resource: { url: "https://api.example.com/tools/article" },
      });
      mcpServer.registerTool("get_article", { inputSchema: articleSchema }, paid(vi.fn()));
      client = await connect(mcpServer);

      await client.callTool({ name: "get_article", arguments: { article: "A" } });

      expect(recording.mock.createPaymentRequiredResponse).toHaveBeenCalledWith(
        [requirements],
        expect.objectContaining({ url: "https://api.example.com/tools/article" }),
        expect.any(String),
        undefined,
        expect.anything(),
        undefined,
      );
      expect(recording.contexts.paymentRequired[0].toolName).toBe("get_article");
      expect(recording.contexts.paymentRequired[0].rawToolCall?.name).toBe("get_article");
    });

    it("keeps unknown argument keys that the input schema strips", async () => {
      const mcpServer = new McpServer({ name: "s", version: "1.0.0" });
      captureRawToolCalls(mcpServer);
      const paid = createPaymentWrapper(recording.resourceServer, { accepts: [requirements] });
      mcpServer.registerTool("get_article", { inputSchema: articleSchema }, paid(vi.fn()));
      client = await connect(mcpServer);

      const sent = { article: "A", lang: "de", unknown: { nested: [1, null, "x"] } };
      await client.callTool({ name: "get_article", arguments: sent });

      const context = recording.contexts.paymentRequired[0];
      expect(context.rawToolCall?.arguments).toEqual(sent);
      expect(context.arguments).toEqual({ article: "A", lang: "de" });
    });

    it("leaves arguments absent when the client omits them", async () => {
      const mcpServer = new McpServer({ name: "s", version: "1.0.0" });
      captureRawToolCalls(mcpServer);
      const paid = createPaymentWrapper(recording.resourceServer, { accepts: [requirements] });
      // A raw-shape schema makes the SDK reject omitted arguments; an object
      // schema with a default accepts them.
      mcpServer.registerTool(
        "list_articles",
        { inputSchema: z.object({ lang: z.string().default("en") }).default({}) },
        paid(vi.fn()),
      );
      client = await connect(mcpServer);

      await client.callTool({ name: "list_articles" });

      const context = recording.contexts.paymentRequired[0];
      expect(context.rawToolCall).toEqual({ name: "list_articles" });
      expect(context.rawToolCall).not.toHaveProperty("arguments");
      expect(context.arguments).toEqual({ lang: "en" });
    });

    it("carries the raw _meta, including payment and unrelated members", async () => {
      const mcpServer = new McpServer({ name: "s", version: "1.0.0" });
      captureRawToolCalls(mcpServer);
      const paid = createPaymentWrapper(recording.resourceServer, { accepts: [requirements] });
      mcpServer.registerTool("get_article", { inputSchema: articleSchema }, paid(vi.fn()));
      client = await connect(mcpServer);

      const meta = { "x402/payment": "not-a-payload", "example.com/account": null, traceId: "t" };
      await client.callTool({ name: "get_article", arguments: { article: "A" }, _meta: meta });

      const context = recording.contexts.paymentRequired[0];
      expect(context.rawToolCall).toEqual({
        name: "get_article",
        arguments: { article: "A" },
        _meta: meta,
      });
      expect(context.meta).toEqual(meta);
    });

    it("carries the raw call through verify and settle on a paid call", async () => {
      const mcpServer = new McpServer({ name: "s", version: "1.0.0" });
      captureRawToolCalls(mcpServer);
      const paid = createPaymentWrapper(recording.resourceServer, { accepts: [requirements] });
      const handler = vi.fn().mockResolvedValue(okResult);
      mcpServer.registerTool("get_article", { inputSchema: articleSchema }, paid(handler));
      client = await connect(mcpServer);

      const result = await client.callTool({
        name: "get_article",
        arguments: { article: "A" },
        _meta: { "x402/payment": payment },
      });

      expect(result.isError).toBeFalsy();
      expect(handler).toHaveBeenCalledWith(
        { article: "A", lang: "en" },
        expect.objectContaining({ toolName: "get_article" }),
      );
      const expected = {
        name: "get_article",
        arguments: { article: "A" },
        _meta: { "x402/payment": payment },
      };
      // Matching (createPaymentRequiredResponse), verify, and settle all see it.
      expect(recording.contexts.paymentRequired[0].rawToolCall).toEqual(expected);
      expect(recording.contexts.verify[0].rawToolCall).toEqual(expected);
      expect(recording.contexts.settle[0].rawToolCall).toEqual(expected);
      expect(recording.contexts.settle[0].result).toEqual(okResult);
    });

    it("snapshots the call so a handler mutating its arguments cannot change the binding", async () => {
      const mcpServer = new McpServer({ name: "s", version: "1.0.0" });
      captureRawToolCalls(mcpServer);
      const paid = createPaymentWrapper(recording.resourceServer, { accepts: [requirements] });
      const handler = vi.fn(async (args: { options: Record<string, unknown> }) => {
        // z.record passes nested values through by reference.
        args.options.injected = true;
        return okResult;
      });
      mcpServer.registerTool(
        "search",
        { inputSchema: { options: z.record(z.unknown()) } },
        paid(handler),
      );
      client = await connect(mcpServer);

      await client.callTool({
        name: "search",
        arguments: { options: { q: "x" } },
        _meta: { "x402/payment": payment },
      });

      expect(handler).toHaveBeenCalled();
      expect(recording.contexts.settle[0].rawToolCall?.arguments).toEqual({ options: { q: "x" } });
    });

    it("exposes a frozen snapshot", async () => {
      const mcpServer = new McpServer({ name: "s", version: "1.0.0" });
      captureRawToolCalls(mcpServer);
      let seen: MCPPaymentTransportContext | undefined;
      recording.mock.createPaymentRequiredResponse.mockImplementationOnce(
        async (accepts, resource, error, _extensions, transportContext) => {
          seen = transportContext;
          return { x402Version: 2, accepts, resource, error };
        },
      );
      const paid = createPaymentWrapper(recording.resourceServer, { accepts: [requirements] });
      mcpServer.registerTool(
        "search",
        { inputSchema: { q: z.object({ a: z.string() }) } },
        paid(vi.fn()),
      );
      client = await connect(mcpServer);

      await client.callTool({ name: "search", arguments: { q: { a: "x" } }, _meta: { m: {} } });

      const raw = seen?.rawToolCall;
      expect(raw).toBeDefined();
      expect(Object.isFrozen(raw)).toBe(true);
      expect(Object.isFrozen(raw?.arguments)).toBe(true);
      expect(Object.isFrozen(raw?.arguments?.q)).toBe(true);
      expect(Object.isFrozen(raw?._meta)).toBe(true);
      expect(Object.isFrozen(raw?._meta?.m)).toBe(true);
    });

    it("keeps concurrent calls apart", async () => {
      const mcpServer = new McpServer({ name: "s", version: "1.0.0" });
      captureRawToolCalls(mcpServer);
      const paid = createPaymentWrapper(recording.resourceServer, { accepts: [requirements] });
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      recording.mock.createPaymentRequiredResponse.mockImplementation(
        async (accepts, resource, error, _extensions, transportContext) => {
          await gate;
          recording.contexts.paymentRequired.push(snapshot(transportContext));
          return { x402Version: 2, accepts, resource, error };
        },
      );
      mcpServer.registerTool("get_article", { inputSchema: articleSchema }, paid(vi.fn()));
      mcpServer.registerTool("other_article", { inputSchema: articleSchema }, paid(vi.fn()));
      client = await connect(mcpServer);

      const calls = Promise.all([
        client.callTool({ name: "get_article", arguments: { article: "A" } }),
        client.callTool({ name: "other_article", arguments: { article: "B", lang: "fr" } }),
      ]);
      await new Promise(resolve => setTimeout(resolve, 10));
      release();
      await calls;

      const byName = Object.fromEntries(
        recording.contexts.paymentRequired.map(c => [c.toolName, c.rawToolCall]),
      );
      expect(byName).toEqual({
        get_article: { name: "get_article", arguments: { article: "A" } },
        other_article: { name: "other_article", arguments: { article: "B", lang: "fr" } },
      });
    });

    it("works with the legacy McpServer.tool() registration", async () => {
      const mcpServer = new McpServer({ name: "s", version: "1.0.0" });
      captureRawToolCalls(mcpServer);
      const paid = createPaymentWrapper(recording.resourceServer, { accepts: [requirements] });
      mcpServer.tool("get_article", "paid", articleSchema, paid(vi.fn()));
      client = await connect(mcpServer);

      await client.callTool({ name: "get_article", arguments: { article: "A" } });

      expect(recording.contexts.paymentRequired[0].rawToolCall).toEqual({
        name: "get_article",
        arguments: { article: "A" },
      });
    });

    it("works with a low-level Server whose handler passes extra through", async () => {
      const server = new Server({ name: "s", version: "1.0.0" }, { capabilities: { tools: {} } });
      captureRawToolCalls(server);
      const paid = createPaymentWrapper(recording.resourceServer, { accepts: [requirements] });
      const tool = paid(vi.fn());
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
        tool({ article: "A", lang: "en" }, extra),
      );
      client = await connect(server);

      await client.callTool({ name: "get_article", arguments: { article: "A" } });

      expect(recording.contexts.paymentRequired[0].rawToolCall).toEqual({
        name: "get_article",
        arguments: { article: "A" },
      });
      expect(recording.contexts.paymentRequired[0].toolName).toBe("get_article");
    });

    it("does not disturb other request handlers or free tools", async () => {
      const mcpServer = new McpServer({ name: "s", version: "1.0.0" });
      captureRawToolCalls(mcpServer);
      mcpServer.registerTool("free", { inputSchema: { q: z.string() } }, async ({ q }) => ({
        content: [{ type: "text", text: `free ${q}` }],
      }));
      client = await connect(mcpServer);

      const tools = await client.listTools();
      const result = await client.callTool({ name: "free", arguments: { q: "x" } });

      expect(tools.tools.map(t => t.name)).toEqual(["free"]);
      expect(result.content).toEqual([{ type: "text", text: "free x" }]);
    });

    it("is idempotent", async () => {
      const mcpServer = new McpServer({ name: "s", version: "1.0.0" });
      captureRawToolCalls(mcpServer);
      captureRawToolCalls(mcpServer);
      const paid = createPaymentWrapper(recording.resourceServer, { accepts: [requirements] });
      mcpServer.registerTool("get_article", { inputSchema: articleSchema }, paid(vi.fn()));
      client = await connect(mcpServer);

      await client.callTool({ name: "get_article", arguments: { article: "A" } });

      expect(recording.contexts.paymentRequired[0].rawToolCall).toEqual({
        name: "get_article",
        arguments: { article: "A" },
      });
    });

    it("refuses to install after a tools/call handler exists", () => {
      const mcpServer = new McpServer({ name: "s", version: "1.0.0" });
      mcpServer.registerTool("free", {}, async () => ({ content: [] }));

      expect(() => captureRawToolCalls(mcpServer)).toThrow(
        /captureRawToolCalls must be called before any tool is registered/,
      );
    });

    it("omits the raw call rather than exposing a live reference when it cannot be snapshotted", async () => {
      const mcpServer = new McpServer({ name: "s", version: "1.0.0" });
      captureRawToolCalls(mcpServer);
      const paid = createPaymentWrapper(recording.resourceServer, { accepts: [requirements] });
      mcpServer.registerTool("get_article", { inputSchema: articleSchema }, paid(vi.fn()));
      client = await connect(mcpServer);

      // Only reachable in-process: the in-memory transport passes objects by
      // reference, so a value that is not structured-cloneable can arrive.
      await client.callTool({
        name: "get_article",
        arguments: { article: "A" },
        _meta: { notCloneable: () => undefined },
      });

      const context = recording.contexts.paymentRequired[0];
      expect(context.rawToolCall).toBeUndefined();
      expect(context.toolName).toBe("paid_tool");
    });
  });

  describe("without captureRawToolCalls (backward compatible)", () => {
    it("keeps the previous transport context shape and placeholder name", async () => {
      const mcpServer = new McpServer({ name: "s", version: "1.0.0" });
      const paid = createPaymentWrapper(recording.resourceServer, { accepts: [requirements] });
      mcpServer.registerTool("get_article", { inputSchema: articleSchema }, paid(vi.fn()));
      client = await connect(mcpServer);

      await client.callTool({ name: "get_article", arguments: { article: "A" } });

      const context = recording.contexts.paymentRequired[0];
      expect(context).not.toHaveProperty("rawToolCall");
      expect(context.toolName).toBe("paid_tool");
      expect(context.arguments).toEqual({ article: "A", lang: "en" });
    });

    it("ignores extra objects that were not captured", async () => {
      const paid = createPaymentWrapper(recording.resourceServer, {
        accepts: [requirements],
        resource: { url: "mcp://tool/configured" },
      });

      await paid(vi.fn())({ article: "A" }, { _meta: { traceId: "t" } });

      const context = recording.contexts.paymentRequired[0];
      expect(context).not.toHaveProperty("rawToolCall");
      expect(context.toolName).toBe("configured");
    });
  });

  it("lists tools normally when only ListTools is registered on a low-level server", async () => {
    const server = new Server({ name: "s", version: "1.0.0" }, { capabilities: { tools: {} } });
    captureRawToolCalls(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    client = await connect(server);

    await expect(client.listTools()).resolves.toEqual({ tools: [] });
  });
});
