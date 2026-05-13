/**
 * Postgres-backed `BazaarCatalog` implementation.
 *
 * Uses Drizzle ORM over any compatible Postgres driver. The catalog only
 * depends on the Drizzle interface, so the caller decides which driver to
 * use (`pg` / `@neondatabase/serverless` / `postgres`). See `factory.ts`
 * for the convenience constructor that wires up `pg` for you.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveryInfo } from "../../types";
import type { DiscoveredHTTPResource } from "../../http/types";
import type { DiscoveredMCPResource } from "../../mcp/types";
import type {
  BazaarCatalog,
  CatalogUpsertInput,
  DiscoveryResource,
  DiscoveryResourcesResponse,
  ListDiscoveryResourcesParams,
  SearchDiscoveryResourcesParams,
  SearchDiscoveryResourcesResponse,
} from "../catalog";
import {
  discoveredResources,
  searchVectorMatch,
  searchVectorRank,
  type DiscoveredResourcesRow,
} from "./schema";

// Drizzle's PgDatabase generic varies by driver. We accept the loosest form so
// callers can pass pg/Neon/postgres-js drizzles interchangeably.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDrizzlePgDatabase = PgDatabase<PgQueryResultHKT, any, any>;

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

/**
 * Clamps `n` into `[1, MAX_LIMIT]` with `fallback` for null/undefined inputs.
 *
 * @param n - Raw user-supplied value.
 * @param fallback - Default when `n` is null/undefined.
 * @returns The clamped integer.
 */
function clampLimit(n: number | undefined, fallback: number): number {
  if (n === undefined || n === null) return fallback;
  return Math.min(Math.max(1, Math.floor(n)), MAX_LIMIT);
}

/**
 * Determines whether the discovered resource is MCP based on `input.type`.
 *
 * @param discovered - Extracted resource.
 * @returns True if the resource is an MCP tool.
 */
function isMCP(
  discovered: DiscoveredHTTPResource | DiscoveredMCPResource,
): discovered is DiscoveredMCPResource {
  return discovered.discoveryInfo.input.type === "mcp";
}

/**
 * Projects a Drizzle row into the wire-format `DiscoveryResource`.
 *
 * @param row - Row returned by Drizzle.
 * @returns The shape returned by `list` and `search`.
 */
function rowToDiscoveryResource(row: DiscoveredResourcesRow): DiscoveryResource {
  return {
    resource: row.resourceUrl,
    type: row.type,
    x402Version: row.x402Version,
    accepts: row.accepts as PaymentRequirements[],
    lastUpdated: row.lastSeenAt.toISOString(),
    extensions: (row.extensions ?? undefined) as Record<string, unknown> | undefined,
  };
}

/**
 * Postgres-backed catalog. Pass a Drizzle `pg-core` database; the schema is
 * embedded so consumers don't have to import it explicitly.
 */
export class PostgresBazaarCatalog implements BazaarCatalog {
  /**
   * Wraps a Drizzle Postgres database in the `BazaarCatalog` interface.
   *
   * @param db - A Drizzle Postgres database instance from any compatible driver.
   */
  constructor(private readonly db: AnyDrizzlePgDatabase) {}

