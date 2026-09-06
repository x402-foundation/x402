import { generateKeyPairSigner } from "@solana/kit";
import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";

const { getLatestBlockhashSend } = vi.hoisted(() => ({
  getLatestBlockhashSend: vi.fn(),
}));

// Stub the RPC so enhancePaymentRequirements resolves a deterministic blockhash
// without a network round-trip. Only createRpcClient is overridden; the rest of
// the utils module (money conversion, mint lookup) stays real.
vi.mock("../../src/utils", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils")>("../../src/utils");
  return {
    ...actual,
    createRpcClient: () => ({
      getLatestBlockhash: () => ({
        send: getLatestBlockhashSend,
      }),
    }),
  };
});

import { ExactSvmScheme } from "../../src/exact/server/scheme";
import { UptoSvmScheme } from "../../src/upto/server/scheme";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";

describe("ExactSvmScheme — recent blockhash in the 402 challenge", () => {
  beforeEach(() => {
    getLatestBlockhashSend.mockReset();
    getLatestBlockhashSend.mockResolvedValue({
      context: { slot: 98765n },
      value: {
        blockhash: "EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k",
        lastValidBlockHeight: 12345n,
      },
    });
  });

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

  it("omits the blockhash when the configured RPC fails", async () => {
    getLatestBlockhashSend.mockRejectedValueOnce(new Error("RPC unavailable"));
    const scheme = new ExactSvmScheme({ rpcUrl: "https://rpc.example" });

    const req = await scheme.enhancePaymentRequirements(base as never, supportedKind as never, []);

    expect(req.extra?.recentBlockhash).toBeUndefined();
    expect(req.extra?.lastValidBlockHeight).toBeUndefined();
    expect(req.extra?.feePayer).toBe("FeePay3r1111111111111111111111111111111111");
  });
});

describe("UptoSvmScheme — recent blockhash + slot in the 402 challenge", () => {
  let authorizer: Awaited<ReturnType<typeof generateKeyPairSigner>>;

  beforeAll(async () => {
    authorizer = await generateKeyPairSigner();
  });

  beforeEach(() => {
    getLatestBlockhashSend.mockReset();
    getLatestBlockhashSend.mockResolvedValue({
      context: { slot: 98765n },
      value: {
        blockhash: "EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k",
        lastValidBlockHeight: 12345n,
      },
    });
  });

  const base = {
    scheme: "upto",
    network: SOLANA_DEVNET_CAIP2,
    amount: "100000",
    asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    payTo: "GsbwXfJraMomNxBcjK7xK2xQx5MQgQUF2k3wEX2Q9z3w",
    maxTimeoutSeconds: 300,
    extra: {},
  };
  const supportedKind = {
    x402Version: 2,
    scheme: "upto",
    network: SOLANA_DEVNET_CAIP2,
    extra: { feePayer: "FeePay3r1111111111111111111111111111111111" },
  };

  it("embeds recentBlockhash + recentSlot (from the same response) when an rpcUrl is configured", async () => {
    const scheme = new UptoSvmScheme({
      receiverAuthorizerSigner: authorizer,
      rpcUrl: "https://rpc.example",
    });
    const req = await scheme.enhancePaymentRequirements(base as never, supportedKind as never, []);
    expect(req.extra?.recentBlockhash).toBe("EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k");
    expect(req.extra?.lastValidBlockHeight).toBe("12345");
    // The slot the blockhash was produced at — the channel-PDA `open_slot` anchor.
    expect(req.extra?.recentSlot).toBe("98765");
    expect(req.extra?.feePayer).toBe("FeePay3r1111111111111111111111111111111111");
    expect(req.extra?.receiverAuthorizer).toBe(authorizer.address);
  });

  it("omits the blockhash and slot when no rpcUrl is configured", async () => {
    const scheme = new UptoSvmScheme({ receiverAuthorizerSigner: authorizer });
    const req = await scheme.enhancePaymentRequirements(base as never, supportedKind as never, []);
    expect(req.extra?.recentBlockhash).toBeUndefined();
    expect(req.extra?.lastValidBlockHeight).toBeUndefined();
    expect(req.extra?.recentSlot).toBeUndefined();
    expect(req.extra?.feePayer).toBe("FeePay3r1111111111111111111111111111111111");
    expect(req.extra?.receiverAuthorizer).toBe(authorizer.address);
  });
});
