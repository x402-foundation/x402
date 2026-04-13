/**
 * Internal helpers for the discovery() builder.
 */

import type {
  RouteConfig,
  RoutesConfig,
  PaymentOption,
  DynamicPrice,
} from "@x402/core/http";
import type { Price } from "@x402/core/types";
import type { DiscoveryExtension, BodyDiscoveryExtension } from "../bazaar";
import { SIGN_IN_WITH_X } from "../sign-in-with-x/types";
import type {
  BuildOperationArgs,
  HttpBazaarExtension,
  NormalizedRoute,
} from "./types";

// ============================================================================
// Document assembly
// ============================================================================

export function normalizeRoutes(routes: RoutesConfig): NormalizedRoute[] {
  return Object.entries(routes as Record<string, RouteConfig>);
}

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

function parseRouteKey(key: string): { verb: string; rawPath: string } {
  const spaceIdx = key.indexOf(" ");
  return { verb: key.slice(0, spaceIdx), rawPath: key.slice(spaceIdx + 1) };
}

// Convert Express-style :param to OpenAPI {param}.
function toOpenApiPath(rawPath: string): string {
  return rawPath.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "{$1}");
}

// ============================================================================
// Per-route operation builder
// ============================================================================

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

function verbKind(verb: string): "body" | "query" {
  return verb === "POST" || verb === "PUT" || verb === "PATCH" ? "body" : "query";
}

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

function getHttpBazaar(config: RouteConfig): HttpBazaarExtension | undefined {
  const raw = config.extensions?.bazaar as DiscoveryExtension | undefined;
  if (!raw || typeof raw !== "object" || raw.info?.input?.type !== "http") return undefined;
  return raw as HttpBazaarExtension;
}

export function isSiwxRoute(config: RouteConfig): boolean {
  return !!config.extensions && SIGN_IN_WITH_X in config.extensions;
}

// ============================================================================
// Success response
// ============================================================================

function buildSuccessResponse(
  bazaar: HttpBazaarExtension | undefined,
): Record<string, unknown> {
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

function buildPaymentInfo(
  config: RouteConfig,
  protocols: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const first: PaymentOption = Array.isArray(config.accepts)
    ? config.accepts[0]
    : config.accepts;
  return { price: normalizePrice(first.price), protocols };
}

// Dynamic prices can't be resolved statically — emit mode:"dynamic" with placeholder bounds.
function normalizePrice(price: Price | DynamicPrice): Record<string, unknown> {
  if (typeof price === "function") {
    return { mode: "dynamic", currency: "USD", min: "0", max: "0" };
  }
  if (typeof price === "object") {
    return { mode: "fixed", currency: "USD", amount: price.amount };
  }
  return { mode: "fixed", currency: "USD", amount: String(price).replace(/^\$/, "") };
}
