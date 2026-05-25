import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ mode }) => ({
  test: {
    env: loadEnv(mode, process.cwd(), ""),
    coverage: {
      provider: "v8",
      // Scope to the non-Postgres facilitator-service files. The postgres/
      // subdirectory requires a live database — run `pnpm test:coverage:db`
      // (which sets RUN_DB_TESTS=1) to include those in the report.
      include: [
        "src/bazaar/facilitator-service/catalog.ts",
        "src/bazaar/facilitator-service/installFacilitator.ts",
        "src/bazaar/facilitator-service/memoryCatalog.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 90, functions: 90, branches: 85 },
    },
  },
  plugins: [tsconfigPaths({ projects: ["."] })],
}));
