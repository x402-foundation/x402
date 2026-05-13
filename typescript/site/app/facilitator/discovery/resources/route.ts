/**
 * `GET /facilitator/discovery/resources`
 *
 * Lists x402 resources cataloged by the bazaar extension hook. Spec:
 * https://github.com/x402-foundation/x402/blob/main/specs/extensions/bazaar.md
 */

import type { ListDiscoveryResourcesParams } from "@x402/extensions";
import { getBazaarCatalog } from "../catalog";

/**
 * Reads, validates, and clamps the query params for the list endpoint.
 *
 * @param url - The incoming request URL.
 * @returns A `ListDiscoveryResourcesParams` object ready for the catalog.
 */
function parseListParams(url: URL): ListDiscoveryResourcesParams {
  const params: ListDiscoveryResourcesParams = {};
  const type = url.searchParams.get("type");
  const payTo = url.searchParams.get("payTo");
  const scheme = url.searchParams.get("scheme");
  const network = url.searchParams.get("network");
  const extensions = url.searchParams.get("extensions");
  const limitRaw = url.searchParams.get("limit");
  const offsetRaw = url.searchParams.get("offset");
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
  if (offsetRaw !== null) {
    const n = Number(offsetRaw);
    if (!Number.isFinite(n)) throw new Error("offset must be a finite number");
    params.offset = n;
  }
  return params;
}

/**
 * Handles GET requests. Returns the catalog list response or a 400 with a
 * structured error matching the verify/settle route conventions.
 *
 * @param req - The incoming request.
 * @returns The JSON response.
 */
export async function GET(req: Request) {
  let params: ListDiscoveryResourcesParams;
  try {
    params = parseListParams(new URL(req.url));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: "invalid_query", errorMessage: message }, { status: 400 });
  }

  try {
    const catalog = await getBazaarCatalog();
    const response = await catalog.list(params);
    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[bazaar] /discovery/resources error:", message);
    return Response.json({ error: "unexpected_error", errorMessage: message }, { status: 500 });
  }
}
