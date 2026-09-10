import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ mode }) => ({
  test: {
    env: loadEnv(mode, process.cwd(), ""),
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "**/*.d.ts", "**/gen/**", "**/dist/**"],
      reportsDirectory: "./coverage",
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    exclude: ["**/node_modules/**", "**/dist/**", "**/test/integrations/**"],
    // Deriving the Masumi escrow address applies parameters to a ~20k-character
    // compiled validator. On a CI runner a cache miss plus an offline provider
    // round-trip can exceed 30s even when every assertion is correct.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One worker keeps the script-hash memo cache warm across files and avoids
    // vitest IPC timeouts when several workers each run UPLC in parallel.
    fileParallelism: false,
    maxWorkers: 1,
    teardownTimeout: 30_000,
  },
  plugins: [tsconfigPaths({ projects: ["."] })],
}));
