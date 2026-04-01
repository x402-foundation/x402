/**
 * Payment wrapper for MCP tool handlers
 *
 * This module provides a functional API for adding x402 payment to MCP tool handlers.
 * Use createPaymentWrapper to wrap tool handlers with payment verification and settlement.
 */

import type { PaymentRequirements } from "@x402/core/types";
import { x402ResourceServer } from "@x402/core/server";

import type {
  MCPToolContext,
  BeforeExecutionHook,
  AfterExecutionHook,
  AfterSettlementHook,
  ServerHookContext,
  AfterExecutionContext,
  SettlementContext,
} from "../types";
import { MCP_PAYMENT_RESPONSE_META_KEY } from "../types";
import { createToolResourceUrl, extractPaymentFromMeta } from "../utils";

/**
 * Configuration for payment wrapper.
 */
export interface PaymentWrapperConfig {
  /**
   * Payment requirements that must be satisfied to call the tool.
   * Typically a single entry, but can support multiple payment options.
   *
   * Each requirement specifies:
   * - scheme: Payment scheme identifier (e.g., "exact")
   * - network: Blockchain network in CAIP-2 format (e.g., "eip155:84532")
   * - amount: Payment amount in token's smallest unit
   * - asset: Token contract address
   * - payTo: Recipient wallet address
   * - maxTimeoutSeconds: Payment timeout (optional)
   * - extra: Scheme-specific data (optional)
   */
  accepts: PaymentRequirements[];

  /** Resource metadata for the tool */
  resource?: {
    /** Custom URL for the resource (defaults to mcp://tool/{toolName}) */
    url?: string;
    /** Human-readable description of the tool */
    description?: string;
    /** MIME type of the tool response */
    mimeType?: string;
  };

  /** Hooks for payment lifecycle events */
  hooks?: {
    /** Called after payment verification, before tool execution. Return false to abort. */
    onBeforeExecution?: BeforeExecutionHook;
    /** Called after tool execution, before settlement */
    onAfterExecution?: AfterExecutionHook;
    /** Called after successful settlement */
    onAfterSettlement?: AfterSettlementHook;
  };
}

/**
 * Result type for wrapped tool handlers.
 * Matches the MCP SDK's expected tool result format with optional _meta.
 */
export interface WrappedToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
}

/**
 * Tool result type without payment metadata
 */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Handler function type for tools to be wrapped with payment.
 */
export type PaymentWrappedHandler<TArgs = Record<string, unknown>> = (
  args: TArgs,
  context: MCPToolContext,
) => Promise<ToolResult> | ToolResult;

/**
 * MCP SDK compatible tool callback type.
 * This type matches the signature expected by McpServer.tool() for tools with arguments.
 * The extra parameter contains _meta and other request context from the MCP SDK.
 */
export type MCPToolCallback<TArgs = Record<string, unknown>> = (
  args: TArgs,
  extra: unknown,
) => WrappedToolResult | Promise<WrappedToolResult>;

/**
 * Creates a reusable payment wrapper for adding x402 payment to MCP tool handlers.
 *
 * This is the primary API for integrating x402 payments with MCP servers.
 * Use this when you have an existing McpServer and want to add payment to specific tools.
 *
 * @param resourceServer - The x402 resource server for payment verification/settlement
 * @param config - Payment configuration with accepts array
 * @returns A function that wraps tool handlers with payment logic
 *
 * @example
 * ```typescript
 * // Build payment requirements using resource server
 * const accepts = await resourceServer.buildPaymentRequirements({
 *   scheme: "exact",
 *   network: "eip155:84532",
 *   payTo: "0xRecipient",
 *   price: "$0.10",
 * });
 *
 * // Create wrapper with payment requirements
 * const paid = createPaymentWrapper(resourceServer, {
 *   accepts,
 *   hooks: {
 *     onBeforeExecution: async ({ paymentPayload }) => {
 *       if (await isRateLimited(paymentPayload.payer)) return false;
 *     },
 *     onAfterSettlement: async ({ settlement }) => {
 *       await sendReceipt(settlement.transaction);
 *     },
 *   },
 * });
 *
 * // Use with McpServer.tool()
 * mcpServer.tool("search", "Premium search ($0.10)", { query: z.string() },
 *   paid(async (args) => ({
 *     content: [{ type: "text", text: "Search results..." }]
 *   }))
 * );
 * ```
 */
