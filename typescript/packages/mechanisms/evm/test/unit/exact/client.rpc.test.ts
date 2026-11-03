import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Network } from "@x402/core/types";
import type * as viem from "viem";
import {
  assertClientEvmCapabilities,
  EvmRpcNotConfiguredError,
  toClientEvmSigner,
  type ClientEvmSigner,
  type EvmRpcClient,
} from "../../../src/signer";

const { mockCreatePublicClient, mockHttp } = vi.hoisted(() => ({
  mockHttp: vi.fn((url: string) => ({ url })),
  mockCreatePublicClient: vi.fn(({ transport }: { transport: { url: string } }) => ({
    readContract: vi.fn().mockResolvedValue(`read via ${transport.url}`),
    getTransactionCount: vi.fn().mockResolvedValue(7),
    estimateFeesPerGas: vi.fn().mockResolvedValue({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
  })),
}));

vi.mock("viem", async importOriginal => ({
  ...(await importOriginal<typeof viem>()),
  createPublicClient: mockCreatePublicClient,
  http: mockHttp,
}));

const ADDRESS = "0x1234567890123456789012345678901234567890" as const;
const READ_ARGS = { address: ADDRESS, abi: [], functionName: "allowance", args: [] };
const BASE: Network = "eip155:8453";
const BASE_SEPOLIA: Network = "eip155:84532";

const account: ClientEvmSigner = {
  address: ADDRESS,
  signTypedData: vi.fn().mockResolvedValue("0xsig"),
};

const reads = [
  ["readContract", (s: ClientEvmSigner, n: Network) => s.readContract?.(READ_ARGS, n)],
  [
    "getTransactionCount",
    (s: ClientEvmSigner, n: Network) => s.getTransactionCount?.({ address: ADDRESS }, n),
  ],
  ["estimateFeesPerGas", (s: ClientEvmSigner, n: Network) => s.estimateFeesPerGas?.(undefined, n)],
] as const;

/**
 * Builds an offline public client, optionally bound to a chain id.
 *
 * @param chainId - Chain id the client is bound to, or undefined for none
 * @returns The fake public client
 */
function publicClient(chainId: number | undefined) {
  return {
    chain: chainId === undefined ? undefined : { id: chainId },
    readContract: vi.fn().mockResolvedValue(42n),
    getTransactionCount: vi.fn().mockResolvedValue(3),
    estimateFeesPerGas: vi.fn().mockResolvedValue({ maxFeePerGas: 9n, maxPriorityFeePerGas: 1n }),
  } satisfies EvmRpcClient;
}

describe("toClientEvmSigner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes no onchain reads without an rpc, and forwards signTransaction", async () => {
    const signTransaction = vi.fn().mockResolvedValue("0xsignedtx");
    const signer = toClientEvmSigner({ ...account, signTransaction });

    expect(signer.readContract).toBeUndefined();
    expect(signer.getTransactionCount).toBeUndefined();
    expect(signer.estimateFeesPerGas).toBeUndefined();
    const tx = {
      to: ADDRESS,
      data: "0x",
      nonce: 0,
      gas: 1n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      chainId: 8453,
    } as const;
    expect(await signer.signTransaction?.(tx)).toBe("0xsignedtx");
    expect(signTransaction).toHaveBeenCalledWith(tx);
  });

  it("prefers the signer's own reads over the rpc and forwards the network to them", async () => {
    const own = {
      readContract: vi.fn().mockResolvedValue(1n),
      getTransactionCount: vi.fn().mockResolvedValue(5),
      estimateFeesPerGas: vi.fn().mockResolvedValue({ maxFeePerGas: 4n, maxPriorityFeePerGas: 2n }),
    };
    const client = publicClient(undefined);
    const signer = toClientEvmSigner({ ...account, ...own }, client);

    expect(await signer.readContract?.(READ_ARGS, BASE)).toBe(1n);
    expect(await signer.getTransactionCount?.({ address: ADDRESS }, BASE)).toBe(5);
    expect(await signer.estimateFeesPerGas?.(undefined, BASE)).toEqual({
      maxFeePerGas: 4n,
      maxPriorityFeePerGas: 2n,
    });
    expect(own.readContract).toHaveBeenCalledWith(READ_ARGS, BASE);
    expect(own.getTransactionCount).toHaveBeenCalledWith({ address: ADDRESS }, BASE);
    expect(own.estimateFeesPerGas).toHaveBeenCalledWith(undefined, BASE);
    expect(client.readContract).not.toHaveBeenCalled();
    expect(client.getTransactionCount).not.toHaveBeenCalled();
    expect(client.estimateFeesPerGas).not.toHaveBeenCalled();
  });

  describe("with a public client", () => {
    it("reads through a client bound to the requested chain", async () => {
      const client = publicClient(84532);
      const signer = toClientEvmSigner(account, client);

      expect(await signer.readContract?.(READ_ARGS, BASE_SEPOLIA)).toBe(42n);
      expect(await signer.getTransactionCount?.({ address: ADDRESS }, BASE_SEPOLIA)).toBe(3);
      expect(await signer.estimateFeesPerGas?.(undefined, BASE_SEPOLIA)).toEqual({
        maxFeePerGas: 9n,
        maxPriorityFeePerGas: 1n,
      });
      expect(client.readContract).toHaveBeenCalledWith(READ_ARGS);
      expect(client.getTransactionCount).toHaveBeenCalledWith({ address: ADDRESS });
    });

    it.each(reads)("rejects %s on another chain without reading", async (_, read) => {
      const client = publicClient(84532);
      const signer = toClientEvmSigner(account, client);

      const attempt = read(signer, BASE);
      await expect(attempt).rejects.toBeInstanceOf(EvmRpcNotConfiguredError);
      await expect(attempt).rejects.toThrow(
        "No EVM RPC is configured for eip155:8453 (the public client is bound to chain 84532). " +
          "Configure one with toClientEvmSigner(account, rpc).",
      );
      expect(client.readContract).not.toHaveBeenCalled();
      expect(client.getTransactionCount).not.toHaveBeenCalled();
      expect(client.estimateFeesPerGas).not.toHaveBeenCalled();
    });

    it("reads any network through a client without a chain, which cannot be checked", async () => {
      const client = publicClient(undefined);
      const signer = toClientEvmSigner(account, client);

      expect(await signer.readContract?.(READ_ARGS, BASE)).toBe(42n);
      expect(await signer.readContract?.(READ_ARGS, BASE_SEPOLIA)).toBe(42n);
    });
  });

  describe("with { rpcUrl }", () => {
    it("backfills every read for every network from one public client cached per URL", async () => {
      const first = toClientEvmSigner(account, { rpcUrl: "https://shared.example" });
      const second = toClientEvmSigner(account, { rpcUrl: "https://shared.example" });
      const other = toClientEvmSigner(account, { rpcUrl: "https://other.example" });

      expect(await first.readContract?.(READ_ARGS, BASE)).toBe("read via https://shared.example");
      expect(await second.readContract?.(READ_ARGS, BASE_SEPOLIA)).toBe(
        "read via https://shared.example",
      );
      expect(await first.getTransactionCount?.({ address: ADDRESS }, BASE)).toBe(7);
      expect(await first.estimateFeesPerGas?.(undefined, BASE)).toEqual({
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
      });
      expect(mockCreatePublicClient).toHaveBeenCalledTimes(1);

      expect(await other.readContract?.(READ_ARGS, BASE)).toBe("read via https://other.example");
      expect(mockCreatePublicClient).toHaveBeenCalledTimes(2);
      expect(mockHttp.mock.calls).toEqual([["https://shared.example"], ["https://other.example"]]);
    });
  });

  describe("with a chain-id map", () => {
    const rpc = {
      8453: { rpcUrl: "https://base.example" },
      84532: { rpcUrl: "https://base-sepolia.example" },
    };

    it("routes each read to the endpoint for its network's chain id", async () => {
      const signer = toClientEvmSigner(account, rpc);

      expect(await signer.readContract?.(READ_ARGS, BASE)).toBe("read via https://base.example");
      expect(await signer.readContract?.(READ_ARGS, BASE_SEPOLIA)).toBe(
        "read via https://base-sepolia.example",
      );
    });

    it.each(reads)(
      "throws EvmRpcNotConfiguredError naming an unlisted network on %s without creating a client",
      async (_, read) => {
        const signer = toClientEvmSigner(account, rpc);

        const attempt = read(signer, "eip155:137");
        await expect(attempt).rejects.toMatchObject({
          name: "EvmRpcNotConfiguredError",
          network: "eip155:137",
          message:
            "No EVM RPC is configured for eip155:137. Configure one with toClientEvmSigner(account, rpc).",
        });
        await expect(attempt).rejects.toBeInstanceOf(EvmRpcNotConfiguredError);
        expect(mockCreatePublicClient).not.toHaveBeenCalled();
      },
    );
  });
});

describe("assertClientEvmCapabilities", () => {
  it("accepts a signer exposing every listed capability", () => {
    const signer: ClientEvmSigner = {
      ...account,
      readContract: vi.fn(),
      getTransactionCount: vi.fn(),
    };

    expect(() =>
      assertClientEvmCapabilities(signer, ["readContract", "getTransactionCount"], "component"),
    ).not.toThrow();
  });

  it("names the first missing capability and the component", () => {
    const signer: ClientEvmSigner = { ...account, signTransaction: vi.fn() };

    expect(() =>
      assertClientEvmCapabilities(
        signer,
        ["signTransaction", "getTransactionCount", "readContract"],
        "ERC-20 approval",
      ),
    ).toThrow(new Error("ERC-20 approval requires getTransactionCount on the signer."));
  });
});
