/**
 * Bazaar Facilitator Service — server-side helpers for cataloging x402 discoveries.
 *
 * The SDK exports here let a facilitator host the discovery endpoints required
 * by the bazaar spec. The flow is:
 *
 * 1. Pick or implement a `BazaarCatalog` (see `InMemoryBazaarCatalog` for a
 *    reference / test implementation, or `./postgres` for a Postgres-backed one).
 * 2. Call `installBazaarFacilitator(facilitator, catalog)` to register the
 *    `bazaar` extension and the post-verify cataloging hook.
 * 3. Wire `catalog.list(...)` / `catalog.search(...)` behind your HTTP routes
 *    at `GET /discovery/resources` and `GET /discovery/search`.
 */

export type {
  BazaarCatalog,
  CatalogUpsertInput,
  DiscoveryResource,
  DiscoveryResourcesResponse,
  SearchDiscoveryResourcesResponse,
  ListDiscoveryResourcesParams,
  SearchDiscoveryResourcesParams,
} from "./catalog";

export {
  installBazaarFacilitator,
  type InstallBazaarFacilitatorOptions,
} from "./installFacilitator";

export { InMemoryBazaarCatalog } from "./memoryCatalog";