  /**
   * Upsert a discovered resource. Performs a transactional read-modify-write
   * to merge `accepts` deduped by (scheme, network) — Postgres lacks a
   * concise inline jsonb array merge with dedup semantics, so the
   * read-modify-write is both clearer and idiomatic.
   *
   * @param input - Upsert payload assembled by `installBazaarFacilitator`.
   * @returns A promise that resolves once the row has been persisted.
   */
  async upsert(input: CatalogUpsertInput): Promise<void> {
    const { discovered, paymentRequirements, extensions } = input;
    const method = isMCP(discovered) ? null : (discovered.method ?? null);
    const toolName = isMCP(discovered) ? discovered.toolName : null;
    const routeTemplate = isMCP(discovered) ? null : (discovered.routeTemplate ?? null);

    await this.db.transaction(async tx => {
      const existing = await tx
        .select()
        .from(discoveredResources)
        .where(
          and(
            eq(discoveredResources.resourceUrl, discovered.resourceUrl),
            method === null
              ? sql`${discoveredResources.method} IS NULL`
              : eq(discoveredResources.method, method),
            toolName === null
              ? sql`${discoveredResources.toolName} IS NULL`
              : eq(discoveredResources.toolName, toolName),
          ),
        )
        .limit(1);

      const now = new Date();

      if (existing.length === 0) {
        await tx.insert(discoveredResources).values({
          resourceUrl: discovered.resourceUrl,
          type: isMCP(discovered) ? "mcp" : "http",
          method,
          toolName,
          routeTemplate,
          description: discovered.description ?? null,
          mimeType: discovered.mimeType ?? null,
          serviceName: discovered.serviceName ?? null,
          tags: discovered.tags ?? null,
          iconUrl: discovered.iconUrl ?? null,
          x402Version: discovered.x402Version,
          discoveryInfo: discovered.discoveryInfo as DiscoveryInfo,
          accepts: [paymentRequirements],
          extensions: extensions ?? null,
          firstSeenAt: now,
          lastSeenAt: now,
        });
        return;
      }

      const row = existing[0];
      const accepts = row.accepts as PaymentRequirements[];
      const idx = accepts.findIndex(
        a => a.scheme === paymentRequirements.scheme && a.network === paymentRequirements.network,
      );
      const nextAccepts =
        idx === -1
          ? [...accepts, paymentRequirements]
          : accepts.map((a, i) => (i === idx ? paymentRequirements : a));

      await tx
        .update(discoveredResources)
        .set({
          // Refresh metadata so renamed services and updated descriptions propagate.
          description: discovered.description ?? row.description,
          mimeType: discovered.mimeType ?? row.mimeType,
          serviceName: discovered.serviceName ?? row.serviceName,
          tags: discovered.tags ?? row.tags,
          iconUrl: discovered.iconUrl ?? row.iconUrl,
          discoveryInfo: discovered.discoveryInfo as DiscoveryInfo,
          accepts: nextAccepts,
          extensions: extensions ? { ...(row.extensions ?? {}), ...extensions } : row.extensions,
          lastSeenAt: now,
        })
        .where(eq(discoveredResources.id, row.id));
    });
  }

  /**
   * Lists rows matching the filters with offset pagination. Filters use
   * jsonb containment against `accepts` so they benefit from the GIN index.
   *
   * @param params - Optional filters / pagination.
   * @returns The discovery response including `pagination.total`.
   */
  async list(params: ListDiscoveryResourcesParams = {}): Promise<DiscoveryResourcesResponse> {
    const limit = clampLimit(params.limit, DEFAULT_LIMIT);
    const offset = params.offset !== undefined ? Math.max(0, Math.floor(params.offset)) : 0;
    const filter = this.buildFilter(params);

    const items = await this.db
      .select()
      .from(discoveredResources)
      .where(filter)
      .orderBy(asc(discoveredResources.firstSeenAt), asc(discoveredResources.id))
      .limit(limit)
      .offset(offset);

    const totalRow = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(discoveredResources)
      .where(filter);
    const total = totalRow[0]?.count ?? 0;

    return {
      x402Version: 2,
      items: items.map(rowToDiscoveryResource),
      pagination: { limit, offset, total },
    };
  }

