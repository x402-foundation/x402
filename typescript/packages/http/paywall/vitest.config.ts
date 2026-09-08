import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Coverage is scoped to Node-testable paywall logic (builder, HTML generation).
 * React entrypoints, wallet hooks, browser adapters, and build tooling are
 * excluded via an explicit include allowlist rather than a growing denylist.
 */
const NODE_TESTABLE_COVERAGE = [
  "src/builder.ts",
  "src/faucetUrls.ts",
  "src/index.ts",
  "src/paywallUtils.ts",
  "src/avm/index.ts",
  "src/avm/paywall.ts",
  "src/evm/index.ts",
  "src/evm/paywall.ts",
  "src/svm/index.ts",
  "src/svm/paywall.ts",
];

export default defineConfig(({ mode }) => ({
  test: {
    env: loadEnv(mode, process.cwd(), ""),
    coverage: {
      provider: "v8",
      include: NODE_TESTABLE_COVERAGE,
      exclude: ["src/**/*.test.ts", "**/*.d.ts"],
      reportsDirectory: "./coverage",
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
    setupFiles: ["./src/test-setup.ts"],
  },
  plugins: [tsconfigPaths({ projects: ["."] })],
}));
