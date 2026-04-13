/**
 * Internal helpers for the discovery() builder.
 */

import type { RouteConfig, RoutesConfig, PaymentOption, DynamicPrice } from "@x402/core/http";
import type { Price } from "@x402/core/types";
import type { DiscoveryExtension, BodyDiscoveryExtension } from "../bazaar";
import { SIGN_IN_WITH_X } from "../sign-in-with-x/types";
import type { BuildOperationArgs, HttpBazaarExtension, NormalizedRoute } from "./types";

// ============================================================================
// Document assembly
// ============================================================================

/**
 * Flatten a RoutesConfig into ordered `[routeKey, RouteConfig]` tuples.
 *
 * @param routes - The routes map passed to `paymentMiddleware`.
 * @returns Ordered route entries ready for iteration.
 */
export function normalizeRoutes(routes: RoutesConfig): NormalizedRoute[] {
  return Object.entries(routes as Record<string, RouteConfig>);
}

/**
 * Build the OpenAPI `paths` object from normalized route entries.
 *
 * @param entries - Normalized `[routeKey, RouteConfig]` tuples.
 * @param protocols - Default protocols to emit on each paid operation's `x-payment-info.protocols`.
 * @returns An OpenAPI `paths` object keyed by URL template.
 */
export function buildPaths(
  entries: NormalizedRoute[],
  protocols: Array<Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [routeKey, config] of entries) {
    const { verb, rawPath } = parseRouteKey(routeKey);
    const openApiPath = toOpenApiPath(rawPath);
    if (!paths[openApiPath]) paths[openApiPath] = {};
    paths[openApiPath][verb.toLowerCase()] = buildOperation({
      verb,
      openApiPath,
      config,
      protocols,
    });
  }
  return paths;
}

/**
 * Build the shared `components.securitySchemes` block for SIWX-gated routes.
 *
 * @returns A `components` fragment containing the `siwx` bearer security scheme.
 */
export function buildSiwxComponents(): { securitySchemes: Record<string, unknown> } {
  return {
    securitySchemes: {
      siwx: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "SIWX",
        description:
          "Sign-In With X (SIWX) identity proof — bearer token carrying a signed challenge.",
      },
    },
  };
}

/**
 * Split an x402 route key (e.g. `"POST /analyze"`) into its verb and raw path.
 *
 * @param key - A route key of the form `"VERB /path"`.
 * @returns The HTTP verb and the raw (pre-OpenAPI) path.
 */
function parseRouteKey(key: string): { verb: string; rawPath: string } {
  const spaceIdx = key.indexOf(" ");
  return { verb: key.slice(0, spaceIdx), rawPath: key.slice(spaceIdx + 1) };
}

/**
 * Convert Express-style `:param` placeholders to OpenAPI `{param}` syntax.
 *
 * @param rawPath - A path using Express-style parameters.
 * @returns The same path with OpenAPI-style parameter placeholders.
 */
function toOpenApiPath(rawPath: string): string {
  return rawPath.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "{$1}");
}

// ============================================================================
// Per-route operation builder
// ============================================================================

/**
 * Build a single OpenAPI operation object from a route's config and bazaar declaration.
 *
 * @param args - Verb, OpenAPI path, route config, and default protocols.
 * @returns The OpenAPI operation object for `paths[path][verb]`.
 */
export function buildOperation(args: BuildOperationArgs): Record<string, unknown> {
  const { verb, openApiPath, config, protocols } = args;
  const bazaar = getHttpBazaar(config);
  const pathParams = buildPathOperation(openApiPath, bazaar);

  const op: Record<string, unknown> = {};
  if (config.description) {
    op.summary = config.description;
    op.description = config.description;
  }

  switch (verbKind(verb)) {
    case "body": {
      if (pathParams.length) op.parameters = pathParams;
      const body = buildBodyOperation(bazaar);
      if (body) op.requestBody = body;
      break;
    }
    case "query": {
      const parameters = [...pathParams, ...buildQueryOperation(bazaar)];
      if (parameters.length) op.parameters = parameters;
      break;
    }
  }

  const responses: Record<string, unknown> = {
    "200": buildSuccessResponse(bazaar),
  };

  // Identity vs payment — mutually exclusive.
  if (isSiwxRoute(config)) {
    op.security = [{ siwx: [] }];
    responses["401"] = { description: "Authentication required" };
  } else {
    op["x-payment-info"] = buildPaymentInfo(config, protocols);
    responses["402"] = { description: "Payment Required" };
  }

  op.responses = responses;
  return op;
}

/**
 * Classify an HTTP verb as one that carries a request body or one that uses query/path parameters.
 *
 * @param verb - The uppercase HTTP verb.
 * @returns `"body"` for POST/PUT/PATCH, `"query"` for everything else.
 */
function verbKind(verb: string): "body" | "query" {
  return verb === "POST" || verb === "PUT" || verb === "PATCH" ? "body" : "query";
}

