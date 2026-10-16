/**
 * Capture of raw MCP `tools/call` requests for request-bound payment schemes.
 *
 * `McpServer` validates `params.arguments` against the tool's input schema
 * before it invokes the tool callback, so the callback (and therefore the
 * payment wrapper) only sees the validated arguments: defaults applied,
 * unknown keys stripped, transformations run. It also never passes the tool
 * name. Schemes that bind a payment to the call the client actually made need
 * the request as received instead.
 *
 * The MCP SDK has no public hook that hands a tool callback the raw request,
 * but every request handler receives the same `extra` object that `McpServer`
 * later passes to the tool callback. `captureRawToolCalls` wraps the server's
 * `tools/call` handler at registration time, snapshots the request's params
 * keyed by that `extra` object, and the payment wrapper looks them up.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import type { MCPRawToolCall } from "../types";
import { isObject } from "../utils/encoding";

type RequestHandler = (request: unknown, extra: unknown) => unknown;

interface RequestHandlerHost {
  setRequestHandler(schema: unknown, handler: RequestHandler): void;
  assertCanSetRequestHandler(method: string): void;
}

const TOOLS_CALL = "tools/call";

/** Snapshots keyed by the per-request `extra` object; entries die with the request. */
const rawToolCalls = new WeakMap<object, MCPRawToolCall>();

/** Low-level servers whose `setRequestHandler` is already intercepted. */
const capturingHosts = new WeakSet<object>();

/**
 * Makes the raw `tools/call` request available to payment schemes as
 * `rawToolCall` in the transport context passed by `createPaymentWrapper`.
 *
 * Call it once per server, right after constructing it and before registering
 * any tool: `McpServer` installs its `tools/call` handler with the first tool
 * registration, and only handlers installed after this call are observed. It
 * throws if a `tools/call` handler already exists. Calling it again on the
 * same server is a no-op.
 *
 * Accepts an `McpServer` or a low-level `Server`. With a low-level server,
 * pass the handler's `extra` argument unchanged to the paid tool callback.
 *
 * @param server - The MCP server whose tool calls should be captured
 * @throws Error if a `tools/call` handler is already registered on the server
 *
 * @example
 * ```typescript
 * const mcpServer = new McpServer({ name: "articles", version: "1.0.0" });
 * captureRawToolCalls(mcpServer);
 *
 * const paid = createPaymentWrapper(resourceServer, { accepts });
 * mcpServer.registerTool("get_article", { inputSchema }, paid(handler));
 * ```
 */
export function captureRawToolCalls(server: McpServer | Server): void {
  const host = requestHandlerHost(server);
  if (capturingHosts.has(host)) {
    return;
  }

  try {
    host.assertCanSetRequestHandler(TOOLS_CALL);
  } catch (cause) {
    throw new Error(
      "[x402] captureRawToolCalls must be called before any tool is registered on the server " +
        "(a tools/call handler already exists)",
      { cause },
    );
  }

  const setRequestHandler = host.setRequestHandler.bind(host);
  host.setRequestHandler = (schema, handler) =>
    setRequestHandler(schema, (request, extra) => {
      recordRawToolCall(request, extra);
      return handler(request, extra);
    });
  capturingHosts.add(host);
}

/**
 * Returns the raw call captured for a tool callback's `extra` argument.
 *
 * @param extra - The `extra` argument the MCP SDK passed to the tool callback
 * @returns The captured call, or undefined when none was captured
 */
export function getRawToolCall(extra: unknown): MCPRawToolCall | undefined {
  return isObject(extra) ? rawToolCalls.get(extra) : undefined;
}

/**
 * Resolves the object that owns request handlers: the low-level `Server`.
 *
 * @param server - An `McpServer` or a low-level `Server`
 * @returns The low-level server
 */
function requestHandlerHost(server: McpServer | Server): RequestHandlerHost {
  const candidate = server as unknown as Partial<RequestHandlerHost> & { server?: unknown };
  if (typeof candidate.setRequestHandler === "function") {
    return candidate as RequestHandlerHost;
  }
  return candidate.server as RequestHandlerHost;
}

/**
 * Stores a frozen snapshot of a `tools/call` request's params, keyed by the
 * request's `extra` object. Other requests are ignored.
 *
 * `name` and `arguments` come from the request the SDK dispatched, which it
 * has checked against the generic `tools/call` shape (a string name and an
 * object of arbitrary values) but not against any tool's input schema.
 * `_meta` comes from `extra._meta`, which the SDK takes directly from the
 * received message.
 *
 * A request that cannot be snapshotted (only possible in-process, since JSON
 * values always can) is not recorded, so schemes never see a live reference
 * the handler could mutate.
 *
 * @param request - The request passed to the `tools/call` handler
 * @param extra - The request's handler context
 */
function recordRawToolCall(request: unknown, extra: unknown): void {
  if (!isObject(request) || request.method !== TOOLS_CALL || !isObject(extra)) {
    return;
  }
  const params = request.params;
  if (!isObject(params) || typeof params.name !== "string") {
    return;
  }

  const call: { name: string; arguments?: unknown; _meta?: unknown } = { name: params.name };
  if (params.arguments !== undefined) {
    call.arguments = params.arguments;
  }
  if (extra._meta !== undefined) {
    call._meta = extra._meta;
  }

  let snapshot: MCPRawToolCall;
  try {
    snapshot = deepFreeze(structuredClone(call)) as MCPRawToolCall;
  } catch {
    return;
  }
  rawToolCalls.set(extra, snapshot);
}

/**
 * Freezes a value and everything reachable from it.
 *
 * @param value - A structured-clone result (plain data; cycles are fine)
 * @returns The same value, frozen
 */
function deepFreeze<T>(value: T): T {
  if (isObject(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
