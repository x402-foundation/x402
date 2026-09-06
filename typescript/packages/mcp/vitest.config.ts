import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ mode }) => ({
  test: {
    env: loadEnv(mode, process.cwd(), ""),
    // Exclude integration tests from default test run (they require real blockchain)
    exclude: ["**/node_modules/**", "**/dist/**", "**/test/integration/**"],
  },
  plugins: [tsconfigPaths({ projects: ["."] })],
}));
