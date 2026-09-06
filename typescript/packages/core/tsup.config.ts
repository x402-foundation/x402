import { defineConfig } from "tsup";

const baseConfig = {
  entry: {
    index: "src/index.ts",
    "client/index": "src/client/index.ts",
    "facilitator/index": "src/facilitator/index.ts",
    "http/index": "src/http/index.ts",
    "server/index": "src/server/index.ts",
    "types/index": "src/types/index.ts",
    "types/v1/index": "src/types/v1/index.ts",
    "utils/index": "src/utils/index.ts",
    "schemas/index": "src/schemas/index.ts",
  },
  dts: {
    resolve: true,
  },
  sourcemap: true,
  target: "es2020",
};

export default defineConfig([
  {
    ...baseConfig,
    format: "esm",
    outDir: "dist/esm",
    clean: true,
  },
  {
    ...baseConfig,
    format: "cjs",
    outDir: "dist/cjs",
    clean: false,
  },
]);
