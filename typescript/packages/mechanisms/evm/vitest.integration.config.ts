import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ mode }) => ({
  test: {
    env: loadEnv(mode, process.cwd(), ""),
    include: ["test/integrations/**/*.test.ts"], // Only include integration tests
    fileParallelism: false, // Prevent race conditions on tx nonces
  },
  plugins: [tsconfigPaths({ projects: ["."] })],
}));
