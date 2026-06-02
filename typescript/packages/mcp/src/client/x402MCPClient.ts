import type {
  PaymentPayload,
  PaymentRequired,
  SettleResponse,
  Network,
  SchemeNetworkClient,
} from "@x402/core/types";
import { isPaymentRequired } from "@x402/core/schemas";
import { x402Client } from "@x402/core/client";
import type { x402ClientConfig } from "@x402/core/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type {
  MCPResultWithMeta,
  PaymentRequestedContext,
  x402MCPClientOptions,
  PaymentRequiredHook,
  PaymentRequiredContext,
} from "../types";
import {
  MCP_PAYMENT_REQUIRED_CODE,
  MCP_PAYMENT_META_KEY,
  isPaymentRequiredError,
} from "../types";
import { extractPaymentResponseFromMeta } from "../utils";

// ============================================================================
// MCP SDK Result Types
// ============================================================================

/**
 * MCP content item - using a flexible type that matches the MCP SDK's content format.
 * The MCP SDK returns content items with a `type` discriminator and type-specific fields.
 * We use this type to preserve the original response structure from the SDK.
 */
export type MCPContentItem = {
  [key: string]: unknown;
  type: string;
};

/**
 * Result returned by MCP SDK callTool method.
 * This mirrors the SDK's CallToolResult type to ensure compatibility.
 */
