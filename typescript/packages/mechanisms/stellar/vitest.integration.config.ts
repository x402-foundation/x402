import { loadEnv } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  test: {
    env: loadEnv(mode, process.cwd(), ""),
    include: ["test/integrations/**/*.test.ts"], // Only include integration tests
    testTimeout: 20000,
    hookTimeout: 20000,
  },
  plugins: [tsconfigPaths({ projects: ["."] })],
}));
