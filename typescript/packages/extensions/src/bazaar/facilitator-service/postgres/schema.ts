/**
 * Drizzle schema for the bazaar discovered_resources table.
 *
 * The generated `search_vector` column and its GIN index are created via raw
 * SQL in `migrations/0001_init.sql`; Drizzle's typed schema does not (yet)
 * model generated columns or `NULLS NOT DISTINCT` unique indexes cleanly, so
 * those live in the migration file. The catalog implementation reads/writes
 * everything but the generated column.
 */

import { sql } from "drizzle-orm";
import { bigserial, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveryInfo } from "../../types";

export const discoveredResources = pgTable(
  "discovered_resources",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    resourceUrl: text("resource_url").notNull(),
    type: text("type", { enum: ["http", "mcp"] }).notNull(),
    method: text("method"),
    toolName: text("tool_name"),
    routeTemplate: text("route_template"),
    description: text("description"),
    mimeType: text("mime_type"),
    serviceName: text("service_name"),
    tags: text("tags").array(),
    iconUrl: text("icon_url"),
    x402Version: integer("x402_version").notNull(),
    discoveryInfo: jsonb("discovery_info").$type<DiscoveryInfo>().notNull(),
    accepts: jsonb("accepts").$type<PaymentRequirements[]>().notNull(),
    extensions: jsonb("extensions").$type<Record<string, unknown>>(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    // GIN index on the search_vector column is declared in the SQL migration
    // (Drizzle can't reference generated columns it doesn't model). The btree
    // indexes below cover the common filter paths used by `list`.
    index("discovered_resources_type_idx").on(table.type),
    index("discovered_resources_last_seen_idx").on(table.lastSeenAt),
    // Catalog key (resource_url, method, tool_name) with NULLS NOT DISTINCT is
    // also declared in the SQL migration — drizzle-kit emits it as a partial
    // unique index that doesn't match the spec's requirement that NULL slots
    // participate in uniqueness.
    index("discovered_resources_resource_url_idx").on(table.resourceUrl),
  ],
);

export type DiscoveredResourcesRow = typeof discoveredResources.$inferSelect;
export type NewDiscoveredResourcesRow = typeof discoveredResources.$inferInsert;

/**
 * SQL fragment that produces the websearch tsquery for `search_vector`.
 * Exported so the Postgres catalog and any consumer can ORDER BY the same rank.
 *
 * @param query - The user-supplied natural-language query.
 * @returns A drizzle SQL fragment usable in WHERE / ORDER BY clauses.
 */
export function searchVectorMatch(query: string) {
  return sql`search_vector @@ websearch_to_tsquery('english', ${query})`;
}

/**
 * SQL fragment producing the ts_rank_cd score for the same query.
 *
 * @param query - The user-supplied natural-language query.
 * @returns A drizzle SQL fragment producing a real-valued rank.
 */
export function searchVectorRank(query: string) {
  return sql<number>`ts_rank_cd(search_vector, websearch_to_tsquery('english', ${query}))`;
}