export function createPaymentWrapper(
  resourceServer: x402ResourceServer,
  config: PaymentWrapperConfig,
): <TArgs extends Record<string, unknown>>(
  handler: PaymentWrappedHandler<TArgs>,
) => MCPToolCallback<TArgs> {
  // Validate accepts array
  if (!config.accepts || config.accepts.length === 0) {
    throw new Error("PaymentWrapperConfig.accepts must have at least one payment requirement");
  }

  // Return wrapper function that takes only the handler
  return <TArgs extends Record<string, unknown>>(
    handler: PaymentWrappedHandler<TArgs>,
  ): MCPToolCallback<TArgs> => {
    return async (args: TArgs, extra: unknown): Promise<WrappedToolResult> => {
      // Extract _meta from extra if it's an object
      const _meta = (extra as { _meta?: Record<string, unknown> })?._meta;
      // Derive toolName from resource URL if available, otherwise use placeholder
      const toolName = config.resource?.url?.replace("mcp://tool/", "") || "paid_tool";

      const context: MCPToolContext = {
        toolName,
        arguments: args,
        meta: _meta,
      };

      // Extract payment from _meta if present
      const paymentPayload = extractPaymentFromMeta({
        name: toolName,
        arguments: args,
        _meta,
      });

      // If no payment provided, return 402 error
      if (!paymentPayload) {
        return createPaymentRequiredResult(
          resourceServer,
          toolName,
          config,
          "Payment required to access this tool",
        );
      }

      // Match the client's chosen payment method against config.accepts
      const paymentRequirements = resourceServer.findMatchingRequirements(
        config.accepts,
        paymentPayload,
      );

      if (!paymentRequirements) {
        return createPaymentRequiredResult(
          resourceServer,
          toolName,
          config,
          "No matching payment requirements found",
        );
      }

      // Verify payment
      const verifyResult = await resourceServer.verifyPayment(paymentPayload, paymentRequirements);

      if (!verifyResult.isValid) {
        return createPaymentRequiredResult(
          resourceServer,
          toolName,
          config,
          verifyResult.invalidReason || "Payment verification failed",
        );
      }

      // Build hook context
      const hookContext: ServerHookContext = {
        toolName,
        arguments: args,
        paymentRequirements,
        paymentPayload,
      };

      // Run onBeforeExecution hook if present
      if (config.hooks?.onBeforeExecution) {
        const hookResult = await config.hooks.onBeforeExecution(hookContext);
        if (hookResult === false) {
          return createPaymentRequiredResult(
            resourceServer,
            toolName,
            config,
            "Execution blocked by hook",
          );
        }
      }

      // Execute the tool handler
      const result = await handler(args, context);

      // Build after execution context
      const afterExecContext: AfterExecutionContext = {
        ...hookContext,
        result,
      };

      // Run onAfterExecution hook if present
      if (config.hooks?.onAfterExecution) {
        await config.hooks.onAfterExecution(afterExecContext);
      }

      // If the tool handler returned an error, don't proceed to settlement
      if (result.isError) {
        return result;
      }

      // Settle the payment
      try {
        const settleResult = await resourceServer.settlePayment(
          paymentPayload,
          paymentRequirements,
        );

        // Run onAfterSettlement hook if present
        if (config.hooks?.onAfterSettlement) {
          const settlementContext: SettlementContext = {
            ...hookContext,
            settlement: settleResult,
          };
          await config.hooks.onAfterSettlement(settlementContext);
        }

        // Return full result (preserving structuredContent, etc.) with payment response in _meta
        return {
          ...result,
          _meta: { [MCP_PAYMENT_RESPONSE_META_KEY]: settleResult },
        };
      } catch (settleError) {
        // Settlement failed after execution - return 402 error
        return createSettlementFailedResult(
          resourceServer,
          toolName,
          config,
          settleError instanceof Error ? settleError.message : "Settlement failed",
        );
      }
    };
  };
}

/**
 * Helper to create 402 payment required result from wrapper config.
 *
 * @param resourceServer - The x402 resource server for creating payment required response
 * @param toolName - Name of the tool for resource URL
 * @param config - Payment wrapper configuration
 * @param errorMessage - Error message describing why payment is required
 * @returns Promise resolving to structured 402 error result with payment requirements
 */
async function createPaymentRequiredResult(
  resourceServer: x402ResourceServer,
  toolName: string,
  config: PaymentWrapperConfig,
  errorMessage: string,
): Promise<WrappedToolResult> {
  const resourceInfo = {
    url: createToolResourceUrl(toolName, config.resource?.url),
    description: config.resource?.description || `Tool: ${toolName}`,
    mimeType: config.resource?.mimeType || "application/json",
  };

  const paymentRequired = await resourceServer.createPaymentRequiredResponse(
    config.accepts,
    resourceInfo,
    errorMessage,
  );

  return {
    structuredContent: paymentRequired as unknown as Record<string, unknown>,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(paymentRequired),
      },
    ],
    isError: true,
  };
}

/**
 * Helper to create 402 settlement failed result from wrapper config.
 *
 * @param resourceServer - The x402 resource server for creating error response
 * @param toolName - Name of the tool for resource URL
 * @param config - Payment wrapper configuration
 * @param errorMessage - Error message describing the settlement failure
 * @returns Promise resolving to structured 402 error result with settlement failure info
 */
async function createSettlementFailedResult(
  resourceServer: x402ResourceServer,
  toolName: string,
  config: PaymentWrapperConfig,
  errorMessage: string,
): Promise<WrappedToolResult> {
  // Per spec R5, settlement failure follows the same format as payment required
  // (structuredContent + content[0].text + isError: true) with the error message
  // describing the settlement failure. We intentionally do NOT embed the
  // x402/payment-response in the PaymentRequired object to avoid clients
  // misinterpreting it as a new 402 and attempting to pay again.
  return createPaymentRequiredResult(
    resourceServer,
    toolName,
    config,
    `Payment settlement failed: ${errorMessage}`,
  );
}
