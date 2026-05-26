import { defineConfig } from "tsup";

const baseConfig = {
  entry: {
    index: "src/index.ts",
    "evm/index": "src/evm/index.ts",
    "svm/index": "src/svm/index.ts",
    "avm/index": "src/avm/index.ts",
  },
  dts: {
    resolve: true,
  },
  splitting: false,
  sourcemap: true,
  external: ["react", "react-dom"],
  treeshake: true,
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