  /**
   * Full-text searches the catalog using websearch_to_tsquery + ts_rank_cd
   * over the generated `search_vector` column. Cursor pagination is keyset:
   * cursor is the base64-encoded (rank, id) of the last row of the prior page.
   *
   * @param params - Search params (`query` required).
   * @returns The search response.
   */
  async search(params: SearchDiscoveryResourcesParams): Promise<SearchDiscoveryResourcesResponse> {
    const query = params.query;
    if (!query || query.trim().length === 0) {
      return { x402Version: 2, resources: [] };
    }
    const limit = params.limit !== undefined ? clampLimit(params.limit, DEFAULT_LIMIT) : undefined;
    const baseFilter = this.buildFilter(params);
    const matchFilter = searchVectorMatch(query);
    const filter = baseFilter ? and(baseFilter, matchFilter) : matchFilter;
    const rank = searchVectorRank(query);

    // Keyset pagination: cursor encodes the (rank, id) of the last row served.
    // ORDER BY is `rank DESC, id ASC` so the seek predicate is:
    //   rank < cursor_rank  OR  (rank = cursor_rank AND id > cursor_id)
    // We can't use a single tuple compare here because the two columns sort in
    // opposite directions; Postgres tuple comparison would treat them uniformly.
    let cursorPredicate;
    if (params.cursor) {
      const decoded = decodeCursor(params.cursor);
      if (decoded) {
        cursorPredicate = sql`(${rank} < ${decoded.rank}) OR (${rank} = ${decoded.rank} AND ${discoveredResources.id} > ${decoded.id})`;
      }
    }

    const fetchLimit = limit !== undefined ? limit + 1 : MAX_LIMIT;
    const rows = await this.db
      .select({
        row: discoveredResources,
        rank: rank.as("rank"),
      })
      .from(discoveredResources)
      .where(cursorPredicate ? and(filter, cursorPredicate) : filter)
      .orderBy(desc(rank), asc(discoveredResources.id))
      .limit(fetchLimit);

    let nextCursor: string | null = null;
    let page = rows;
    if (limit !== undefined && rows.length > limit) {
      page = rows.slice(0, limit);
      const last = page[page.length - 1];
      nextCursor = encodeCursor({ rank: Number(last.rank), id: last.row.id });
    }

    return {
      x402Version: 2,
      resources: page.map(r => rowToDiscoveryResource(r.row)),
      pagination: limit !== undefined ? { limit, cursor: nextCursor } : null,
    };
  }

  /**
   * Builds the shared SQL filter used by both `list` and `search`.
   *
   * @param params - Filter params from the request.
   * @returns The combined drizzle SQL predicate, or undefined when no filter is active.
   */
  private buildFilter(params: ListDiscoveryResourcesParams | SearchDiscoveryResourcesParams) {
    const clauses = [] as ReturnType<typeof sql>[];
    if (params.type !== undefined) {
      clauses.push(sql`${discoveredResources.type} = ${params.type}`);
    }
    if (params.payTo !== undefined) {
      clauses.push(
        sql`${discoveredResources.accepts} @> ${JSON.stringify([{ payTo: params.payTo }])}::jsonb`,
      );
    }
    if (params.scheme !== undefined) {
      clauses.push(
        sql`${discoveredResources.accepts} @> ${JSON.stringify([{ scheme: params.scheme }])}::jsonb`,
      );
    }
    if (params.network !== undefined) {
      clauses.push(
        sql`${discoveredResources.accepts} @> ${JSON.stringify([{ network: params.network }])}::jsonb`,
      );
    }
    if (params.extensions !== undefined) {
      clauses.push(sql`${discoveredResources.extensions} ? ${params.extensions}`);
    }
    return clauses.length === 0 ? undefined : and(...clauses);
  }
}

/**
 * Encodes a `(rank, id)` pair as a base64url cursor for search pagination.
 *
 * @param value - The pair to encode.
 * @param value.rank - The ts_rank_cd score for the last row served.
 * @param value.id - The numeric id of the last row served (tiebreaker).
 * @returns The base64url-encoded cursor string.
 */
function encodeCursor(value: { rank: number; id: number }): string {
  return Buffer.from(`${value.rank};${value.id}`, "utf8").toString("base64url");
}

/**
 * Decodes a cursor produced by `encodeCursor`. Returns null on any malformed input.
 *
 * @param cursor - The base64url cursor string from a previous page.
 * @returns The decoded `(rank, id)` pair, or `null` if the cursor is invalid.
 */
function decodeCursor(cursor: string): { rank: number; id: number } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [rankStr, idStr] = decoded.split(";");
    const rank = Number(rankStr);
    const id = Number(idStr);
    if (!Number.isFinite(rank) || !Number.isFinite(id)) return null;
    return { rank, id };
  } catch {
    return null;
  }
}
