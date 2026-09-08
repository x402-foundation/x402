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
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/test/integrations/**", // Exclude integration tests from default run
    ],
  },
  plugins: [tsconfigPaths({ projects: ["."] })],
}));
