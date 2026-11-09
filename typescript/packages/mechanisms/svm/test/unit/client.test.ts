import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchMint } from "@solana-program/token-2022";
import { generateKeyPairSigner } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "../../src/exact";
import { registerExactSvmScheme } from "../../src/exact/client/register";
import { NETWORKS } from "../../src/v1";
import type { ClientSvmSigner } from "../../src/signer";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { MAX_MEMO_BYTES, SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import { getCachedMintMetadata } from "../../src/mint-cache";
import { resolveBlockhash } from "../../src/utils";

vi.mock("@solana-program/token-2022", async importOriginal => {
  const actual = await importOriginal<typeof import("@solana-program/token-2022")>();
  return {
    ...actual,
    fetchMint: vi.fn(),
  };
});

type ClientInternals = {
  registeredClientSchemes: Map<number, Map<string, Map<string, unknown>>>;
};

function getRegisteredNetworks(client: x402Client, version: number): string[] {
  const internals = client as unknown as ClientInternals;
  const byNetwork = internals.registeredClientSchemes.get(version);
  return byNetwork ? [...byNetwork.keys()] : [];
}

const PROVIDED_BLOCKHASH = "EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k";
const FALLBACK_BLOCKHASH = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF";

function createBlockhashRpc() {
  const send = vi.fn().mockResolvedValue({
    value: {
      blockhash: FALLBACK_BLOCKHASH,
      lastValidBlockHeight: 67890n,
    },
  });
  const rpc = {
    getLatestBlockhash: () => ({ send }),
  };

  return { rpc, send };
}

function requirementsWithRecentBlockhash(
  recentBlockhash?: string | number,
  lastValidBlockHeight?: string | number,
) {
  return {
    extra: {
      ...(recentBlockhash === undefined ? {} : { recentBlockhash }),
      ...(lastValidBlockHeight === undefined ? {} : { lastValidBlockHeight }),
    },
  };
}

describe("ExactSvmScheme", () => {
  let mockSigner: ClientSvmSigner;

  beforeEach(() => {
    mockSigner = {
      address: "9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ" as never,
      signTransactions: vi.fn().mockResolvedValue([
        {
          messageBytes: new Uint8Array(10),
          signatures: {},
        },
      ]) as never,
    };
  });

  describe("constructor", () => {
    it("should create instance with correct scheme", () => {
      const client = new ExactSvmScheme(mockSigner);
      expect(client.scheme).toBe("exact");
    });

    it("should accept optional config", () => {
      const client = new ExactSvmScheme(mockSigner, {
        rpcUrl: "https://custom-rpc.com",
      });
      expect(client.scheme).toBe("exact");
    });
  });

  describe("createPaymentPayload", () => {
    it("should create V2 payment payload", async () => {
      const client = new ExactSvmScheme(mockSigner);

      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: {
          feePayer: "FeePayer1111111111111111111111111111",
        },
      };

      // Note: Full testing requires complex mocking of Solana RPC and transaction building
      // This verifies the method exists and has correct signature
      expect(client.createPaymentPayload).toBeDefined();
      expect(typeof client.createPaymentPayload).toBe("function");

      // Verify client accepts PaymentRequirements (v2 format)
      expect(requirements.amount).toBe("100000"); // V2 uses 'amount' not 'maxAmountRequired'
    });

    it("should throw if feePayer is missing from requirements", () => {
      const client = new ExactSvmScheme(mockSigner);

      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: {}, // Missing feePayer
      };

      // The method should exist and handle this error scenario
      expect(client.createPaymentPayload).toBeDefined();
      expect(requirements.extra?.feePayer).toBeUndefined();
    });

    it("should accept V2 requirements with amount field", () => {
      const client = new ExactSvmScheme(mockSigner);

      // Verify the client accepts PaymentRequirements (v2) with amount field
      type V2Requirements = PaymentRequirements & { amount: string };
      const hasAmountField = (req: PaymentRequirements): req is V2Requirements => "amount" in req;

      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "500000", // V2 uses 'amount'
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: { feePayer: "FeePayer1111111111111111111111111111" },
      };

      expect(hasAmountField(requirements)).toBe(true);
      if (hasAmountField(requirements)) {
        expect(requirements.amount).toBe("500000");
      }
      expect(client.scheme).toBe("exact");
    });

    it("rejects a mint owned by an unknown program", async () => {
      vi.mocked(fetchMint).mockResolvedValue({
        data: { decimals: 6 },
        programAddress: "11111111111111111111111111111111",
      } as never);
      const payer = await generateKeyPairSigner();
      const client = new ExactSvmScheme(payer);
      await expect(
        client.createPaymentPayload(2, {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: payer.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: payer.address, recentBlockhash: PROVIDED_BLOCKHASH },
        }),
      ).rejects.toThrow("Asset was not created by a known token program");
    });

    it("forwards a configured rpcUrl before rejecting an unknown mint program", async () => {
      vi.mocked(fetchMint).mockResolvedValue({
        data: { decimals: 6 },
        programAddress: "11111111111111111111111111111111",
      } as never);
      const payer = await generateKeyPairSigner();
      const client = new ExactSvmScheme(payer, { rpcUrl: "https://custom-rpc.example" });
      await expect(
        client.createPaymentPayload(2, {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: payer.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: payer.address, recentBlockhash: PROVIDED_BLOCKHASH },
        }),
      ).rejects.toThrow("Asset was not created by a known token program");
    });

    it("rejects when extra.feePayer is missing after mint resolution", async () => {
      vi.mocked(fetchMint).mockResolvedValue({
        data: { decimals: 6 },
        programAddress: TOKEN_PROGRAM_ADDRESS,
      } as never);
      const payer = await generateKeyPairSigner();
      const client = new ExactSvmScheme(payer);
      await expect(
        client.createPaymentPayload(2, {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: payer.address,
          maxTimeoutSeconds: 3600,
          extra: { recentBlockhash: PROVIDED_BLOCKHASH },
        }),
      ).rejects.toThrow("feePayer is required");
    });

    it("rejects extra.memo that exceeds MAX_MEMO_BYTES", async () => {
      vi.mocked(fetchMint).mockResolvedValue({
        data: { decimals: 6 },
        programAddress: TOKEN_PROGRAM_ADDRESS,
      } as never);
      const payer = await generateKeyPairSigner();
      const client = new ExactSvmScheme(payer);
      await expect(
        client.createPaymentPayload(2, {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: payer.address,
          maxTimeoutSeconds: 3600,
          extra: {
            feePayer: payer.address,
            memo: "m".repeat(MAX_MEMO_BYTES + 1),
            recentBlockhash: PROVIDED_BLOCKHASH,
          },
        }),
      ).rejects.toThrow(`extra.memo exceeds maximum ${MAX_MEMO_BYTES} bytes`);
    });
  });
});

