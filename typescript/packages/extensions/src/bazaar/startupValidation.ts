/**
 * Shared startup-time validation utilities for bazaar extensions in route configs.
 *
 * Used by middleware packages (Express, Hono, Next) to validate bazaar extensions
 * at server startup without duplicating the iteration and warning logic.
 */

import type { RoutesConfig } from "@x402/core/server";
import type { DiscoveryExtension } from "./types";
import { validateDiscoveryExtension, validateDiscoveryExtensionSpec } from "./facilitator";

export { checkIfBazaarNeeded } from "@x402/core/server";

const HTTP_VERB_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD)\b/i;

/**
 * Inject a synthetic method into a pre-enrichment extension so the schema's
 * required:["method"] check doesn't produce a false-positive warning at startup.
 * Priority: (1) route pattern verb (e.g. "GET /api"), (2) body vs query inference.
 * Returns the same object unchanged if method is already present.
 *
 * @param ext - The raw bazaar extension object
 * @param pattern - The route pattern key (e.g. "GET /api" or "*")
 * @returns The extension with a synthetic method injected into info.input if needed
 */
function withSyntheticMethod(
  ext: Record<string, unknown>,
  pattern: string,
): Record<string, unknown> {
  const info = ext.info as Record<string, unknown> | undefined;
  const input = info?.input as Record<string, unknown> | undefined;
  if (!input || (typeof input.method === "string" && input.method)) {
    return ext;
  }
  const verbMatch = pattern.match(HTTP_VERB_RE);
  const method = verbMatch
    ? verbMatch[1].toUpperCase()
    : input.body !== undefined || input.bodyType !== undefined
      ? "POST"
      : "GET";
  return { ...ext, info: { ...info, input: { ...input, method } } };
}

/**
 * Validate bazaar extensions on all routes using JSON-schema validation.
 * Emits console warnings for invalid extensions but does not throw.
 *
 * @param routes - Route configuration to scan for bazaar extensions
 */
export function validateBazaarRouteExtensions(routes: RoutesConfig): void {
  const entries: [string, { extensions?: Record<string, unknown> }][] =
    "accepts" in routes ? [["*", routes]] : Object.entries(routes);

  for (const [pattern, config] of entries) {
    const bazaarExt = config.extensions?.["bazaar"];
    if (!bazaarExt) continue;
    if (
      typeof bazaarExt === "object" &&
      bazaarExt !== null &&
      "info" in (bazaarExt as Record<string, unknown>) &&
      "schema" in (bazaarExt as Record<string, unknown>)
    ) {
      const specResult = validateDiscoveryExtensionSpec(bazaarExt as Record<string, unknown>);
      if (!specResult.valid) {
        console.warn(
          `x402: Route "${pattern}" has an invalid bazaar extension: ${specResult.errors?.join(", ")}`,
        );
        continue;
      }
      const extForSchema = withSyntheticMethod(bazaarExt as Record<string, unknown>, pattern);
      const schemaResult = validateDiscoveryExtension(
        extForSchema as unknown as DiscoveryExtension,
      );
      if (!schemaResult.valid) {
        console.warn(
          `x402: Route "${pattern}" has an invalid bazaar extension: ${schemaResult.errors?.join(", ")}`,
        );
      }
    } else {
      console.warn(
        `x402: Route "${pattern}" declares a bazaar extension but it is malformed ` +
          `(expected an object with "info" and "schema" fields)`,
      );
    }
  }
}
