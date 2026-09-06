import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ mode }) => ({
  test: {
    env: loadEnv(mode, process.cwd(), ""),
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/test/integrations/**", // Exclude integration tests from default run
    ],
  },
  plugins: [tsconfigPaths({ projects: ["."] })],
}));
