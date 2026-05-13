/**
 * Convenience factory: `pg` + Drizzle + `PostgresBazaarCatalog` in one call.
 *
 * Pulls `pg` and `drizzle-orm/node-postgres` via dynamic import so the dependency
 * stays optional — callers that wire their own Drizzle db (e.g. Neon HTTP driver
 * for Vercel serverless) can skip this helper entirely and instantiate
 * `PostgresBazaarCatalog` directly.
 */

import type { AnyDrizzlePgDatabase } from "./postgresCatalog";
import { PostgresBazaarCatalog } from "./postgresCatalog";

export interface CreatePostgresBazaarCatalogOptions {
  /** Postgres connection string (e.g. `postgres://user:pass@host:5432/db`). */
  connectionString: string;
  /** Whether to run pending migrations on startup. Defaults to `false`. */
  migrate?: boolean;
}

export interface PostgresBazaarCatalogHandle {
  catalog: PostgresBazaarCatalog;
  db: AnyDrizzlePgDatabase;
  /** Closes the underlying pg pool. Call this on shutdown. */
  close: () => Promise<void>;
}

/**
 * Creates a `PostgresBazaarCatalog` backed by a `pg` connection pool.
 *
 * Throws a helpful error if `pg` is not installed — it's an optional peer dep
 * so consumers that use Neon HTTP / `postgres-js` don't have to install it.
 *
 * @param options - Connection options.
 * @returns A handle with the catalog, the Drizzle db, and a `close()` to drain the pool.
 */
export async function createPostgresBazaarCatalog(
  options: CreatePostgresBazaarCatalogOptions,
): Promise<PostgresBazaarCatalogHandle> {
  let pgModule: typeof import("pg");
  try {
    pgModule = await import("pg");
  } catch {
    throw new Error(
      "createPostgresBazaarCatalog requires the optional peer dependency 'pg'. " +
        "Install it (npm install pg) or instantiate PostgresBazaarCatalog directly with your own Drizzle db.",
    );
  }
  const { drizzle } = await import("drizzle-orm/node-postgres");

  const pool = new pgModule.Pool({ connectionString: options.connectionString });
  const db = drizzle(pool) as AnyDrizzlePgDatabase;

  if (options.migrate) {
    const { migrateBazaar } = await import("./migrate");
    await migrateBazaar(db);
  }

  return {
    catalog: new PostgresBazaarCatalog(db),
    db,
    close: async () => {
      await pool.end();
    },
  };
}
