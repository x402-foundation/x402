/**
 * `GET /facilitator/discovery/search`
 *
 * Natural-language search across cataloged x402 resources. Spec:
 * https://github.com/x402-foundation/x402/blob/main/specs/extensions/bazaar.md
 */

import type { SearchDiscoveryResourcesParams } from "@x402/extensions";
import { getBazaarCatalog } from "../catalog";

/**
 * Reads, validates, and clamps the query params for the search endpoint.
 * `query` is required; everything else mirrors the list filters.
 *
 * @param url - The incoming request URL.
 * @returns A `SearchDiscoveryResourcesParams` object.
 * @throws Error with a human-readable message when `query` is missing/empty.
 */
function parseSearchParams(url: URL): SearchDiscoveryResourcesParams {
  const query = url.searchParams.get("query");
  if (!query || query.trim().length === 0) {
    throw new Error("query is required");
  }
  const params: SearchDiscoveryResourcesParams = { query };
  const type = url.searchParams.get("type");
  const payTo = url.searchParams.get("payTo");
  const scheme = url.searchParams.get("scheme");
  const network = url.searchParams.get("network");
  const extensions = url.searchParams.get("extensions");
  const limitRaw = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  if (type) params.type = type;
  if (payTo) params.payTo = payTo;
  if (scheme) params.scheme = scheme;
  if (network) params.network = network;
  if (extensions) params.extensions = extensions;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n)) throw new Error("limit must be a finite number");
    params.limit = n;
  }
  if (cursor) params.cursor = cursor;
  return params;
}

/**
 * Handles GET requests. Mirrors the resources route's error envelope.
 *
 * @param req - The incoming request.
 * @returns The JSON response.
 */
export async function GET(req: Request) {
  let params: SearchDiscoveryResourcesParams;
  try {
    params = parseSearchParams(new URL(req.url));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: "invalid_query", errorMessage: message }, { status: 400 });
  }

  try {
    const catalog = await getBazaarCatalog();
    const response = await catalog.search(params);
    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[bazaar] /discovery/search error:", message);
    return Response.json({ error: "unexpected_error", errorMessage: message }, { status: 500 });
  }
}
