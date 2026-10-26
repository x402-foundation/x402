import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSolanaRpc,
  createSolanaRpcFromTransport,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isJsonRpcPayload,
  type RpcTransport,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme, type ExactSvmClientConfig } from "../../src/exact/client";
import {
  DEVNET_RPC_URL,
  MAINNET_RPC_URL,
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  SOLANA_TESTNET_CAIP2,
  TESTNET_RPC_URL,
} from "../../src/constants";

vi.mock("@solana/kit", async importOriginal => {
  const actual = await importOriginal<typeof import("@solana/kit")>();
  return { ...actual, createSolanaRpc: vi.fn() };
});

const BLOCKHASH = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const CUSTOM_URL = "https://custom-rpc.example.invalid";

function createOfflineRpc() {
  // An initialized SPL mint with six decimals; the remaining optional fields are absent.
  const mintBytes = Buffer.alloc(82);
  mintBytes[44] = 6;
  mintBytes[45] = 1;
  const methods: string[] = [];
  const failures = new Map<string, Error>();
  const transport: RpcTransport = async <TResponse>({ payload }: Parameters<RpcTransport>[0]) => {
    if (!isJsonRpcPayload(payload)) throw new Error("Expected JSON-RPC request");
    methods.push(payload.method);
    const failure = failures.get(payload.method);
    if (failure) throw failure;
    const value =
      payload.method === "getAccountInfo"
        ? {
            data: [mintBytes.toString("base64"), "base64"],
            executable: false,
            lamports: 1461600,
            owner: TOKEN_PROGRAM_ADDRESS,
            rentEpoch: 0,
            space: 82,
          }
        : { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 };
    if (!["getAccountInfo", "getLatestBlockhash"].includes(payload.method)) {
      throw new Error(`Unexpected RPC method: ${payload.method}`);
    }
    return { jsonrpc: "2.0", id: "test", result: { context: { slot: 100 }, value } } as TResponse;
  };
  return { rpc: createSolanaRpcFromTransport(transport), methods, failures };
}

