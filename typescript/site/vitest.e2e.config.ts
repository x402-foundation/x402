import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  test: {
    // Load CLIENT_EVM_PRIVATE_KEY / CLIENT_SVM_PRIVATE_KEY / CLIENT_EVM_RPC_URL (plus
    // this app's own RESOURCE_*/FACILITATOR_* vars, inherited by the spawned `next
    // dev` child process below) from .env / .env.local, same convention the
    // mechanism packages' vitest.integration.config.ts use.
    env: loadEnv(mode, process.cwd(), ""),
    include: ["test/e2e/**/*.test.ts"],
    // Every test in this suite shares the same testnet client wallets and pays a real
    // (small) amount per request; running them concurrently would race nonces/balances
    // for no benefit, since the suite is already fast (a handful of testnet payments).
    fileParallelism: false,
    // Real chain settlement (plus the dev server's first-request compile) can take
    // several seconds; the default vitest timeout is too tight for that.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
}));
