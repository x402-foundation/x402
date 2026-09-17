import { defineConfig } from "tsup";

const baseConfig = {
  entry: {
    index: "src/index.ts",
    "exact/client/index": "src/exact/client/index.ts",
    "exact/server/index": "src/exact/server/index.ts",
    "exact/facilitator/index": "src/exact/facilitator/index.ts",
    "batch-settlement/index": "src/batch-settlement/index.ts",
    "batch-settlement/client/index": "src/batch-settlement/client/index.ts",
    "batch-settlement/client/file-storage": "src/batch-settlement/client/fileStorage.ts",
    "batch-settlement/server/index": "src/batch-settlement/server/index.ts",
    "batch-settlement/server/file-storage": "src/batch-settlement/server/fileStorage.ts",
    "batch-settlement/server/redis-storage": "src/batch-settlement/server/redisStorage.ts",
    "batch-settlement/facilitator/index": "src/batch-settlement/facilitator/index.ts",
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
