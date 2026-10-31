import type { ClientWithCoreApi } from "@mysten/sui/client";
import type { Signer } from "@mysten/sui/cryptography";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { verifyTransactionSignature } from "@mysten/sui/verify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExactSuiScheme } from "../../src/exact/client/scheme";
import { SUI_TESTNET_CAIP2 } from "../../src/constants";
import { pureInputsBase64, transactionCarriesNonce } from "../../src/utils";
import type { ExactSuiPayload } from "../../src/types";
import {
  CHAIN_ID,
  EPOCH,
  feePayer,
  fromBase64,
  payer,
  payerKeypair,
  testRequirements,
} from "./helpers";

const NONCE = "q6urq6urq6s="; // 8 bytes of 0xab

// The SDK's generic resolver (used by JSON-RPC), run against a mocked core API.
const resolveTransactionPlugin = new SuiJsonRpcClient({
  url: "http://127.0.0.1:1",
  network: "testnet",
}).core.resolveTransactionPlugin();

/**
 * A core API stub that drives the SDK's real transaction resolver.
 *
 * @param suiBalances - SUI address balance per owner, backed by one gas coin
 *   (default: a large address balance and no coins)
 * @returns The client and its core mocks
 */
function resolvingClient(suiBalances: Record<string, string> = {}) {
  const suiOverride = (owner: string, coinType?: string) =>
    coinType === undefined || normalizeStructTag(coinType) === normalizeStructTag("0x2::sui::SUI")
      ? suiBalances[normalizeSuiAddress(owner)]
      : undefined;
  const core = {
    resolveTransactionPlugin: () => resolveTransactionPlugin,
    getCurrentSystemState: vi
      .fn()
      .mockResolvedValue({ systemState: { epoch: String(EPOCH), referenceGasPrice: "1000" } }),
    getChainIdentifier: vi.fn().mockResolvedValue({ chainIdentifier: CHAIN_ID }),
    getBalance: vi
      .fn()
      .mockImplementation(({ owner, coinType }: { owner: string; coinType?: string }) => {
        const balance = suiOverride(owner, coinType) ?? "999999999999";
        return Promise.resolve({ balance: { balance, addressBalance: balance, coinBalance: "0" } });
      }),
    listCoins: vi
      .fn()
      .mockImplementation(({ owner, coinType }: { owner: string; coinType?: string }) =>
        Promise.resolve({
          objects:
            suiOverride(owner, coinType) === undefined
              ? []
              : [
                  {
                    objectId: `0x${"66".repeat(32)}`,
                    version: "3",
                    digest: CHAIN_ID,
                    balance: "999999999999",
                  },
                ],
          hasNextPage: false,
          cursor: null,
        }),
      ),
    simulateTransaction: vi.fn().mockResolvedValue({
      $kind: "Transaction",
      Transaction: {
        effects: {
          gasUsed: { computationCost: "1000000", storageCost: "0", storageRebate: "0" },
        },
      },
    }),
  };
  return { client: { core } as unknown as ClientWithCoreApi, core };
}

/**
 * Decode a payload's transaction.
 *
 * @param payload - The payment payload
 * @returns The transaction data
 */
function decode(payload: unknown) {
  return Transaction.from((payload as ExactSuiPayload).transaction).getData();
}

