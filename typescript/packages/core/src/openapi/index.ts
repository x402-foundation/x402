/**
 * OpenAPI spec generation for x402 resource servers.
 *
 * Converts x402 RoutesConfig into an OpenAPI 3.1.0 document compatible
 * with agentcash-discovery's parser (x-payment-info, parameters, schemas).
 */
import {
  type RoutesConfig,
  type RouteConfig,
  isSingleRouteConfig,
} from "../http/x402HTTPResourceServer";
import type { OpenAPIDoc, PathItem } from "./schemas";
import { parseRoutePattern, DEFAULT_ROUTE, type ParsedRoute } from "./route";
import { extractBazaarSchemas } from "./bazaar";
import { buildOperation } from "./operation";

export interface OpenAPIOptions {
  /** Title for the API (used in info.title) */
  title?: string;
  /** Version string (used in info.version) */
  version?: string;
  /** Description of the API */
  description?: string;
  /** Server URL (e.g., "https://api.example.com") */
  serverUrl?: string;
  /** Guidance for the API */
  guidance?: string;
}

/**
 * Adds an operation to the paths map at the given route.
 */
function addRoute(
  paths: Record<string, PathItem>,
  route: ParsedRoute,
  routeConfig: RouteConfig,
): void {
  const bazaar = extractBazaarSchemas(routeConfig.extensions);
  const operation = buildOperation(routeConfig, route.pathParams, bazaar);

  if (!paths[route.path]) {
    paths[route.path] = {};
  }
  paths[route.path][route.method] = operation;
}

/**
 * Generate an OpenAPI 3.1.0 specification from x402 RoutesConfig.
 *
 * The generated spec is compatible with agentcash-discovery's OpenAPI parser,
 * including x-payment-info on each operation for price and protocol metadata.
 *
 * @param routes - The x402 route configuration
 * @param options - Optional metadata for the spec
 * @returns A typed OpenAPI 3.1.0 document
 */
export function generateOpenAPISpec(
  routes: RoutesConfig,
  options: OpenAPIOptions = {},
): OpenAPIDoc {
  const { title = "x402 API", version = "1.0.0", description, serverUrl, guidance } = options;

  const paths: Record<string, PathItem> = {};

  if (isSingleRouteConfig(routes)) {
    // Single RouteConfig applies to all routes — map it to GET /
    addRoute(paths, DEFAULT_ROUTE, routes);
  } else {
    for (const [pattern, routeConfig] of Object.entries(routes)) {
      addRoute(paths, parseRoutePattern(pattern), routeConfig);
    }
  }

  const spec: OpenAPIDoc = {
    openapi: "3.1.0",
    info: {
      title,
      version,
      ...(description ? { description } : {}),
      ...(guidance ? { "x-guidance": guidance } : {}),
    },
    ...(serverUrl ? { servers: [{ url: serverUrl }] } : {}),
    paths,
  };

  return spec;
}

// Re-export types for consumers
export type { OpenAPIDoc } from "./schemas";
