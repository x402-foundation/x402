import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ mode }) => ({
  test: {
    env: loadEnv(mode, process.cwd(), ""),
    exclude: ["**/node_modules/**", "**/dist/**", "**/test/integrations/**"],
    // Deriving the Masumi escrow address applies parameters to a ~20k-character
    // compiled validator. The result is memoized per parameterization, but each
    // test file runs in its own worker and so pays that cost once — several
    // seconds on a CI runner, past vitest's 5s default.
    testTimeout: 30_000,
  },
  plugins: [tsconfigPaths({ projects: ["."] })],
}));
