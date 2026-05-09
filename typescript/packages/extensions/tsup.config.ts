import { defineConfig } from "tsup";

const baseConfig = {
  entry: {
    index: "src/index.ts",
    "bazaar/index": "src/bazaar/index.ts",
    "sign-in-with-x/index": "src/sign-in-with-x/index.ts",
    "offer-receipt/index": "src/offer-receipt/index.ts",
    "payment-identifier/index": "src/payment-identifier/index.ts",
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