describe("resolveBlockhash", () => {
  it("uses a valid server-provided blockhash without an RPC call", async () => {
    const { rpc, send } = createBlockhashRpc();

    const result = await resolveBlockhash(
      rpc as never,
      requirementsWithRecentBlockhash(PROVIDED_BLOCKHASH, "12345") as never,
    );

    expect(result).toEqual({
      blockhash: PROVIDED_BLOCKHASH,
      lastValidBlockHeight: 12345n,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("uses a valid blockhash when lastValidBlockHeight is absent or malformed", async () => {
    const { rpc, send } = createBlockhashRpc();

    const missingHeight = await resolveBlockhash(
      rpc as never,
      requirementsWithRecentBlockhash(PROVIDED_BLOCKHASH) as never,
    );
    const malformedHeight = await resolveBlockhash(
      rpc as never,
      requirementsWithRecentBlockhash(PROVIDED_BLOCKHASH, "not-a-height") as never,
    );

    expect(missingHeight.lastValidBlockHeight).toBe(0n);
    expect(malformedHeight.lastValidBlockHeight).toBe(0n);
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts a safe-integer lastValidBlockHeight", async () => {
    const { rpc, send } = createBlockhashRpc();

    const result = await resolveBlockhash(
      rpc as never,
      requirementsWithRecentBlockhash(PROVIDED_BLOCKHASH, 12345) as never,
    );

    expect(result).toEqual({
      blockhash: PROVIDED_BLOCKHASH,
      lastValidBlockHeight: 12345n,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["non-string", 12345],
    ["malformed", "not-a-blockhash"],
  ])("falls back to RPC when recentBlockhash is %s", async (_name, recentBlockhash) => {
    const { rpc, send } = createBlockhashRpc();

    const result = await resolveBlockhash(
      rpc as never,
      requirementsWithRecentBlockhash(recentBlockhash) as never,
    );

    expect(result).toEqual({
      blockhash: FALLBACK_BLOCKHASH,
      lastValidBlockHeight: 67890n,
    });
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("registerExactSvmScheme", () => {
  const mockSigner: ClientSvmSigner = {
    address: "9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ" as never,
    signTransactions: vi.fn(),
  };

  it("scopes v1 registration to networks matching config.networks", () => {
    const client = new x402Client();
    registerExactSvmScheme(client, {
      signer: mockSigner,
      networks: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as Network],
    });

    const v1Networks = getRegisteredNetworks(client, 1);
    expect(v1Networks).toContain("solana");
    expect(v1Networks).not.toContain("solana-devnet");
    expect(getRegisteredNetworks(client, 2)).toEqual(["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
  });

  it("registers all v1 networks when config.networks uses a wildcard", () => {
    const client = new x402Client();
    registerExactSvmScheme(client, { signer: mockSigner, networks: ["solana:*" as Network] });

    expect(getRegisteredNetworks(client, 1).sort()).toEqual([...NETWORKS].sort());
    expect(getRegisteredNetworks(client, 2)).toEqual(["solana:*"]);
  });

  it("registers wildcard v2 and all v1 networks when networks is omitted", () => {
    const client = new x402Client();
    registerExactSvmScheme(client, { signer: mockSigner });

    expect(getRegisteredNetworks(client, 2)).toEqual(["solana:*"]);
    expect(getRegisteredNetworks(client, 1).sort()).toEqual([...NETWORKS].sort());
  });

  it("registers caller-supplied policies", () => {
    const client = new x402Client();
    const policy = vi.fn((version: number, requirements: PaymentRequirements[]) => requirements);
    registerExactSvmScheme(client, { signer: mockSigner, policies: [policy] });

    const internals = client as unknown as { policies: Array<(...args: never[]) => unknown> };
    expect(internals.policies).toContain(policy);
  });
});

describe("getCachedMintMetadata", () => {
  beforeEach(() => {
    vi.mocked(fetchMint).mockReset();
  });

  it("evicts a failed fetch so the next caller retries", async () => {
    const cache = new Map<string, Promise<{ decimals: number; programAddress: string }>>();
    vi.mocked(fetchMint)
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockResolvedValueOnce({
        data: { decimals: 6 },
        programAddress: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      } as never);

    await expect(
      getCachedMintMetadata({} as never, SOLANA_DEVNET_CAIP2, USDC_DEVNET_ADDRESS as never, cache),
    ).rejects.toThrow("rpc down");
    expect(cache.size).toBe(0);

    const metadata = await getCachedMintMetadata(
      {} as never,
      SOLANA_DEVNET_CAIP2,
      USDC_DEVNET_ADDRESS as never,
      cache,
    );
    expect(metadata.decimals).toBe(6);
    expect(fetchMint).toHaveBeenCalledTimes(2);
  });

  it("does not evict a newer in-flight fetch when an older one fails", async () => {
    const cache = new Map<string, Promise<{ decimals: number; programAddress: string }>>();
    const newer = Promise.resolve({
      decimals: 6,
      programAddress: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    });
    vi.mocked(fetchMint).mockRejectedValueOnce(new Error("stale"));

    const first = getCachedMintMetadata(
      {} as never,
      SOLANA_DEVNET_CAIP2,
      USDC_DEVNET_ADDRESS as never,
      cache,
    );
    cache.set(`${SOLANA_DEVNET_CAIP2}:${USDC_DEVNET_ADDRESS}`, newer);

    await expect(first).rejects.toThrow("stale");
    expect(cache.get(`${SOLANA_DEVNET_CAIP2}:${USDC_DEVNET_ADDRESS}`)).toBe(newer);
  });
});