describe("ExactSuiScheme client", () => {
  let mock: ReturnType<typeof resolvingClient>;
  let scheme: ExactSuiScheme;

  beforeEach(() => {
    mock = resolvingClient();
    scheme = new ExactSuiScheme(payerKeypair, { clients: { [SUI_TESTNET_CAIP2]: mock.client } });
  });

  it("builds a self-paid send_funds with a ValidDuring expiration", async () => {
    const result = await scheme.createPaymentPayload(2, testRequirements());
    const payload = result.payload as ExactSuiPayload;
    const data = decode(payload);

    expect(data.sender).toBe(payer);
    expect(data.expiration).toMatchObject({
      $kind: "ValidDuring",
      ValidDuring: {
        minEpoch: String(EPOCH),
        maxEpoch: String(EPOCH + 1),
        minTimestamp: null,
        maxTimestamp: null,
        chain: CHAIN_ID,
      },
    });
    expect(data.gasData.owner ?? data.sender).toBe(payer);
    expect(data.gasData.payment).toEqual([]);
    expect(data.gasData.budget).toBe("2000000");
    expect(data.commands.at(-1)?.MoveCall).toMatchObject({
      module: "balance",
      function: "send_funds",
    });
    expect(transactionCarriesNonce(data, NONCE)).toBe(false);
    await expect(
      verifyTransactionSignature(fromBase64(payload.transaction), payload.signature as string, {
        address: payer,
      }),
    ).resolves.toBeDefined();
  });

  it("fetches the epoch and chain id in parallel and caches the chain id", async () => {
    await scheme.createPaymentPayload(2, testRequirements());
    await scheme.createPaymentPayload(2, testRequirements());
    expect(mock.core.getCurrentSystemState).toHaveBeenCalled();
    expect(mock.core.getChainIdentifier).toHaveBeenCalledOnce();
  });

  it("keeps the expiration when gas falls back to coin objects", async () => {
    const poor = resolvingClient({ [payer]: "0" });
    const s = new ExactSuiScheme(payerKeypair, { clients: { [SUI_TESTNET_CAIP2]: poor.client } });
    const data = decode((await s.createPaymentPayload(2, testRequirements())).payload);
    expect(data.gasData.payment).toHaveLength(1);
    expect(data.expiration?.$kind).toBe("ValidDuring");
  });

  it("sets the announced sponsor as gas owner with an empty gas payment", async () => {
    const result = await scheme.createPaymentPayload(
      2,
      testRequirements({ extra: { feePayer, maxGasBudget: "10000000" } }),
    );
    const data = decode(result.payload);
    expect(normalizeSuiAddress(data.gasData.owner!)).toBe(normalizeSuiAddress(feePayer));
    expect(data.gasData.payment).toEqual([]);
    expect(data.expiration?.$kind).toBe("ValidDuring");
    expect(JSON.stringify(data.commands)).not.toContain("GasCoin");
    // The sponsor's balances are never consulted for gas selection.
    expect(mock.core.listCoins).not.toHaveBeenCalledWith(
      expect.objectContaining({ owner: feePayer }),
    );
  });

  it("does not use the gas coin for a sponsored SUI payment", async () => {
    const result = await scheme.createPaymentPayload(
      2,
      testRequirements({ asset: "0x2::sui::SUI", extra: { feePayer } }),
    );
    expect(JSON.stringify(decode(result.payload).commands)).not.toContain("GasCoin");
  });

  it("refuses a sponsored budget above the advertised cap", async () => {
    await expect(
      scheme.createPaymentPayload(
        2,
        testRequirements({ extra: { feePayer, maxGasBudget: "1000" } }),
      ),
    ).rejects.toThrow("exceeds the sponsor's maxGasBudget");
  });

  it("checks the gas cap on the bytes the signer returns", async () => {
    const withBudget = (budget: number) =>
      ({
        toSuiAddress: () => payer,
        signTransaction: async (bytes: Uint8Array) => {
          const tx = Transaction.from(bytes);
          tx.setGasBudget(budget);
          return payerKeypair.signTransaction(await tx.build());
        },
      }) as unknown as Signer;
    const requirements = testRequirements({ extra: { feePayer, maxGasBudget: "1500000" } });

    // The local build budgets 2,000,000; the signer lowers it under the cap.
    const lowered = new ExactSuiScheme(withBudget(1_000_000), {
      clients: { [SUI_TESTNET_CAIP2]: mock.client },
    });
    const payload = (await lowered.createPaymentPayload(2, requirements)).payload;
    expect(decode(payload).gasData.budget).toBe("1000000");

    const raised = new ExactSuiScheme(withBudget(1_600_000), {
      clients: { [SUI_TESTNET_CAIP2]: mock.client },
    });
    await expect(raised.createPaymentPayload(2, requirements)).rejects.toThrow(
      "exceeds the sponsor's maxGasBudget",
    );
  });

  it("uses the bytes the signer returns", async () => {
    const rebuilding = {
      toSuiAddress: () => payer,
      signTransaction: async (bytes: Uint8Array) => {
        const tx = Transaction.from(bytes);
        tx.setGasBudget(1_234_567);
        return payerKeypair.signTransaction(await tx.build());
      },
    } as unknown as Signer;
    const s = new ExactSuiScheme(rebuilding, { clients: { [SUI_TESTNET_CAIP2]: mock.client } });
    const payload = (await s.createPaymentPayload(2, testRequirements()))
      .payload as ExactSuiPayload;
    expect(decode(payload).gasData.budget).toBe("1234567");
    await expect(
      verifyTransactionSignature(fromBase64(payload.transaction), payload.signature as string, {
        address: payer,
      }),
    ).resolves.toBeDefined();
  });

  it("embeds a declared nonce as raw Pure bytes", async () => {
    const result = await scheme.createPaymentPayload(
      2,
      testRequirements({ extra: { nonce: NONCE } }),
    );
    const data = decode(result.payload);
    expect(pureInputsBase64(data)).toContain(NONCE);
    expect(transactionCarriesNonce(data, NONCE)).toBe(true);
  });

  it("validates requirements", async () => {
    await expect(scheme.createPaymentPayload(2, testRequirements({ asset: "" }))).rejects.toThrow(
      "Asset is required",
    );
    await expect(
      scheme.createPaymentPayload(2, testRequirements({ payTo: "0x123" })),
    ).rejects.toThrow("Invalid pay-to address");
    await expect(scheme.createPaymentPayload(2, testRequirements({ amount: "0" }))).rejects.toThrow(
      "positive atomic-unit integer",
    );
    expect(mock.core.getCurrentSystemState).not.toHaveBeenCalled();
  });
});
