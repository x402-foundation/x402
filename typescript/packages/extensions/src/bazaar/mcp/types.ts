/**
 * MCP-specific type definitions for the Bazaar Discovery Extension
 */

import type { DiscoveryInfo } from "../types";

/**
 * Discovery info for MCP tools
 */
export interface McpDiscoveryInfo {
  input: {
    type: "mcp";
    toolName: string;
    description?: string;
    transport?: string;
    inputSchema: Record<string, unknown>;
    example?: Record<string, unknown>;
  };
  output?: {
    type?: string;
    format?: string;
    example?: unknown;
  };
}

/**
 * Discovery extension for MCP tools
 */
export interface McpDiscoveryExtension {
  info: McpDiscoveryInfo;

  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema";
    type: "object";
    properties: {
      input: {
        type: "object";
        properties: {
          type: {
            type: "string";
            const: "mcp";
          };
          toolName: {
            type: "string";
          };
          description?: {
            type: "string";
          };
          transport?: {
            type: "string";
            enum?: string[];
          };
          inputSchema: Record<string, unknown>;
          example?: Record<string, unknown>;
        };
        required: ("type" | "toolName" | "inputSchema")[];
        additionalProperties?: boolean;
      };
      output?: {
        type: "object";
        properties?: Record<string, unknown>;
        required?: readonly string[];
        additionalProperties?: boolean;
      };
    };
    required: ["input"];
  };
}

export interface DeclareMcpDiscoveryExtensionConfig {
  toolName: string;
  description?: string;
  transport?: string;
  inputSchema: Record<string, unknown>;
  example?: Record<string, unknown>;
  output?: {
    example?: unknown;
    schema?: Record<string, unknown>;
  };
}

export interface DiscoveredMCPResource {
  resourceUrl: string;
  description?: string;
  mimeType?: string;
  toolName: string;
  x402Version: number;
  discoveryInfo: DiscoveryInfo;
}

export const isMcpExtensionConfig = (
  config: DeclareMcpDiscoveryExtensionConfig | Record<string, unknown>,
): config is DeclareMcpDiscoveryExtensionConfig => {
  return "toolName" in config;
};