/**
 * Build OpenAPI `parameters[]` entries for each `{param}` segment in the path.
 *
 * @param openApiPath - OpenAPI-style path containing `{param}` placeholders.
 * @param bazaar - Optional bazaar declaration whose `pathParams` schema supplies per-param types.
 * @returns Zero or more path-parameter objects.
 */
function buildPathOperation(
  openApiPath: string,
  bazaar: HttpBazaarExtension | undefined,
): Array<Record<string, unknown>> {
  const names = [...openApiPath.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
  if (!names.length) return [];
  const pathProps = bazaar?.schema.properties.input.properties.pathParams?.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  return names.map(name => ({
    name,
    in: "path",
    required: true,
    schema: pathProps?.[name] ?? { type: "string" },
  }));
}

/**
 * Build OpenAPI `parameters[]` entries for query-string inputs declared in bazaar.
 *
 * @param bazaar - Bazaar declaration for a query-style operation (GET/HEAD/DELETE).
 * @returns Zero or more query-parameter objects.
 */
function buildQueryOperation(
  bazaar: HttpBazaarExtension | undefined,
): Array<Record<string, unknown>> {
  const queryParams = bazaar?.schema.properties.input.properties.queryParams;
  if (!queryParams?.properties) return [];
  const required = new Set(queryParams.required ?? []);
  return Object.entries(queryParams.properties).map(([name, schema]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema: schema as Record<string, unknown>,
  }));
}

/**
 * Build the OpenAPI `requestBody` object from a bazaar body declaration.
 *
 * @param bazaar - Bazaar declaration for a body-style operation (POST/PUT/PATCH).
 * @returns A `requestBody` object, or `undefined` when the declaration has no body schema.
 */
function buildBodyOperation(
  bazaar: HttpBazaarExtension | undefined,
): Record<string, unknown> | undefined {
  if (!bazaar || !("bodyType" in bazaar.info.input)) return undefined;
  return {
    required: true,
    content: {
      "application/json": {
        schema: (bazaar as BodyDiscoveryExtension).schema.properties.input.properties.body,
      },
    },
  };
}

// ============================================================================
// Route inspection
// ============================================================================

/**
 * Extract the HTTP-flavored bazaar declaration from a route config, if present.
 *
 * @param config - The route's configuration.
 * @returns The HTTP bazaar extension, or `undefined` for routes without one (including MCP).
 */
function getHttpBazaar(config: RouteConfig): HttpBazaarExtension | undefined {
  const raw = config.extensions?.bazaar as DiscoveryExtension | undefined;
  if (!raw || typeof raw !== "object" || raw.info?.input?.type !== "http") return undefined;
  return raw as HttpBazaarExtension;
}

/**
 * Detect whether a route is gated by the Sign-In-With-X identity extension.
 *
 * @param config - The route's configuration.
 * @returns `true` when the route declares the SIWX extension.
 */
export function isSiwxRoute(config: RouteConfig): boolean {
  return !!config.extensions && SIGN_IN_WITH_X in config.extensions;
}

// ============================================================================
// Success response
// ============================================================================

/**
 * Build the OpenAPI `responses["200"]` entry from a bazaar output example.
 *
 * @param bazaar - Bazaar declaration that may contain an `info.output.example`.
 * @returns A minimal 200 response, optionally with an embedded example.
 */
function buildSuccessResponse(bazaar: HttpBazaarExtension | undefined): Record<string, unknown> {
  const example = bazaar?.info.output?.example;
  if (example === undefined) return { description: "Successful response" };
  return {
    description: "Successful response",
    content: { "application/json": { example } },
  };
}

// ============================================================================
// x-payment-info assembly
// ============================================================================

/**
 * Build the `x-payment-info` object for a paid operation.
 *
 * @param config - The route's configuration, whose first `accepts` entry supplies the price.
 * @param protocols - Default protocols to emit on every paid operation.
 * @returns The `x-payment-info` object containing the normalized price and protocols.
 */
function buildPaymentInfo(
  config: RouteConfig,
  protocols: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const first: PaymentOption = Array.isArray(config.accepts) ? config.accepts[0] : config.accepts;
  return { price: normalizePrice(first.price), protocols };
}

/**
 * Normalize an x402 `Price` into the AgentCash `x-payment-info.price` shape.
 *
 * Dynamic prices can't be resolved statically — they are emitted as
 * `mode:"dynamic"` with placeholder bounds.
 *
 * @param price - A static price, asset amount, or dynamic price function.
 * @returns A fixed- or dynamic-mode price object suitable for `x-payment-info.price`.
 */
function normalizePrice(price: Price | DynamicPrice): Record<string, unknown> {
  if (typeof price === "function") {
    return { mode: "dynamic", currency: "USD", min: "0", max: "0" };
  }
  if (typeof price === "object") {
    return { mode: "fixed", currency: "USD", amount: price.amount };
  }
  return { mode: "fixed", currency: "USD", amount: String(price).replace(/^\$/, "") };
}
