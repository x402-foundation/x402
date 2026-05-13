/**
 * In-memory `BazaarCatalog` implementation.
 *
 * Suitable for tests, examples, and local development. Production deployments
 * should swap in a persistent implementation (see `./postgres`).
 */

import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveryInfo } from "../types";
import type { DiscoveredHTTPResource } from "../http/types";
import type { DiscoveredMCPResource } from "../mcp/types";
import type {
  BazaarCatalog,
  CatalogUpsertInput,
  DiscoveryResource,
  DiscoveryResourcesResponse,
  ListDiscoveryResourcesParams,
  SearchDiscoveryResourcesParams,
  SearchDiscoveryResourcesResponse,
} from "./catalog";

interface StoredRow {
  /** Composite key: `${resourceUrl}::${method ?? "tool=" + toolName}`. Used internally for the Map. */
  key: string;
  resourceUrl: string;
  type: "http" | "mcp";
  method?: string;
  toolName?: string;
  routeTemplate?: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  x402Version: number;
  discoveryInfo: DiscoveryInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * Discriminates MCP resources from HTTP resources by inspecting `input.type`.
 *
 * @param discovered - The extracted discovery resource to test.
 * @returns True if `discovered` is an MCP resource (narrows the type accordingly).
 */
function isMCP(
  discovered: DiscoveredHTTPResource | DiscoveredMCPResource,
): discovered is DiscoveredMCPResource {
  return discovered.discoveryInfo.input.type === "mcp";
}

/**
 * Computes the catalog key used to dedupe rows. HTTP rows are keyed by
 * `(resourceUrl, method)`; MCP rows by `(resourceUrl, toolName)`.
 *
 * @param discovered - The extracted discovery resource.
 * @returns The composite key string.
 */
function buildKey(discovered: DiscoveredHTTPResource | DiscoveredMCPResource): string {
  if (isMCP(discovered)) {
    return `${discovered.resourceUrl}::tool=${discovered.toolName}`;
  }
  return `${discovered.resourceUrl}::${discovered.method ?? "GET"}`;
}

/**
 * Merges `incoming` into `existing`, deduping by (scheme, network).
 * Mutates and returns `existing` for caller convenience.
 *
 * @param existing - The accumulated accepts array on the stored row.
 * @param incoming - The single PaymentRequirements observed in this payment.
 * @returns The mutated `existing` array.
 */
function mergeAccepts(
  existing: PaymentRequirements[],
  incoming: PaymentRequirements,
): PaymentRequirements[] {
  const existingIdx = existing.findIndex(
    a => a.scheme === incoming.scheme && a.network === incoming.network,
  );
  if (existingIdx === -1) {
    existing.push(incoming);
  } else {
    existing[existingIdx] = incoming;
  }
  return existing;
}

/**
 * Projects an internal `StoredRow` into the wire-format `DiscoveryResource`.
 *
 * @param row - The stored row.
 * @returns The wire-format discovery resource.
 */
function toDiscoveryResource(row: StoredRow): DiscoveryResource {
  return {
    resource: row.resourceUrl,
    type: row.type,
    x402Version: row.x402Version,
    accepts: row.accepts,
    lastUpdated: row.lastSeenAt.toISOString(),
    extensions: row.extensions,
  };
}

/**
 * Trivial substring scoring: serviceName (3) > description (2) > tags (1).
 * Intentionally simple — the real ranking lives in the Postgres tsvector path.
 *
 * @param row - The stored row to score.
 * @param query - The user-supplied search query.
 * @returns A non-negative integer score; 0 indicates no match.
 */
function searchScore(row: StoredRow, query: string): number {
  const q = query.toLowerCase();
  if (!q) return 0;
  let score = 0;
  if (row.serviceName && row.serviceName.toLowerCase().includes(q)) score += 3;
  if (row.description && row.description.toLowerCase().includes(q)) score += 2;
  if (row.tags?.some(t => t.toLowerCase().includes(q))) score += 1;
  return score;
}

/**
 * Map-backed `BazaarCatalog` for tests, examples, and local development.
 * Not durable: state is lost when the process exits.
 */
export class InMemoryBazaarCatalog implements BazaarCatalog {
  private readonly rows = new Map<string, StoredRow>();

  /**
   * Visible for testing — current row count.
   *
   * @returns The number of distinct cataloged resources.
   */
  get size(): number {
    return this.rows.size;
  }

  /** Visible for testing. */
  clear(): void {
    this.rows.clear();
  }

