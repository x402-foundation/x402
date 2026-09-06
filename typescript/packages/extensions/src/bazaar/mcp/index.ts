/**
 * MCP-specific Bazaar Discovery Extension types and builders
 */

export type {
  McpDiscoveryInfo,
  McpDiscoveryExtension,
  DeclareMcpDiscoveryExtensionConfig,
  DiscoveredMCPResource,
} from "./types";

export { isMcpExtensionConfig } from "./types";

export { createMcpDiscoveryExtension } from "./resourceService";
