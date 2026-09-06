/**
 * Resource Service entry point for creating Bazaar discovery extensions
 *
 * This module provides the unified `declareDiscoveryExtension` function that
 * routes to protocol-specific builders in http/ and mcp/.
 */

import type { DiscoveryExtension, DeclareDiscoveryExtensionInput } from "./types";
import type {
  DeclareQueryDiscoveryExtensionConfig,
  DeclareBodyDiscoveryExtensionConfig,
} from "./http/types";
import type { DeclareMcpDiscoveryExtensionConfig } from "./mcp/types";
import {
  createQueryDiscoveryExtension,
  createBodyDiscoveryExtension,
} from "./http/resourceService";
import { createMcpDiscoveryExtension } from "./mcp/resourceService";

/**
 * Create a discovery extension for any HTTP method or MCP tool
 *
 * This function helps servers declare how their endpoint should be called,
 * including the expected input parameters/body and output format.
 *
 * @param config - Configuration object for the discovery extension
 * @returns A discovery extension object with both info and schema
 *
 * @example
 * ```typescript
 * // For a GET endpoint with no input
 * const getExtension = declareDiscoveryExtension({
 *   method: "GET",
 *   output: {
 *     example: { message: "Success", timestamp: "2024-01-01T00:00:00Z" }
 *   }
 * });
 *
 * // For a GET endpoint with query params
 * const getWithParams = declareDiscoveryExtension({
 *   method: "GET",
 *   input: { query: "example" },
 *   inputSchema: {
 *     properties: {
 *       query: { type: "string" }
 *     },
 *     required: ["query"]
 *   }
 * });
 *
 * // For a POST endpoint with JSON body
 * const postExtension = declareDiscoveryExtension({
 *   method: "POST",
 *   input: { name: "John", age: 30 },
 *   inputSchema: {
 *     properties: {
 *       name: { type: "string" },
 *       age: { type: "number" }
 *     },
 *     required: ["name"]
 *   },
 *   bodyType: "json",
 *   output: {
 *     example: { success: true, id: "123" }
 *   }
 * });
 *
 * // For an MCP tool
 * const mcpExtension = declareDiscoveryExtension({
 *   toolName: "financial_analysis",
 *   description: "Analyze financial data for a given ticker",
 *   inputSchema: {
 *     type: "object",
 *     properties: {
 *       ticker: { type: "string" },
 *     },
 *     required: ["ticker"],
 *   },
 *   output: {
 *     example: { pe_ratio: 28.5, recommendation: "hold" }
 *   }
 * });
 * ```
 */
export function declareDiscoveryExtension(
  config: DeclareDiscoveryExtensionInput,
): Record<string, DiscoveryExtension> {
  if ("toolName" in config) {
    const extension = createMcpDiscoveryExtension(config as DeclareMcpDiscoveryExtensionConfig);
    return { bazaar: extension as DiscoveryExtension };
  }

  const bodyType = (config as DeclareBodyDiscoveryExtensionConfig).bodyType;
  const isBodyMethod = bodyType !== undefined;

  const extension = isBodyMethod
    ? createBodyDiscoveryExtension(config as DeclareBodyDiscoveryExtensionConfig)
    : createQueryDiscoveryExtension(config as DeclareQueryDiscoveryExtensionConfig);

  return { bazaar: extension as DiscoveryExtension };
}
