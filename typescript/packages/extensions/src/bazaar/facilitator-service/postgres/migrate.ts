/**
 * Bazaar Postgres migrations runner.
 *
 * Production deployments should run migrations as part of a deploy step, not on
 * the hot path. This module exposes a single function that applies the SQL
 * migrations bundled with the package.
 *
 * The migrations live in `migrations/*.sql` and are applied lexicographically.
 * A `bazaar_schema_migrations` table tracks which files have been applied so
 * re-running is safe.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { AnyDrizzlePgDatabase } from "./postgresCatalog";

const MIGRATIONS_TABLE = "bazaar_schema_migrations";

/**
 * Resolves the migrations directory relative to this source file. In built
 * packages the postbuild step copies `migrations/` alongside the compiled
 * output; the second candidate falls back to the source tree for tests and
 * workspace consumers that run directly from `src/`.
 *
 * @returns Absolute path to the migrations directory.
 */
function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "migrations"),
    join(
      here,
      "..",
      "..",
      "..",
      "..",
      "src",
      "bazaar",
      "facilitator-service",
      "postgres",
      "migrations",
    ),
  ];
  for (const candidate of candidates) {
    try {
      readdirSync(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(`bazaar: unable to locate migrations directory (tried ${candidates.join(", ")})`);
}

/**
 * Applies all pending bazaar SQL migrations idempotently. Safe to run on every
 * deploy — already-applied migrations are skipped.
 *
 * @param db - Drizzle Postgres database (any compatible driver).
 */
export async function migrateBazaar(db: AnyDrizzlePgDatabase): Promise<void> {
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(MIGRATIONS_TABLE)} (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT NOW()
    )`,
  );

  const applied = await db.execute<{ name: string }>(
    sql`SELECT name FROM ${sql.raw(MIGRATIONS_TABLE)}`,
  );
  // Drizzle's execute() result shape varies by driver — normalize.
  const appliedRows =
    (applied as unknown as { rows: { name: string }[] }).rows ??
    (applied as unknown as { name: string }[]);
  const appliedSet = new Set(appliedRows.map(r => r.name));

  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter(name => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) continue;
    const sqlText = readFileSync(join(dir, file), "utf8");
    await db.transaction(async tx => {
      await tx.execute(sql.raw(sqlText));
      await tx.execute(sql`INSERT INTO ${sql.raw(MIGRATIONS_TABLE)} (name) VALUES (${file})`);
    });
  }
}
