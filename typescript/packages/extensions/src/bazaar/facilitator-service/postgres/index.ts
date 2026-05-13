/**
 * Postgres-backed Bazaar catalog.
 *
 * Import via the subpath: `@x402/extensions/bazaar/postgres`. Keeping it as a
 * separate entry point means consumers that use the in-memory catalog (or roll
 * their own backend) don't pull in Drizzle / pg.
 */

export { PostgresBazaarCatalog, type AnyDrizzlePgDatabase } from "./postgresCatalog";

export {
  createPostgresBazaarCatalog,
  type CreatePostgresBazaarCatalogOptions,
  type PostgresBazaarCatalogHandle,
} from "./factory";

export { migrateBazaar } from "./migrate";

export {
  discoveredResources,
  searchVectorMatch,
  searchVectorRank,
  type DiscoveredResourcesRow,
  type NewDiscoveredResourcesRow,
} from "./schema";
