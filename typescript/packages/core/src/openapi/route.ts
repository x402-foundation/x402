/**
 * Route pattern parsing: converts x402 route patterns to OpenAPI paths.
 */

export const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ParsedRoute {
  /** HTTP method (lowercase) */
  method: HttpMethod;
  /** OpenAPI-style path with {param} placeholders */
  path: string;
  /** Extracted path parameter names in order */
  pathParams: string[];
}

/**
 * Default route for a single RouteConfig with no pattern.
 */
export const DEFAULT_ROUTE: ParsedRoute = {
  method: "get",
  path: "/",
  pathParams: [],
};

/**
 * Check if a string is a valid HTTP method.
 *
 * @param value - The string to check
 * @returns True if the value is a valid HTTP method
 */
function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

/**
 * Parse an x402 route pattern like "GET /weather/:city" into its components.
 *
 * Converts Express-style `:param` segments to OpenAPI `{param}` format.
 *
 * @param pattern - Route pattern string (e.g., "GET /weather/:city")
 * @returns Parsed route with method, path, and path parameter names
 */
export function parseRoutePattern(pattern: string): ParsedRoute {
  const parts = pattern.trim().split(/\s+/);
  let method: HttpMethod = "get";
  let rawPath = "/";

  if (parts.length >= 2) {
    const candidate = parts[0].toLowerCase();
    method = isHttpMethod(candidate) ? candidate : "get";
    rawPath = parts[1];
  } else if (parts.length === 1) {
    if (parts[0].startsWith("/")) {
      rawPath = parts[0];
    } else {
      const candidate = parts[0].toLowerCase();
      method = isHttpMethod(candidate) ? candidate : "get";
    }
  }

  const pathParams: string[] = [];
  const path = rawPath.replace(/:([^/]+)/g, (_match, paramName: string) => {
    pathParams.push(paramName);
    return `{${paramName}}`;
  });

  return { method, path, pathParams };
}