  /**
   * Insert or update the row for `input.discovered`. Merges `paymentRequirements`
   * into the row's accepts list (deduped by scheme+network) and updates lastSeenAt.
   *
   * @param input - The upsert payload assembled by `installBazaarFacilitator`.
   * @returns A promise that resolves once the in-memory map is updated.
   */
  async upsert(input: CatalogUpsertInput): Promise<void> {
    const { discovered, paymentRequirements, extensions } = input;
    const key = buildKey(discovered);
    const now = new Date();

    const existing = this.rows.get(key);
    if (existing) {
      mergeAccepts(existing.accepts, paymentRequirements);
      existing.lastSeenAt = now;
      // Refresh metadata from the latest payment so renamed services / updated descriptions propagate.
      existing.description = discovered.description ?? existing.description;
      existing.mimeType = discovered.mimeType ?? existing.mimeType;
      existing.serviceName = discovered.serviceName ?? existing.serviceName;
      existing.tags = discovered.tags ?? existing.tags;
      existing.iconUrl = discovered.iconUrl ?? existing.iconUrl;
      existing.discoveryInfo = discovered.discoveryInfo;
      if (extensions) {
        existing.extensions = { ...(existing.extensions ?? {}), ...extensions };
      }
      return;
    }

    const row: StoredRow = {
      key,
      resourceUrl: discovered.resourceUrl,
      type: discovered.discoveryInfo.input.type === "mcp" ? "mcp" : "http",
      method: isMCP(discovered) ? undefined : discovered.method,
      toolName: isMCP(discovered) ? discovered.toolName : undefined,
      routeTemplate: isMCP(discovered) ? undefined : discovered.routeTemplate,
      description: discovered.description,
      mimeType: discovered.mimeType,
      serviceName: discovered.serviceName,
      tags: discovered.tags,
      iconUrl: discovered.iconUrl,
      x402Version: discovered.x402Version,
      discoveryInfo: discovered.discoveryInfo,
      accepts: [paymentRequirements],
      extensions: extensions ? { ...extensions } : undefined,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    this.rows.set(key, row);
  }

  /**
   * Returns rows matching the optional filters, in firstSeenAt order, with offset
   * pagination. `limit` is clamped to `[1, 500]`; `offset` is clamped to `>= 0`.
   *
   * @param params - Optional list filters and pagination.
   * @returns The discovery resources response with `pagination.total`.
   */
  async list(params: ListDiscoveryResourcesParams = {}): Promise<DiscoveryResourcesResponse> {
    const filtered = this.filterRows(params);
    const total = filtered.length;
    const offset = Math.max(0, params.offset ?? 0);
    const limit = Math.min(Math.max(1, params.limit ?? 50), 500);
    const page = filtered.slice(offset, offset + limit);

    return {
      x402Version: 2,
      items: page.map(toDiscoveryResource),
      pagination: { limit, offset, total },
    };
  }

  /**
   * Substring-matches the query against serviceName/description/tags and returns
   * scored hits. Cursor pagination is engaged when `limit` is supplied.
   *
   * @param params - Search parameters (`query` is required).
   * @returns The matching resources, possibly with `pagination.cursor` set.
   */
  async search(params: SearchDiscoveryResourcesParams): Promise<SearchDiscoveryResourcesResponse> {
    const filtered = this.filterRows(params);
    const scored = filtered
      .map(row => ({ row, score: searchScore(row, params.query) }))
      .filter(s => s.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.row.firstSeenAt.getTime() - b.row.firstSeenAt.getTime(),
      );

    // Cursor pagination: cursor is the stringified index into the scored list.
    const limit = params.limit !== undefined ? Math.min(Math.max(1, params.limit), 500) : undefined;
    const startIdx = params.cursor ? Math.max(0, parseInt(params.cursor, 10) || 0) : 0;
    const endIdx = limit !== undefined ? startIdx + limit : scored.length;
    const page = scored.slice(startIdx, endIdx);
    const nextCursor = endIdx < scored.length ? String(endIdx) : null;

    return {
      x402Version: 2,
      resources: page.map(s => toDiscoveryResource(s.row)),
      pagination: limit !== undefined ? { limit, cursor: nextCursor } : null,
    };
  }

  /**
   * Applies the shared filter predicates used by both `list` and `search`.
   *
   * @param params - The list or search parameters with optional filter fields.
   * @returns The matching rows in firstSeenAt order.
   */
  private filterRows(
    params: ListDiscoveryResourcesParams | SearchDiscoveryResourcesParams,
  ): StoredRow[] {
    const all = Array.from(this.rows.values()).sort(
      (a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime(),
    );
    return all.filter(row => {
      if (params.type !== undefined && row.type !== params.type) return false;
      if (params.payTo !== undefined && !row.accepts.some(a => a.payTo === params.payTo)) {
        return false;
      }
      if (params.scheme !== undefined && !row.accepts.some(a => a.scheme === params.scheme)) {
        return false;
      }
      if (params.network !== undefined && !row.accepts.some(a => a.network === params.network)) {
        return false;
      }
      if (params.extensions !== undefined) {
        if (!row.extensions || !(params.extensions in row.extensions)) return false;
      }
      return true;
    });
  }
}
