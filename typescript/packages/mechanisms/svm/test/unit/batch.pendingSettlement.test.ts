import {
  generateKeyPairSigner,
  address,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getBase64Codec,
} from "@solana/kit";
import { InMemoryPendingSettlementStore } from "@x402/core/facilitator";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { BatchSvmScheme as BatchFacilitatorScheme } from "../../src/batch-settlement/facilitator/scheme";
import { broadcastOpen } from "../../src/payment-channels/facilitator";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import { SOLANA_DEVNET_CAIP2, MEMO_PROGRAM_ADDRESS } from "../../src/constants";
import { toFacilitatorSvmSigner } from "../../src/signer";

const NETWORK = SOLANA_DEVNET_CAIP2;
const KEY = "batch:claim:test";

/** Reaches the private broadcast path the settle handlers share. */
type Durable = {
  broadcastDurably(
    key: string,
    network: string,
    payer: string,
    broadcast: (onBroadcast: (signature: string) => Promise<void>) => Promise<string>,
  ): Promise<{ ok: true; replayed: boolean; signature: string } | { ok: false; response: unknown }>;
  completeBroadcast(key: string, signature: string): Promise<void>;
};

describe("batch-settlement pending settlement", () => {
  let payer: string;

  beforeAll(async () => {
    payer = (await generateKeyPairSigner()).address;
  });

  /**
   * A facilitator whose confirmations always succeed, over `store`.
   *
   * @param store - The pending-settlement store to use
   * @returns The facilitator, reached through its durable broadcast path
   */
  async function facilitator(store: InMemoryPendingSettlementStore): Promise<Durable> {
    const signer = toFacilitatorSvmSigner(await generateKeyPairSigner(), {
      defaultRpcUrl: "http://127.0.0.1:9",
    });
    const scheme = new BatchFacilitatorScheme(
      { ...signer, confirmTransaction: async () => undefined },
      { pendingSettlementStore: store },
    );
    return scheme as unknown as Durable;
  }

  it.each(["redemption", "open"])(
    "does not repeat the successful confirmation RPC for %s",
    async kind => {
      const wallet = await generateKeyPairSigner();
      const confirm = vi.fn().mockResolvedValue({ slot: 432n });
      let wire = "";
      const transport = {
        ...toFacilitatorSvmSigner(wallet),
        getLatestBlockhash: vi
          .fn()
          .mockResolvedValue({ blockhash: USDC_DEVNET_ADDRESS, lastValidBlockHeight: 1n }),
        simulateTransaction: vi.fn().mockResolvedValue(undefined),
        sendTransaction: vi.fn(async (bytes: string) => {
          wire = bytes;
          return getSignatureFromTransaction(
            getTransactionDecoder().decode(getBase64Codec().encode(bytes)),
          );
        }),
        confirmTransaction: confirm,
        getAccountInfo: vi.fn().mockResolvedValue(null),
      };
      const scheme = new BatchFacilitatorScheme(transport);
      const internals = scheme as any;
      const instructions = [
        {
          programAddress: address(MEMO_PROGRAM_ADDRESS),
          accounts: [],
          data: new TextEncoder().encode("RPC budget"),
        },
      ];
      const result = await internals.submitRedemption(
        wallet.address,
        NETWORK,
        instructions,
        "redemption",
        payer,
      );
      expect(result.ok).toBe(true);
      if (kind === "open") {
        confirm.mockClear();
        transport.signTransaction = vi.fn().mockImplementation(async () => wire);
        await internals.broadcastDurably("open", NETWORK, payer, (onPrepared: any) =>
          broadcastOpen(
            internals.submissionSigner(),
            wallet.address,
            NETWORK,
            wire,
            undefined,
            onPrepared,
          ),
        );
      }
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0]).toHaveLength(2); // no history search on fresh submission
      await internals.readChannel(NETWORK, wallet.address);
      expect(transport.getAccountInfo).toHaveBeenCalledWith(
        wallet.address,
        NETWORK,
        expect.objectContaining({ minContextSlot: 432n }),
      );
      // Reconciliation is allowed to search older transaction history, without building new bytes.
      confirm.mockClear();
      await internals.reconcileBroadcast(kind, result.signature, NETWORK, payer);
      expect(confirm).toHaveBeenCalledWith(result.signature, NETWORK, {
        searchTransactionHistory: true,
      });
    },
  );

  it("reconciles a recorded broadcast instead of repeating it", async () => {
    const store = new InMemoryPendingSettlementStore();
    await store.set(KEY, "recorded-signature");
    const durable = await facilitator(store);
    let broadcasts = 0;

    const result = await durable.broadcastDurably(KEY, NETWORK, payer, async () => {
      broadcasts += 1;
      return "fresh-signature";
    });

    expect(result).toMatchObject({ ok: true, signature: "recorded-signature" });
    expect(broadcasts, "the recorded transaction is confirmed, never resent").toBe(0);
    // Confirmation alone is not the operation outcome: its identity remains
    // recoverable until the claim/distribution/close postcondition is visible.
    expect(await store.get(KEY)).toBe("recorded-signature");
  });

  it("keeps the record until the reconcile knows the outcome", async () => {
    // The property a concurrent retry depends on. Dropping the record first
    // would leave a racing retry reading nothing and broadcasting the work a
    // second time — and the in-memory duplicate cache that would otherwise
    // catch it is empty after a restart, which is exactly when a pending
    // record is being reconciled.
    const store = new InMemoryPendingSettlementStore();
    await store.set(KEY, "recorded-signature");
    const signer = toFacilitatorSvmSigner(await generateKeyPairSigner(), {
      defaultRpcUrl: "http://127.0.0.1:9",
    });
    let recordDuringConfirm: string | undefined;
    const scheme = new BatchFacilitatorScheme(
      {
        ...signer,
        confirmTransaction: async () => {
          // A racing retry reads the store at exactly this point.
          recordDuringConfirm = await store.get(KEY);
        },
      },
      { pendingSettlementStore: store },
    );
    let broadcasts = 0;

    const result = await (scheme as unknown as Durable).broadcastDurably(
      KEY,
      NETWORK,
      payer,
      async () => {
        broadcasts += 1;
        return "fresh-signature";
      },
    );

    expect(recordDuringConfirm, "a racing retry must still find the record").toBe(
      "recorded-signature",
    );
    expect(result).toMatchObject({ ok: true, signature: "recorded-signature" });
    expect(broadcasts).toBe(0);
    expect(await store.get(KEY)).toBe("recorded-signature");
    await (scheme as unknown as Durable).completeBroadcast(KEY, "recorded-signature");
    expect(await store.get(KEY)).toBeUndefined();
    expect(await store.get(`${KEY}:completed`)).toBe("recorded-signature");
  });

  it("has both concurrent retries reconcile rather than rebroadcast", async () => {
    const store = new InMemoryPendingSettlementStore();
    await store.set(KEY, "recorded-signature");
    const durable = await facilitator(store);
    let broadcasts = 0;
    const attempt = () =>
      durable.broadcastDurably(KEY, NETWORK, payer, async () => {
        broadcasts += 1;
        return "fresh-signature";
      });

    const [first, second] = await Promise.all([attempt(), attempt()]);

    expect(broadcasts).toBe(0);
    expect(first).toMatchObject({ ok: true, signature: "recorded-signature" });
    expect(second).toMatchObject({ ok: true, signature: "recorded-signature" });
  });

  it("records a broadcast before its confirmation is awaited", async () => {
    // A process that dies waiting must leave the signature behind, or the
    // retry has nothing to reconcile against and broadcasts afresh.
    const store = new InMemoryPendingSettlementStore();
    const durable = await facilitator(store);
    let recordedMidFlight: string | undefined;

    await durable.broadcastDurably(KEY, NETWORK, payer, async onBroadcast => {
      await onBroadcast("in-flight-signature");
      recordedMidFlight = await store.get(KEY);
      return "in-flight-signature";
    });

    expect(recordedMidFlight).toBe("in-flight-signature");
    expect(await store.get(KEY)).toBe("in-flight-signature");
  });
});
