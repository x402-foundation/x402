import { describe, it, expect, vi } from "vitest";

// Stub the RPC so enhancePaymentRequirements resolves a deterministic blockhash
// without a network round-trip. Only createRpcClient is overridden; the rest of
// the utils module (money conversion, mint lookup) stays real.
vi.mock("../../src/utils", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils")>("../../src/utils");
  return {
    ...actual,
    createRpcClient: () => ({
      getLatestBlockhash: () => ({
        send: async () => ({
          value: {
            blockhash: "EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k",
            lastValidBlockHeight: 12345n,
          },
        }),
      }),
    }),
  };
});

import { ExactSvmScheme } from "../../src/exact/server/scheme";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";

describe("ExactSvmScheme — recent blockhash in the 402 challenge", () => {
  const base = {
    scheme: "exact",
    network: SOLANA_DEVNET_CAIP2,
    amount: "100000",
    asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    payTo: "GsbwXfJraMomNxBcjK7xK2xQx5MQgQUF2k3wEX2Q9z3w",
    maxTimeoutSeconds: 300,
    extra: {},
  };
  const supportedKind = {
    x402Version: 2,
    scheme: "exact",
    network: SOLANA_DEVNET_CAIP2,
    extra: { feePayer: "FeePay3r1111111111111111111111111111111111" },
  };

  it("embeds recentBlockhash + lastValidBlockHeight when an rpcUrl is configured", async () => {
    const scheme = new ExactSvmScheme({ rpcUrl: "https://rpc.example" });
    const req = await scheme.enhancePaymentRequirements(base as never, supportedKind as never, []);
    expect(req.extra?.recentBlockhash).toBe("EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k");
    expect(req.extra?.lastValidBlockHeight).toBe("12345");
    // The feePayer is still threaded through alongside the blockhash.
    expect(req.extra?.feePayer).toBe("FeePay3r1111111111111111111111111111111111");
  });

  it("omits the blockhash when no rpcUrl is configured", async () => {
    const scheme = new ExactSvmScheme();
    const req = await scheme.enhancePaymentRequirements(base as never, supportedKind as never, []);
    expect(req.extra?.recentBlockhash).toBeUndefined();
    expect(req.extra?.lastValidBlockHeight).toBeUndefined();
    expect(req.extra?.feePayer).toBe("FeePay3r1111111111111111111111111111111111");
  });
});
