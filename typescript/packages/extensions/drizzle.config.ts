/**
 * Drizzle Kit config for bazaar Postgres schema introspection / generation.
 *
 * The schema is shipped along with hand-written SQL migrations in
 * `src/bazaar/facilitator-service/postgres/migrations`. Use `pnpm db:generate`
 * to materialize new diffs from `schema.ts` (you may need to merge the output
 * into `0001_init.sql` if you're adjusting the generated tsvector column).
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/bazaar/facilitator-service/postgres/schema.ts",
  out: "./src/bazaar/facilitator-service/postgres/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.BAZAAR_DATABASE_URL ?? "postgres://localhost:5432/postgres",
  },
});
