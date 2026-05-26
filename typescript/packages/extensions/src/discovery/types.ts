/**
 * Zod schemas and inferred types for the OpenAPI
 * discovery document builder. Public input (`DiscoveryOptions`) and output
 * (`OpenAPIDocument`) shapes are defined here; the builder lives in
 * `./index.ts`.
 */

import { z } from "zod";
import type { RouteConfig } from "@x402/core/http";
import type { QueryDiscoveryExtension, BodyDiscoveryExtension } from "../bazaar";

const ServerSchema = z.object({
  url: z.string(),
  description: z.string().optional(),
});

// ============================================================================
// discovery() input
// ============================================================================

export const DiscoveryOptionsSchema = z.object({
  info: z.object({
    title: z.string(),
    version: z.string(),
    description: z.string().optional(),
    /** High-level agent-facing guidance. Emitted as info["x-guidance"]. */
    xGuidance: z.string(),
  }),
  servers: z.array(ServerSchema).optional(),
  /** Proofs for the top-level x-discovery.ownershipProofs field. */
  ownershipProofs: z.array(z.string()).optional(),
  /**
   * Default protocols emitted in each paid operation's x-payment-info.protocols.
   * Defaults to [{ x402: {} }]. Pass [{ x402: {} }, { mpp: { ... } }] to advertise MPP too.
   */
  protocols: z.array(z.record(z.unknown())).optional(),
});

export type DiscoveryOptions = z.infer<typeof DiscoveryOptionsSchema>;

// ============================================================================
// discovery() output
// ============================================================================

export const OpenAPIDocumentSchema = z.object({
  openapi: z.literal("3.1.0"),
  info: z.object({
    title: z.string(),
    version: z.string(),
    description: z.string().optional(),
    "x-guidance": z.string(),
  }),
  "x-discovery": z.object({ ownershipProofs: z.array(z.string()) }).optional(),
  servers: z.array(ServerSchema).optional(),
  components: z.object({ securitySchemes: z.record(z.unknown()).optional() }).optional(),
  paths: z.record(z.record(z.unknown())),
});

export type OpenAPIDocument = z.infer<typeof OpenAPIDocumentSchema>;

// ============================================================================
// Internal helper types
// ============================================================================

/** HTTP subset of the bazaar DiscoveryExtension union. */
export type HttpBazaarExtension = QueryDiscoveryExtension | BodyDiscoveryExtension;

/** A single `[routeKey, RouteConfig]` entry after normalizing the routes map. */
export type NormalizedRoute = [string, RouteConfig];

export interface BuildOperationArgs {
  verb: string;
  openApiPath: string;
  config: RouteConfig;
  protocols: Array<Record<string, unknown>>;
}
