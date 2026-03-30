import type { ResourceServerExtension } from "@x402/core/types";
import type { HTTPRequestContext } from "@x402/core/http";
import { BAZAAR } from "./types";

// Non-global: safe for test/split (no stateful lastIndex side-effects).
const BRACKET_PARAM_REGEX = /\[([^\]]+)\]/;
// Global variant required for String.replace to substitute ALL occurrences.
// JS String.replace with a non-global regex replaces only the first match.
// (String.replaceAll with a non-global regex would work in ES2021+, but the
// target lib is ES2020 — keep this separate constant to avoid that constraint.)
const BRACKET_PARAM_REGEX_ALL = /\[([^\]]+)\]/g;

const COLON_PARAM_REGEX = /:([a-zA-Z_][a-zA-Z0-9_]*)/;

/**
 * Type guard to check if context is an HTTP request context.
 *
 * @param ctx - The context to check
 * @returns True if context is an HTTPRequestContext
 */
function isHTTPRequestContext(ctx: unknown): ctx is HTTPRequestContext {
  return ctx !== null && typeof ctx === "object" && "method" in ctx && "adapter" in ctx;
}

/**
 * Converts wildcard segments in a route pattern to named :varN parameters
 * so they can be treated as dynamic routes for discovery catalog normalization.
 *
 * @param pattern - Route pattern that may contain wildcard segments
 * @returns The pattern with wildcard segments replaced by :var1, :var2, etc.
 */
function normalizeWildcardPattern(pattern: string): string {
  if (!pattern.includes("*")) {
    return pattern;
  }
  let counter = 0;
  return pattern
    .split("/")
    .map(seg => {
      if (seg === "*") {
        counter++;
        return `:var${counter}`;
      }
      return seg;
    })
    .join("/");
}

/**
 * Converts a parameterized route pattern into a :param template and extracts concrete
 * param values from the URL path in a single call.
 *
 * Supports both [param] (Next.js) and :param (Express) syntax. The output routeTemplate
 * always uses :param syntax regardless of input format.
 *
 * @param routePattern - Route pattern (e.g. "/users/[userId]" or "/users/:userId")
 * @param urlPath - Concrete URL path (e.g. "/users/123")
 * @returns Object with routeTemplate and pathParams, or null if no params detected
 */
function extractDynamicRouteInfo(
  routePattern: string,
  urlPath: string,
): { routeTemplate: string; pathParams: Record<string, string> } | null {
  const hasBracket = BRACKET_PARAM_REGEX.test(routePattern);
  const hasColon = COLON_PARAM_REGEX.test(routePattern);
  if (!hasBracket && !hasColon) {
    return null;
  }
  // When both [param] and :param are present, normalize brackets to colons first
  // so all params are extracted uniformly.
  const normalizedPattern = hasBracket
    ? routePattern.replace(BRACKET_PARAM_REGEX_ALL, ":$1")
    : routePattern;
  const pathParams = extractPathParams(normalizedPattern, urlPath, false);
  return { routeTemplate: normalizedPattern, pathParams };
}

/**
 * Extracts concrete path parameter values by matching a URL path against a route pattern.
 *
 * @param routePattern - Route pattern with [paramName] or :paramName segments
 * @param urlPath - Concrete URL path (e.g. "/users/123")
 * @param isBracket - True if pattern uses [param] syntax, false for :param
 * @returns Record mapping param names to their values
 */
function extractPathParams(
  routePattern: string,
  urlPath: string,
  isBracket: boolean,
): Record<string, string> {
  const paramNames: string[] = [];
  const splitRegex = isBracket ? BRACKET_PARAM_REGEX : COLON_PARAM_REGEX;
  // Split on param markers so literal segments can be regex-escaped independently.
  // Without escaping, a route like /api/v1.0/[id] would produce a regex where '.' matches
  // any character (e.g. /api/v1X0/123 would incorrectly match).
  const parts = routePattern.split(splitRegex);
  const regexParts: string[] = [];
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      // Literal segment – escape all regex metacharacters
      regexParts.push(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    } else {
      // Param name
      paramNames.push(part);
      regexParts.push("([^/]+)");
    }
  });

  const regex = new RegExp(`^${regexParts.join("")}$`);
  const match = urlPath.match(regex);

  if (!match) return {};

  const result: Record<string, string> = {};
  paramNames.forEach((name, idx) => {
    result[name] = match[idx + 1];
  });
  return result;
}

