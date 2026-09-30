/**
 * Shared type definitions for the Bazaar Discovery Extension
 *
 * Protocol-specific types live in their own directories (http/, mcp/).
 * This file defines the shared unions, constants, and utility types,
 * and re-exports all protocol-specific types for backwards compatibility.
 */

import type { FacilitatorExtension } from "@x402/core/types";

// --- Shared union types ---

import type { QueryDiscoveryInfo, BodyDiscoveryInfo } from "./http/types";
import type { McpDiscoveryInfo } from "./mcp/types";
import type { QueryDiscoveryExtension, BodyDiscoveryExtension } from "./http/types";
import type { McpDiscoveryExtension } from "./mcp/types";
import type {
  DeclareQueryDiscoveryExtensionConfig,
  DeclareBodyDiscoveryExtensionConfig,
} from "./http/types";
import type { DeclareMcpDiscoveryExtensionConfig } from "./mcp/types";

// Re-export protocol-specific types
export type {
  QueryDiscoveryInfo,
  BodyDiscoveryInfo,
  QueryDiscoveryExtension,
  BodyDiscoveryExtension,
  DeclareQueryDiscoveryExtensionConfig,
  DeclareBodyDiscoveryExtensionConfig,
  DiscoveredHTTPResource,
} from "./http/types";

export { isQueryExtensionConfig, isBodyExtensionConfig } from "./http/types";

export type {
  McpDiscoveryInfo,
  McpDiscoveryExtension,
  DeclareMcpDiscoveryExtensionConfig,
  DiscoveredMCPResource,
} from "./mcp/types";

export { isMcpExtensionConfig } from "./mcp/types";

// --- Shared constants ---

/**
 * Extension identifier for the Bazaar discovery extension.
 */
export const BAZAAR: FacilitatorExtension = { key: "bazaar" };

/**
 * Combined discovery info type
 */
export type DiscoveryInfo = QueryDiscoveryInfo | BodyDiscoveryInfo | McpDiscoveryInfo;

/**
 * Combined discovery extension type
 */
export type DiscoveryExtension =
  | QueryDiscoveryExtension
  | BodyDiscoveryExtension
  | McpDiscoveryExtension;

export type DeclareDiscoveryExtensionConfig =
  | DeclareQueryDiscoveryExtensionConfig
  | DeclareBodyDiscoveryExtensionConfig
  | DeclareMcpDiscoveryExtensionConfig;

/**
 * Distributive Omit - properly distributes Omit over union types.
 *
 * Standard `Omit<A | B, K>` collapses to common properties only,
 * losing discriminant properties like `bodyType`.
 *
 * This type uses conditional type distribution to preserve the union:
 * `DistributiveOmit<A | B, K>` = `Omit<A, K> | Omit<B, K>`
 */
export type DistributiveOmit<T, K extends keyof T> = T extends T ? Omit<T, K> : never;

/**
 * Config type for declareDiscoveryExtension function.
 * Uses DistributiveOmit to preserve bodyType discriminant in the union for HTTP configs.
 * MCP config has no `method` field so it's included directly.
 */
export type DeclareDiscoveryExtensionInput =
  | DistributiveOmit<DeclareQueryDiscoveryExtensionConfig, "method">
  | DistributiveOmit<DeclareBodyDiscoveryExtensionConfig, "method">
  | DeclareMcpDiscoveryExtensionConfig;
