import { defineConfig } from "tsup";

const baseConfig = {
  entry: {
    index: "src/index.ts",
    "shared/index": "src/shared/index.ts",
    "shared/evm/index": "src/shared/evm/index.ts",
    "schemes/index": "src/schemes/index.ts",
    "client/index": "src/client/index.ts",
    "verify/index": "src/verify/index.ts",
    "facilitator/index": "src/facilitator/index.ts",
    "paywall/index": "src/paywall/index.ts",
    "types/index": "src/types/index.ts",
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