interface ExtensionDeclaration {
  [key: string]: unknown;
  info?: {
    [key: string]: unknown;
    input?: Record<string, unknown>;
  };
  schema?: {
    [key: string]: unknown;
    properties?: {
      [key: string]: unknown;
      input?: {
        [key: string]: unknown;
        properties?: {
          [key: string]: unknown;
          method?: Record<string, unknown>;
        };
        required?: string[];
      };
    };
  };
}

export const bazaarResourceServerExtension: ResourceServerExtension = {
  key: BAZAAR.key,

  enrichDeclaration: (declaration, transportContext) => {
    if (!isHTTPRequestContext(transportContext)) {
      return declaration;
    }

    const extension = declaration as ExtensionDeclaration;

    // MCP extensions don't need HTTP method enrichment
    if (extension.info?.input?.type === "mcp") {
      return declaration;
    }

    const method = transportContext.method;

    // At declaration time, the schema uses a broad enum (["GET", "HEAD", "DELETE"] or ["POST", "PUT", "PATCH"])
    // because the method isn't known until the HTTP context is available.
    // Here we narrow it to the actual method for precise schema validation.
    const existingInputProps = extension.schema?.properties?.input?.properties || {};
    const updatedInputProps = {
      ...existingInputProps,
      method: {
        type: "string",
        enum: [method],
      },
    };

    const enrichedResult = {
      ...extension,
      info: {
        ...(extension.info || {}),
        input: {
          ...(extension.info?.input || {}),
          method,
        },
      },
      schema: {
        ...(extension.schema || {}),
        properties: {
          ...(extension.schema?.properties || {}),
          input: {
            ...(extension.schema?.properties?.input || {}),
            properties: updatedInputProps,
            required: [
              ...(extension.schema?.properties?.input?.required || []),
              ...(!(extension.schema?.properties?.input?.required || []).includes("method")
                ? ["method"]
                : []),
            ],
          },
        },
      },
    };

    // Dynamic routes: translate [param]/:param → :param for the routeTemplate catalog key;
    // pathParams carries runtime values (distinct from pathParamsSchema in the declaration).
    // Wildcard * segments are auto-converted to :var1, :var2, etc. for catalog normalization.
    const rawRoutePattern = (transportContext as HTTPRequestContext).routePattern;
    const routePattern = rawRoutePattern ? normalizeWildcardPattern(rawRoutePattern) : undefined;
    const dynamicRoute = routePattern
      ? extractDynamicRouteInfo(routePattern, transportContext.adapter.getPath())
      : null;
    if (dynamicRoute) {
      const inputSchemaProps = enrichedResult.schema?.properties?.input?.properties || {};
      const hasPathParamsInSchema = "pathParams" in inputSchemaProps;
      return {
        ...enrichedResult,
        routeTemplate: dynamicRoute.routeTemplate,
        info: {
          ...enrichedResult.info,
          input: { ...enrichedResult.info.input, pathParams: dynamicRoute.pathParams },
        },
        ...(!hasPathParamsInSchema
          ? {
              schema: {
                ...enrichedResult.schema,
                properties: {
                  ...enrichedResult.schema?.properties,
                  input: {
                    ...enrichedResult.schema?.properties?.input,
                    properties: {
                      ...inputSchemaProps,
                      pathParams: { type: "object" },
                    },
                  },
                },
              },
            }
          : {}),
      };
    }

    return enrichedResult;
  },
};
