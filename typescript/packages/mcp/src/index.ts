// @x402/mcp - MCP (Model Context Protocol) integration for x402 payment protocol
//
// This package provides MCP-native payment handling for AI agents and MCP servers.
// It enables paid tool calls following the x402 protocol over MCP transport.

// Client exports
export {
  x402MCPClient,
  createx402MCPClient,
  wrapMCPClientWithPayment,
  wrapMCPClientWithPaymentFromConfig,
} from "./client";
export type {
  BeforePaymentHook,
  AfterPaymentHook,
  x402MCPToolCallResult,
  x402MCPClientConfig,
  MCPContentItem,
} from "./client";

// Server exports
export { createPaymentWrapper } from "./server";
export type {
  PaymentWrapperConfig,
  PaymentWrappedHandler,
  WrappedToolResult,
  ToolResult,
  MCPToolCallback,
} from "./server";

// Type exports
export {
  MCP_PAYMENT_REQUIRED_CODE,
  MCP_PAYMENT_META_KEY,
  MCP_PAYMENT_RESPONSE_META_KEY,
  isPaymentRequiredError,
} from "./types";
export type {
  // Core MCP types
  MCPToolContext,
  MCPToolPaymentConfig,
  MCPPaymentProcessResult,
  MCPPaymentError,
  x402MCPClientOptions,
  PaymentRequestedContext,
  MCPToolResultWithPayment,
  MCPRequestParamsWithMeta,
  MCPResultWithMeta,
  MCPPaymentRequiredError,
  DynamicPayTo,
  DynamicPrice,
  ToolContentItem,
  // Server hook types
  ServerHookContext,
  BeforeExecutionHook,
  AfterExecutionContext,
  AfterExecutionHook,
  SettlementContext,
  AfterSettlementHook,
  // Client hook types
  PaymentRequiredContext,
  PaymentRequiredHookResult,
  PaymentRequiredHook,
} from "./types";

// Utility exports
export {
  extractPaymentFromMeta,
  attachPaymentToMeta,
  extractPaymentResponseFromMeta,
  attachPaymentResponseToMeta,
  createPaymentRequiredError,
  extractPaymentRequiredFromError,
  createToolResourceUrl,
} from "./utils";

// ============================================================================
// Convenience Re-exports from @x402/core
// ============================================================================
// These re-exports provide common types and classes that MCP users frequently need,
// reducing the number of separate package imports required.

export { x402Client } from "@x402/core/client";
export type { x402ClientConfig, SelectPaymentRequirements, PaymentPolicy } from "@x402/core/client";

export { x402ResourceServer } from "@x402/core/server";

export type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  Network,
  SchemeNetworkClient,
  SchemeNetworkServer,
} from "@x402/core/types";
