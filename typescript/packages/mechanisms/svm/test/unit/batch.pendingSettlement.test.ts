import { generateKeyPairSigner } from "@solana/kit";
import { InMemoryPendingSettlementStore } from "@x402/core/facilitator";
import { beforeAll, describe, expect, it } from "vitest";

import { BatchSvmScheme as BatchFacilitatorScheme } from "../../src/batch-settlement/facilitator/scheme";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";
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
  ): Promise<{ ok: true; signature: string } | { ok: false; response: unknown }>;
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
    // Confirmed, so the record is gone and the next attempt starts clean.
    expect(await store.get(KEY)).toBeUndefined();
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
    // Only once the outcome is known does the record go.
    expect(await store.get(KEY)).toBeUndefined();
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
    // Confirmed, so it is cleaned up afterwards.
    expect(await store.get(KEY)).toBeUndefined();
  });
});