interface MCPCallToolResult {
  content: MCPContentItem[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for MCP text content
 *
 * @param content - The content item to check
 * @returns True if the content is a text content item with a string text field
 */
function isMCPTextContent(content: MCPContentItem): content is MCPContentItem & { text: string } {
  return content.type === "text" && typeof content.text === "string";
}

/**
 * Type guard for MCPCallToolResult
 *
 * @param result - The result to check
 * @returns True if the result is a valid MCP call tool result
 */
function isMCPCallToolResult(result: unknown): result is MCPCallToolResult {
  if (typeof result !== "object" || result === null) {
    return false;
  }

  const obj = result as Record<string, unknown>;
  return Array.isArray(obj.content);
}

// ============================================================================
// Hook Types
// ============================================================================

/**
 * Hook called before payment is created
 */
export type BeforePaymentHook = (context: PaymentRequestedContext) => Promise<void> | void;

/**
 * Hook called after payment is submitted
 */
export type AfterPaymentHook = (context: {
  toolName: string;
  paymentPayload: PaymentPayload;
  result: MCPResultWithMeta;
  settleResponse: SettleResponse | null;
}) => Promise<void> | void;

// ============================================================================
// Public Types
// ============================================================================

/**
 * Result of a tool call with payment metadata.
 * Content is forwarded directly from the MCP SDK to preserve the original response structure.
 */
export interface x402MCPToolCallResult {
  /** The tool result content, forwarded directly from MCP SDK */
  content: MCPContentItem[];
  /** Whether the tool returned an error */
  isError?: boolean;
  /** Payment settlement response if payment was made */
  paymentResponse?: SettleResponse;
  /** Whether payment was required and submitted */
  paymentMade: boolean;
}

/**
 * x402-enabled MCP client that handles payment for tool calls.
 *
 * Wraps an MCP client to automatically detect 402 (payment required) errors
 * from tool calls, create payment payloads, and retry with payment attached.
 *
 * PROTOCOL COMPLIANCE:
 * This wrapper is a COMPLETE, TRANSPARENT passthrough exposing all 19 public methods
 * from the MCP SDK Client class. It's suitable for any MCP use case including:
 * - Chatbots and conversational agents
 * - IDE integrations (like Cursor, VSCode)
 * - Autonomous agents
 * - Custom MCP applications
 *
 * Only callTool() is enhanced with payment handling. All other methods are direct
 * passthroughs ensuring full MCP protocol compatibility.
 *
 * STABILITY:
 * Depends on formal MCP specification (JSON-RPC 2.0 based) with semantic versioning.
 * Proven stable across SDK versions: 1.9.0 → 1.12.1 → 1.15.1
 *
 * @example
 * ```typescript
 * import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 * import { x402MCPClient } from "@x402/mcp";
 * import { x402Client } from "@x402/core/client";
 * import { ExactEvmScheme } from "@x402/evm/exact/client";
 *
 * const paymentClient = new x402Client()
 *   .register("eip155:84532", new ExactEvmScheme(account));
 *
 * const mcpClient = new Client({ name: "my-agent", version: "1.0.0" }, {...});
 * const x402Mcp = new x402MCPClient(mcpClient, paymentClient, {
 *   autoPayment: true,
 *   onPaymentRequested: async ({ paymentRequired }) => {
 *     return confirm(`Pay ${paymentRequired.accepts[0].amount}?`);
 *   },
 * });
 *
 * await x402Mcp.connect(transport);
 *
 * // Full MCP protocol access - all 19 methods available
 * const tools = await x402Mcp.listTools();
 * const resource = await x402Mcp.readResource({ uri: "file://..." });
 * const prompt = await x402Mcp.getPrompt({ name: "code-review" });
 * const result = await x402Mcp.callTool("financial_analysis", { ticker: "AAPL" });
 * ```
 */
export class x402MCPClient {
  private readonly mcpClient: Client;
  private readonly _paymentClient: x402Client;
  private readonly options: Required<x402MCPClientOptions>;
  private readonly paymentRequiredHooks: PaymentRequiredHook[] = [];
  private readonly beforePaymentHooks: BeforePaymentHook[] = [];
  private readonly afterPaymentHooks: AfterPaymentHook[] = [];

  /**
   * Creates a new x402MCPClient instance.
   *
   * @param mcpClient - The underlying MCP client instance
   * @param paymentClient - The x402 client for creating payment payloads
   * @param options - Configuration options
   */
  constructor(
    mcpClient: Client,
    paymentClient: x402Client,
    options: x402MCPClientOptions = {},
  ) {
    this.mcpClient = mcpClient;
    this._paymentClient = paymentClient;
    this.options = {
      autoPayment: options.autoPayment ?? true,
      onPaymentRequested: options.onPaymentRequested ?? (() => true),
    };
  }

  /**
   * Get the underlying MCP client instance.
   *
   * @returns The MCP client instance
   */
  get client(): Client {
    return this.mcpClient;
  }

  /**
   * Get the underlying x402 payment client instance.
   *
   * @returns The x402 client instance
   */
  get paymentClient(): x402Client {
    return this._paymentClient;
  }

  /**
   * Connect to an MCP server transport.
   * Passthrough to the underlying MCP client.
   *
   * @param transport - The transport to connect to
   * @returns Promise that resolves when connected
   */
  async connect(transport: Parameters<Client["connect"]>[0]): Promise<void> {
    await this.mcpClient.connect(transport);
  }

  /**
   * Close the MCP connection.
   * Passthrough to the underlying MCP client.
   *
   * @returns Promise that resolves when closed
   */
  async close(): Promise<void> {
    await this.mcpClient.close();
  }

  /**
   * List available tools from the server.
   * Passthrough to the underlying MCP client.
   *
   * @returns Promise resolving to the list of tools
   */
  async listTools(): ReturnType<Client["listTools"]> {
    return this.mcpClient.listTools();
  }

  /**
   * List available resources from the server.
   * Passthrough to the underlying MCP client.
   *
   * @returns Promise resolving to the list of resources
   */
  async listResources(): ReturnType<Client["listResources"]> {
    return this.mcpClient.listResources();
  }

  /**
   * List available prompts from the server.
   * Passthrough to the underlying MCP client.
   *
   * @returns Promise resolving to the list of prompts
   */
  async listPrompts(): ReturnType<Client["listPrompts"]> {
    return this.mcpClient.listPrompts();
  }

  /**
   * Get a specific prompt from the server.
   * Passthrough to the underlying MCP client.
   *
   * @param args - Arguments for getPrompt method
   * @returns Promise resolving to the prompt
   */
  async getPrompt(...args: Parameters<Client["getPrompt"]>): ReturnType<Client["getPrompt"]> {
    return this.mcpClient.getPrompt(...args);
  }

  /**
   * Read a resource from the server.
   * Passthrough to the underlying MCP client.
   *
   * @param args - Arguments for readResource method
   * @returns Promise resolving to the resource content
   */
  async readResource(...args: Parameters<Client["readResource"]>): ReturnType<Client["readResource"]> {
    return this.mcpClient.readResource(...args);
  }

  /**
   * List resource templates from the server.
   * Passthrough to the underlying MCP client.
   *
   * @param args - Arguments for listResourceTemplates method
   * @returns Promise resolving to the list of resource templates
   */
  async listResourceTemplates(...args: Parameters<Client["listResourceTemplates"]>): ReturnType<Client["listResourceTemplates"]> {
    return this.mcpClient.listResourceTemplates(...args);
  }

  /**
   * Subscribe to resource updates.
   * Passthrough to the underlying MCP client.
   *
   * @param args - Arguments for subscribeResource method
   * @returns Promise resolving when subscribed
   */
  async subscribeResource(...args: Parameters<Client["subscribeResource"]>): ReturnType<Client["subscribeResource"]> {
    return this.mcpClient.subscribeResource(...args);
  }

  /**
   * Unsubscribe from resource updates.
   * Passthrough to the underlying MCP client.
   *
   * @param args - Arguments for unsubscribeResource method
   * @returns Promise resolving when unsubscribed
   */
  async unsubscribeResource(...args: Parameters<Client["unsubscribeResource"]>): ReturnType<Client["unsubscribeResource"]> {
    return this.mcpClient.unsubscribeResource(...args);
  }

  /**
   * Ping the server.
   * Passthrough to the underlying MCP client.
   *
   * @param args - Arguments for ping method
   * @returns Promise resolving to ping response
   */
  async ping(...args: Parameters<Client["ping"]>): ReturnType<Client["ping"]> {
    return this.mcpClient.ping(...args);
  }

  /**
   * Request completion suggestions.
   * Passthrough to the underlying MCP client.
   *
   * @param args - Arguments for complete method
   * @returns Promise resolving to completion suggestions
   */
  async complete(...args: Parameters<Client["complete"]>): ReturnType<Client["complete"]> {
    return this.mcpClient.complete(...args);
  }

  /**
   * Set the logging level on the server.
   * Passthrough to the underlying MCP client.
   *
   * @param args - Arguments for setLoggingLevel method
   * @returns Promise resolving when level is set
   */
  async setLoggingLevel(...args: Parameters<Client["setLoggingLevel"]>): ReturnType<Client["setLoggingLevel"]> {
    return this.mcpClient.setLoggingLevel(...args);
  }

  /**
   * Get server capabilities after initialization.
   * Passthrough to the underlying MCP client.
   *
   * @returns Server capabilities or undefined if not initialized
   */
  getServerCapabilities(): ReturnType<Client["getServerCapabilities"]> {
    return this.mcpClient.getServerCapabilities();
  }

  /**
   * Get server version information after initialization.
   * Passthrough to the underlying MCP client.
   *
   * @returns Server version info or undefined if not initialized
   */
  getServerVersion(): ReturnType<Client["getServerVersion"]> {
    return this.mcpClient.getServerVersion();
  }

  /**
   * Get server instructions after initialization.
   * Passthrough to the underlying MCP client.
   *
   * @returns Server instructions or undefined if not initialized
   */
  getInstructions(): ReturnType<Client["getInstructions"]> {
    return this.mcpClient.getInstructions();
  }

  /**
   * Send notification that roots list has changed.
   * Passthrough to the underlying MCP client.
   *
   * @returns Promise resolving when notification is sent
   */
  async sendRootsListChanged(): ReturnType<Client["sendRootsListChanged"]> {
    return this.mcpClient.sendRootsListChanged();
  }

  /**
   * Register a hook to run when a 402 payment required is received.
   * Hooks run in order; first to return a result wins.
   *
   * This can be used to:
   * - Provide pre-existing payment payloads (implementation-specific, not part of x402 spec)
   * - Abort the payment flow for certain tools
   * - Log or track payment required events
   *
   * Note: Payment caching is an implementation pattern and not defined in the x402 MCP
   * transport specification. Implementations that cache payments should ensure cached
   * payloads are still valid (not expired, correct nonce, etc.).
   *
   * @param hook - Hook function
   * @returns This instance for chaining
   *
   * @example
   * ```typescript
   * // Example: Custom payment handling (implementation-specific)
   * client.onPaymentRequired(async ({ toolName, paymentRequired }) => {
   *   // Custom logic to provide a payment or abort
   *   if (shouldAbort(toolName)) {
   *     return { abort: true };
   *   }
   *   // Return undefined to proceed with normal payment flow
   * });
   * ```
   */
  onPaymentRequired(hook: PaymentRequiredHook): this {
    this.paymentRequiredHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to run before payment is created.
   *
   * @param hook - Hook function
   * @returns This instance for chaining
   */
  onBeforePayment(hook: BeforePaymentHook): this {
    this.beforePaymentHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to run after payment is submitted.
   *
   * @param hook - Hook function
   * @returns This instance for chaining
   */
  onAfterPayment(hook: AfterPaymentHook): this {
    this.afterPaymentHooks.push(hook);
    return this;
  }

  /**
   * Calls a tool, automatically handling 402 payment required errors.
   *
   * If the tool returns a 402 error and autoPayment is enabled, this method
   * will automatically create a payment payload and retry the tool call.
   *
   * @param name - The name of the tool to call
   * @param args - Arguments to pass to the tool
   * @param options - Optional MCP request options (timeout, signal, etc.)
   * @param options.timeout - Request timeout in milliseconds (default: 60000)
   * @param options.signal - AbortSignal for cancellation
   * @param options.resetTimeoutOnProgress - If true, progress notifications reset the timeout
   * @returns The tool result with payment metadata
   * @throws Error if payment is required but autoPayment is disabled and no payment provided
   * @throws Error if payment approval is denied
   * @throws Error if payment creation fails
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options?: { timeout?: number; signal?: AbortSignal; resetTimeoutOnProgress?: boolean },
  ): Promise<x402MCPToolCallResult> {
    // First attempt without payment
    let result: MCPCallToolResult;
    let paymentRequired: PaymentRequired | null = null;

    try {
      const rawResult = await this.mcpClient.callTool(
        { name, arguments: args },
        undefined,
        options,
      );

      if (!isMCPCallToolResult(rawResult)) {
        throw new Error("Invalid MCP tool result: missing content array");
      }

      result = rawResult;
      paymentRequired = this.extractPaymentRequiredFromResult(result);
    } catch (error: unknown) {
      // Handle MCP UrlElicitationRequired (-32042) used for payment flows (SEP-1036).
      // The MCP SDK throws McpError for -32042 with error.data preserved.
      const extracted = this.extractPaymentRequiredFromError(error);
      if (extracted) {
        paymentRequired = extracted;
        result = { content: [], isError: true };
      } else {
        throw error;
      }
    }

    if (!paymentRequired) {
      // Not a payment required response, forward original MCP response as-is
      return {
        content: result.content,
        isError: result.isError,
        paymentMade: false,
      };
    }

    // Payment required - run onPaymentRequired hooks first
    const paymentRequiredContext: PaymentRequiredContext = {
      toolName: name,
      arguments: args,
      paymentRequired,
    };

    // Run payment required hooks - first to return a result wins
    for (const hook of this.paymentRequiredHooks) {
      const hookResult = await hook(paymentRequiredContext);
      if (hookResult) {
        if (hookResult.abort) {
          throw new Error("Payment aborted by hook");
        }
        if (hookResult.payment) {
          // Use the hook-provided payment
          return this.callToolWithPayment(name, args, hookResult.payment, options);
        }
      }
    }

    // No hook handled it, proceed with normal flow
    if (!this.options.autoPayment) {
      // Auto-payment disabled, throw with payment info
      const err = new Error("Payment required") as Error & {
        code: number;
        paymentRequired: PaymentRequired;
      };
      err.code = MCP_PAYMENT_REQUIRED_CODE;
      err.paymentRequired = paymentRequired;
      throw err;
    }

    // Create payment requested context
    const paymentRequestedContext: PaymentRequestedContext = {
      toolName: name,
      arguments: args,
      paymentRequired,
    };

    // Check if payment is approved via onPaymentRequested hook
    const approved = await this.options.onPaymentRequested(paymentRequestedContext);
    if (!approved) {
      throw new Error("Payment request denied");
    }

    // Run before payment hooks
    for (const hook of this.beforePaymentHooks) {
      await hook(paymentRequestedContext);
    }

    // Create payment payload
    const paymentPayload = await this._paymentClient.createPaymentPayload(paymentRequired);

    // Retry with payment
    return this.callToolWithPayment(name, args, paymentPayload, options);
  }

  /**
   * Calls a tool with an explicit payment payload.
   *
   * Use this method when you want to provide payment upfront or when
   * implementing custom payment handling.
   *
   * @param name - The name of the tool to call
   * @param args - Arguments to pass to the tool
   * @param paymentPayload - The payment payload to include
   * @param options - Optional MCP request options (timeout, signal, etc.)
   * @param options.timeout - Request timeout in milliseconds (default: 60000)
   * @param options.signal - AbortSignal for cancellation
   * @param options.resetTimeoutOnProgress - If true, progress notifications reset the timeout
   * @returns The tool result with payment metadata
   */
  async callToolWithPayment(
    name: string,
    args: Record<string, unknown>,
    paymentPayload: PaymentPayload,
    options?: { timeout?: number; signal?: AbortSignal; resetTimeoutOnProgress?: boolean },
  ): Promise<x402MCPToolCallResult> {
    // Build the call parameters with payment metadata
    // Note: The MCP SDK's callTool accepts _meta but the types don't always expose it
    const callParams = {
      name,
      arguments: args,
      _meta: {
        [MCP_PAYMENT_META_KEY]: paymentPayload,
      },
    };

    // Call with payment in _meta
    const result = await this.mcpClient.callTool(callParams, undefined, options);

    // Validate result structure
    if (!isMCPCallToolResult(result)) {
      throw new Error("Invalid MCP tool result: missing content array");
    }

    // Build result with meta for extraction (preserve _meta if present)
    const resultWithMeta: MCPResultWithMeta = {
      content: result.content,
      isError: result.isError,
      _meta: result._meta,
    };

    // Extract payment response from _meta
    const paymentResponse = extractPaymentResponseFromMeta(resultWithMeta);

    // Run after payment hooks
    for (const hook of this.afterPaymentHooks) {
      await hook({
        toolName: name,
        paymentPayload,
        result: resultWithMeta,
        settleResponse: paymentResponse,
      });
    }

    const paymentRequired = this.extractPaymentRequiredFromResult(result);
    const recoveryResult = paymentPayload.accepted
      ? await this._paymentClient.handlePaymentResponse({
          paymentPayload,
          requirements: paymentPayload.accepted,
          ...(paymentResponse ? { settleResponse: paymentResponse } : {}),
          ...(paymentRequired ? { paymentRequired } : {}),
        })
      : undefined;

    // A paid attempt can return a corrective 402. Scheme hooks recover local
    // state from it, then we retry once with a fresh payload from that response.
    if (recoveryResult?.recovered && paymentRequired) {
      const freshPayload = await this._paymentClient.createPaymentPayload(paymentRequired);
      const retryCallParams = {
        name,
        arguments: args,
        _meta: {
          [MCP_PAYMENT_META_KEY]: freshPayload,
        },
      };
      const retryResult = await this.mcpClient.callTool(retryCallParams, undefined, options);

      if (!isMCPCallToolResult(retryResult)) {
        throw new Error("Invalid MCP tool result: missing content array");
      }

      const retryResultWithMeta: MCPResultWithMeta = {
        content: retryResult.content,
        isError: retryResult.isError,
        _meta: retryResult._meta,
      };
      const retryPaymentResponse = extractPaymentResponseFromMeta(retryResultWithMeta);

      for (const hook of this.afterPaymentHooks) {
        await hook({
          toolName: name,
          paymentPayload: freshPayload,
          result: retryResultWithMeta,
          settleResponse: retryPaymentResponse,
        });
      }

      const retryCorrectivePaymentRequired = this.extractPaymentRequiredFromResult(retryResult);
      if (freshPayload.accepted) {
        await this._paymentClient.handlePaymentResponse({
          paymentPayload: freshPayload,
          requirements: freshPayload.accepted,
          ...(retryPaymentResponse ? { settleResponse: retryPaymentResponse } : {}),
          ...(retryCorrectivePaymentRequired
            ? { paymentRequired: retryCorrectivePaymentRequired }
            : {}),
        });
      }

      return {
        content: retryResult.content,
        isError: retryResult.isError,
        paymentResponse: retryPaymentResponse ?? undefined,
        paymentMade: true,
      };
    }

    // Forward original MCP response content as-is
    return {
      content: result.content,
      isError: result.isError,
      paymentResponse: paymentResponse ?? undefined,
      paymentMade: true,
    };
  }

  /**
   * Probes a tool to discover its payment requirements.
   *
   * **WARNING: Side Effects** - This method actually calls the tool to trigger a 402 response.
   * If the tool is free (no payment required), it will execute and return null.
   * Use with caution on tools that have side effects or are expensive to run.
   *
   * Useful for displaying pricing information to users before calling paid tools.
   *
   * @param name - The name of the tool to probe
   * @param args - Arguments that may affect pricing (for dynamic pricing scenarios)
   * @returns The payment requirements if the tool requires payment, null if the tool is free
   *
   * @example
   * ```typescript
   * // Check if a tool requires payment before calling
   * const requirements = await client.getToolPaymentRequirements("expensive_analysis");
   *
   * if (requirements) {
   *   const price = requirements.accepts[0];
   *   console.log(`This tool costs ${price.amount} on ${price.network}`);
   *   // Optionally show user and get confirmation before calling
   * } else {
   *   console.log("This tool is free");
   *   // Note: the tool has already executed!
   * }
   * ```
   */
  async getToolPaymentRequirements(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<PaymentRequired | null> {
    // Note: This actually calls the tool to trigger 402 if paid.
    // If the tool is free, it will execute as a side effect.
    try {
      const result = await this.mcpClient.callTool({ name, arguments: args });

      if (!isMCPCallToolResult(result)) {
        return null;
      }

      return this.extractPaymentRequiredFromResult(result);
    } catch (error: unknown) {
      // Handle McpError(-32042) payment challenges; re-throw anything else
      // so non-payment failures aren't indistinguishable from "free tool"
      // (mirrors callTool's catch above).
      const extracted = this.extractPaymentRequiredFromError(error);
      if (extracted) {
        return extracted;
      }
      throw error;
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Extracts PaymentRequired from a tool result (structured 402 response).
   *
   * Per MCP transport spec, supports:
   * 1. structuredContent with direct PaymentRequired object (optional, preferred)
   * 2. content[0].text with JSON-encoded PaymentRequired object (required)
   *
   * @param result - The tool call result
   * @returns PaymentRequired if this is a 402 response, null otherwise
   */
  private extractPaymentRequiredFromResult(result: MCPCallToolResult): PaymentRequired | null {
    // Only check if isError is true
    if (!result.isError) {
      return null;
    }

    if (result.structuredContent) {
      const extracted = this.extractPaymentRequiredFromObject(result.structuredContent);
      if (extracted) {
        return extracted;
      }
    }

    const content = result.content;
    if (content.length === 0) {
      return null;
    }

    const firstItem = content[0];
    if (!isMCPTextContent(firstItem)) {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(firstItem.text);
      if (typeof parsed === "object" && parsed !== null) {
        const extracted = this.extractPaymentRequiredFromObject(
          parsed as Record<string, unknown>,
        );
        if (extracted) {
          return extracted;
        }
      }
    } catch {
      // Not JSON, not our structured response
    }

    return null;
  }

  /**
   * Extracts PaymentRequired from an object.
   * Expects direct PaymentRequired format (per MCP transport spec).
   *
   * @param obj - The object to extract from
   * @returns PaymentRequired if found, null otherwise
   */
  private extractPaymentRequiredFromObject(obj: Record<string, unknown>): PaymentRequired | null {
    if (isPaymentRequired(obj)) {
      return obj as PaymentRequired;
    }

    return null;
  }

  /**
   * Extracts PaymentRequired from a thrown MCP error.
   *
   * Uses isPaymentRequiredError() to validate the error structure (supports
   * both 402 and -32042 codes), then extracts PaymentRequired from the
   * correct location (error.data directly or error.data.x402 for namespaced
   * -32042 errors).
   *
   * @param error - The caught error
   * @returns PaymentRequired if this is a payment error, null otherwise
   */
  private extractPaymentRequiredFromError(error: unknown): PaymentRequired | null {
    if (!isPaymentRequiredError(error)) {
      return null;
    }

    return "x402" in error.data ? error.data.x402 : error.data;
  }

}

/**
 * Configuration for createx402MCPClient factory
 */
export interface x402MCPClientConfig {
  /** MCP client name */
  name: string;

  /** MCP client version */
  version: string;

  /**
   * Payment scheme registrations.
   * Each registration maps a network to its scheme client implementation.
   */
  schemes: Array<{
    network: Network;
    client: SchemeNetworkClient;
    x402Version?: number;
  }>;

  /**
   * Whether to automatically retry tool calls with payment on 402 errors.
   *
   * @default true
   */
  autoPayment?: boolean;

  /**
   * Hook called when a payment is requested.
   * Return true to proceed with payment, false to abort.
   */
  onPaymentRequested?: (context: PaymentRequestedContext) => Promise<boolean> | boolean;

  /**
   * Additional MCP client options
   */
  mcpClientOptions?: Record<string, unknown>;
}

/**
 * Wraps an existing MCP client with x402 payment handling.
 *
 * Use this when you already have an MCP client instance and want to add
 * payment capabilities. For a simpler setup, use createx402MCPClient instead.
 *
 * @param mcpClient - The MCP client to wrap
 * @param paymentClient - The x402 client for payment handling
 * @param options - Configuration options
 * @returns An x402MCPClient instance
 *
 * @example
 * ```typescript
 * import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 * import { wrapMCPClientWithPayment } from "@x402/mcp";
 * import { x402Client } from "@x402/core/client";
 * import { ExactEvmScheme } from "@x402/evm/exact/client";
 *
 * const mcpClient = new Client({ name: "my-agent", version: "1.0.0" });
 * const paymentClient = new x402Client()
 *   .register("eip155:84532", new ExactEvmScheme(account));
 *
 * const x402Mcp = wrapMCPClientWithPayment(mcpClient, paymentClient, {
 *   autoPayment: true,
 * });
 *
 * await x402Mcp.connect(transport);
 * const result = await x402Mcp.callTool("paid_tool", { arg: "value" });
 * ```
 */
export function wrapMCPClientWithPayment(
  mcpClient: Client,
  paymentClient: x402Client,
  options?: x402MCPClientOptions,
): x402MCPClient {
  return new x402MCPClient(mcpClient, paymentClient, options);
}

/**
 * Wraps an existing MCP client with x402 payment handling using a config object.
 *
 * Similar to wrapMCPClientWithPayment but uses a configuration object for
 * setting up the payment client, similar to the axios pattern.
 *
 * @param mcpClient - The MCP client to wrap
 * @param config - Payment client configuration
 * @param options - x402 MCP client options
 * @returns An x402MCPClient instance
 *
 * @example
 * ```typescript
 * import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 * import { wrapMCPClientWithPaymentFromConfig } from "@x402/mcp";
 * import { ExactEvmScheme } from "@x402/evm/exact/client";
 *
 * const mcpClient = new Client({ name: "my-agent", version: "1.0.0" });
 *
 * const x402Mcp = wrapMCPClientWithPaymentFromConfig(mcpClient, {
 *   schemes: [
 *     { network: "eip155:84532", client: new ExactEvmScheme(account) },
 *   ],
 * });
 *
 * await x402Mcp.connect(transport);
 * ```
 */
export function wrapMCPClientWithPaymentFromConfig(
  mcpClient: Client,
  config: x402ClientConfig,
  options?: x402MCPClientOptions,
): x402MCPClient {
  const paymentClient = x402Client.fromConfig(config);
  return new x402MCPClient(mcpClient, paymentClient, options);
}

/**
 * Creates a fully configured x402 MCP client with sensible defaults.
 *
 * This factory function provides the simplest way to create an x402-enabled MCP client.
 * It handles creation of both the underlying MCP Client and x402Client, making it
 * easy to get started with paid tool calls.
 *
 * @param config - Client configuration options
 * @returns A configured x402MCPClient instance
 *
 * @example
 * ```typescript
 * import { createx402MCPClient } from "@x402/mcp";
 * import { ExactEvmScheme } from "@x402/evm/exact/client";
 * import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
 *
 * const client = createx402MCPClient({
 *   name: "my-agent",
 *   version: "1.0.0",
 *   schemes: [
 *     { network: "eip155:84532", client: new ExactEvmScheme(account) },
 *   ],
 *   autoPayment: true,
 *   onPaymentRequested: async ({ paymentRequired }) => {
 *     console.log(`Payment required: ${paymentRequired.accepts[0].amount}`);
 *     return true; // Auto-approve
 *   },
 * });
 *
 * // Connect to server
 * const transport = new SSEClientTransport(new URL("http://localhost:4022/sse"));
 * await client.connect(transport);
 *
 * // List available tools
 * const { tools } = await client.listTools();
 *
 * // Call a paid tool (payment handled automatically)
 * const result = await client.callTool("get_weather", { city: "NYC" });
 * ```
 */
export function createx402MCPClient(config: x402MCPClientConfig): x402MCPClient {
  // Create MCP client
  const mcpClient = new Client(
    {
      name: config.name,
      version: config.version,
    },
    config.mcpClientOptions,
  );

  // Create x402 payment client
  const paymentClient = new x402Client();

  // Register schemes
  for (const scheme of config.schemes) {
    if (scheme.x402Version === 1) {
      paymentClient.registerV1(scheme.network, scheme.client);
    } else {
      paymentClient.register(scheme.network, scheme.client);
    }
  }

  // Create x402MCPClient with options
  return new x402MCPClient(mcpClient, paymentClient, {
    autoPayment: config.autoPayment,
    onPaymentRequested: config.onPaymentRequested,
  });
}
