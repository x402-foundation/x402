/**
 * OpenAPI discovery document builder for x402 servers.
 *
 * @example
 * ```ts
 * // Express — one line after paymentMiddleware is already registered
 * import { discovery } from "@x402/extensions";
 *
 * app.get("/openapi.json", (_req, res) =>
 *   res.json(discovery(routes, {
 *     info: {
 *       title: "My API",
 *       version: "1.0.0",
 *       xGuidance: "Use POST /analyze to score a document. $0.01 per call.",
 *     },
 *     ownershipProofs: ["did:web:example.com"],
 *   })),
 * );
 * ```
 *
 * @example
 * ```ts
 * // Next.js App Router — app/openapi.json/route.ts
 * import { NextResponse } from "next/server";
 * import { discovery } from "@x402/extensions";
 * import { routes, discoveryOptions } from "@/lib/x402";
 *
 * export const GET = () => NextResponse.json(discovery(routes, discoveryOptions));
 * ```
 */

import type { RoutesConfig } from "@x402/core/http";
import type { DiscoveryOptions, OpenAPIDocument } from "./types";
import { buildPaths, buildSiwxComponents, isSiwxRoute, normalizeRoutes } from "./utils";

export * from "./types";

/**
 * Build an OpenAPI 3.1 document from an x402 RoutesConfig.
 *
 * @param routes - Same routes map passed to `paymentMiddleware`.
 * @param options - Document-level metadata and defaults.
 * @returns An OpenAPI 3.1 document ready to serve as /openapi.json.
 */
export function discovery(routes: RoutesConfig, options: DiscoveryOptions): OpenAPIDocument {
  const entries = normalizeRoutes(routes);
  const protocols = options.protocols ?? [{ x402: {} }];
  const hasSiwx = entries.some(([, config]) => isSiwxRoute(config));

  return {
    openapi: "3.1.0",
    info: {
      title: options.info.title,
      version: options.info.version,
      ...(options.info.description ? { description: options.info.description } : {}),
      "x-guidance": options.info.xGuidance,
    },
    ...(options.servers?.length ? { servers: options.servers } : {}),
    ...(options.ownershipProofs?.length
      ? { "x-discovery": { ownershipProofs: options.ownershipProofs } }
      : {}),
    ...(hasSiwx ? { components: buildSiwxComponents() } : {}),
    paths: buildPaths(entries, protocols),
  };
}