describe("ExactSvmScheme RPC injection", () => {
  let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let requirements: PaymentRequirements;

  beforeEach(async () => {
    vi.mocked(createSolanaRpc).mockReset();
    // An unexpected default construction fails locally instead of accessing the network.
    vi.mocked(createSolanaRpc).mockImplementation(() => {
      throw new Error("Unexpected default RPC construction");
    });
    payer = await generateKeyPairSigner();
    const feePayer = await generateKeyPairSigner();
    const recipient = await generateKeyPairSigner();
    const mint = await generateKeyPairSigner();
    requirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: mint.address,
      amount: "100000",
      payTo: recipient.address,
      maxTimeoutSeconds: 60,
      extra: { feePayer: feePayer.address },
    };
  });

  afterEach(() => vi.restoreAllMocks());

  async function assertSignedPayment(scheme: ExactSvmScheme) {
    const result = await scheme.createPaymentPayload(2, requirements);
    expect(result.x402Version).toBe(2);
    const wire = result.payload.transaction;
    if (typeof wire !== "string") throw new Error("Expected encoded transaction");
    const tx = getTransactionDecoder().decode(Buffer.from(wire, "base64"));
    const signature = tx.signatures[payer.address];
    if (!signature) throw new Error("Missing payer signature");
    expect(
      await crypto.subtle.verify(
        "Ed25519",
        payer.keyPair.publicKey,
        new Uint8Array(signature),
        new Uint8Array(tx.messageBytes),
      ),
    ).toBe(true);
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    expect(message.staticAccounts[0]).toBe(requirements.extra?.feePayer);
    expect(message.lifetimeToken).toBe(BLOCKHASH);
    expect(message.instructions).toHaveLength(4);
    // TransferChecked: discriminator, little-endian amount, decimals.
    expect(Array.from(message.instructions[2].data!)).toEqual([12, 160, 134, 1, 0, 0, 0, 0, 0, 6]);
  }

  it.each([SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2, SOLANA_TESTNET_CAIP2] as const)(
    "uses an unbranded Kit transport client ahead of rpcUrl on %s",
    async network => {
      requirements.network = network;
      const { rpc, methods } = createOfflineRpc();
      const config: ExactSvmClientConfig = { rpc, rpcUrl: CUSTOM_URL };
      const scheme = new ExactSvmScheme(payer, config);
      await assertSignedPayment(scheme);
      await assertSignedPayment(scheme);
      expect(methods).toEqual(["getAccountInfo", "getLatestBlockhash", "getLatestBlockhash"]);
      expect(createSolanaRpc).not.toHaveBeenCalled();
    },
  );

  it.each([
    [SOLANA_MAINNET_CAIP2, MAINNET_RPC_URL],
    [SOLANA_DEVNET_CAIP2, DEVNET_RPC_URL],
    [SOLANA_TESTNET_CAIP2, TESTNET_RPC_URL],
  ] as const)("preserves the default RPC for %s", async (network, url) => {
    const { rpc, methods } = createOfflineRpc();
    vi.mocked(createSolanaRpc).mockReturnValue(rpc);
    requirements.network = network;
    await assertSignedPayment(new ExactSvmScheme(payer));
    expect(createSolanaRpc).toHaveBeenCalledExactlyOnceWith(url);
    expect(methods).toEqual(["getAccountInfo", "getLatestBlockhash"]);
  });

  it("preserves the custom URL when no RPC is injected", async () => {
    const { rpc } = createOfflineRpc();
    vi.mocked(createSolanaRpc).mockReturnValue(rpc);
    await assertSignedPayment(new ExactSvmScheme(payer, { rpcUrl: CUSTOM_URL }));
    expect(createSolanaRpc).toHaveBeenCalledExactlyOnceWith(CUSTOM_URL);
  });

  it("uses a server-supplied blockhash without fetching it from the injected RPC", async () => {
    const { rpc, methods } = createOfflineRpc();
    requirements.extra = {
      ...requirements.extra,
      recentBlockhash: BLOCKHASH,
      lastValidBlockHeight: "1000",
    };
    await assertSignedPayment(new ExactSvmScheme(payer, { rpc }));
    expect(methods).toEqual(["getAccountInfo"]);
    expect(createSolanaRpc).not.toHaveBeenCalled();
  });

  it.each(["getAccountInfo", "getLatestBlockhash"])(
    "propagates %s failure without fallback and permits retry",
    async method => {
      const { rpc, methods, failures } = createOfflineRpc();
      const failure = new Error("Custom transport unavailable");
      failures.set(method, failure);
      const scheme = new ExactSvmScheme(payer, { rpc, rpcUrl: CUSTOM_URL });
      await expect(scheme.createPaymentPayload(2, requirements)).rejects.toBe(failure);
      failures.clear();
      await assertSignedPayment(scheme);
      expect(methods.filter(name => name === "getAccountInfo")).toHaveLength(
        method === "getAccountInfo" ? 2 : 1,
      );
      expect(createSolanaRpc).not.toHaveBeenCalled();
    },
  );

  describe.each(["solana:unsupported", "eip155:1", "constructor"])(
    "unsupported network %s",
    network => {
      it.each([true, false])("rejects before RPC work (injected=%s)", async injected => {
        const { rpc, methods } = createOfflineRpc();
        requirements.network = network as Network;
        const scheme = new ExactSvmScheme(payer, injected ? { rpc } : undefined);
        await expect(scheme.createPaymentPayload(2, requirements)).rejects.toThrow(
          /Unsupported (?:SVM )?network:/,
        );
        expect(methods).toEqual([]);
        expect(createSolanaRpc).not.toHaveBeenCalled();
      });
    },
  );

  it("preserves supported network aliases with an injected RPC", async () => {
    const { rpc } = createOfflineRpc();
    requirements.network = "solana-devnet" as Network;
    await assertSignedPayment(new ExactSvmScheme(payer, { rpc }));
    expect(createSolanaRpc).not.toHaveBeenCalled();
  });
});
