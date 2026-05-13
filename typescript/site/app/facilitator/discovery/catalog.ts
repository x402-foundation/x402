/**
 * Catalog singleton for the bazaar discovery service.
 *
 * - `BAZAAR_DATABASE_URL` set → Postgres-backed catalog (auto-migrate on boot).
 * - `BAZAAR_DATABASE_URL` unset → in-memory catalog with a warning. Useful for
 *   local dev without a database; cataloged resources are lost on cold start.
 *
 * Lazy initialization mirrors `getFacilitator()` in [..](../index.ts) — the catalog
 * is created on first access so dev preview deploys without env config don't
 * crash at module load.
 */

import type { BazaarCatalog } from "@x402/extensions";
import { InMemoryBazaarCatalog } from "@x402/extensions";

let _catalogPromise: Promise<BazaarCatalog> | null = null;

/**
 * Builds the configured catalog. Selects Postgres if `BAZAAR_DATABASE_URL` is
 * present; otherwise falls back to an in-memory catalog.
 *
 * @returns A configured `BazaarCatalog`.
 */
async function createCatalog(): Promise<BazaarCatalog> {
  const url = process.env.BAZAAR_DATABASE_URL;
  if (!url) {
    console.warn(
      "[bazaar] BAZAAR_DATABASE_URL unset — using in-memory catalog. " +
        "Discovered resources will be lost on cold start.",
    );
    return new InMemoryBazaarCatalog();
  }

  // Dynamic import so the in-memory path doesn't load drizzle/pg in tests.
  const { createPostgresBazaarCatalog } = await import("@x402/extensions/bazaar/postgres");
  const handle = await createPostgresBazaarCatalog({
    connectionString: url,
    migrate: true,
  });
  return handle.catalog;
}

/**
 * Returns the singleton `BazaarCatalog`, initializing on first access.
 *
 * @returns A promise resolving to the configured catalog.
 */
export async function getBazaarCatalog(): Promise<BazaarCatalog> {
  if (!_catalogPromise) {
    _catalogPromise = createCatalog();
  }
  return _catalogPromise;
}
