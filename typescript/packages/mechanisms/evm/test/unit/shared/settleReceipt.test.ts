import { describe, it, expect } from "vitest";
import type { PendingSettlementStore } from "@x402/core/facilitator";
import type { SettleResponse } from "@x402/core/types";
import {
  waitAndReturnSettleResponse,
  withPendingSettlementStore,
} from "../../../src/shared/settleReceipt";
import { ErrSettlementPending } from "../../../src/exact/facilitator/errors";

// waitAndReturnSettleResponse is the single place every EVM scheme (exact, upto, batch)
// decides terminal vs settlement_pending after a broadcast. The boundary:
//   - invalid broadcast hash           -> terminal (no hash to reconcile against)
//   - receipt-wait failure             -> settlement_pending (hash kept)
//   - reverted receipt                 -> terminal (definitively failed on-chain)
//   - validateReceipt returns failure  -> terminal (confirmed, but did not settle)
//   - unexpected throw while processing -> settlement_pending (confirmed, effect unknown)
// The last case must never be terminal: the tx is on-chain and may have succeeded, so a
// terminal result could prompt a double-spend retry.

const TX = `0x${"ab".repeat(32)}` as `0x${string}`;
const FAILED = "invalid_exact_evm_transaction_failed";
const NETWORK = "eip155:8453" as never;

const signerWith = (receipt: unknown, error?: Error): any => ({
  waitForTransactionReceipt: async () => {
    if (error) throw error;
    return receipt;
  },
});

const okReceipt = { status: "success", logs: [] };

describe("waitAndReturnSettleResponse terminal/pending boundary", () => {
  it("returns terminal for an invalid broadcast hash", async () => {
    const out = await waitAndReturnSettleResponse(
      signerWith(okReceipt),
      "0xnope" as `0x${string}`,
      NETWORK,
      undefined,
      { failedStatusReason: FAILED },
    );
    expect(out.success).toBe(false);
    expect(out.errorReason).toBe(FAILED);
    expect(out.transaction).toBe("");
  });

  it("returns settlement_pending when the receipt wait fails", async () => {
    const out = await waitAndReturnSettleResponse(
      signerWith(undefined, new Error("rpc timeout")),
      TX,
      NETWORK,
      undefined,
      { failedStatusReason: FAILED },
    );
    expect(out.success).toBe(false);
    expect(out.errorReason).toBe(ErrSettlementPending);
    expect(out.transaction).toBe(TX);
  });

  it("returns terminal for a reverted receipt", async () => {
    const out = await waitAndReturnSettleResponse(
      signerWith({ status: "reverted", logs: [] }),
      TX,
      NETWORK,
      undefined,
      { failedStatusReason: FAILED },
    );
    expect(out.success).toBe(false);
    expect(out.errorReason).toBe(FAILED);
    expect(out.transaction).toBe(TX);
  });

  it("returns terminal when validateReceipt reports a clean failure", async () => {
    const out = await waitAndReturnSettleResponse(signerWith(okReceipt), TX, NETWORK, undefined, {
      failedStatusReason: FAILED,
      validateReceipt: () => ({
        success: false,
        errorReason: FAILED,
        transaction: TX,
        network: NETWORK,
      }),
    });
    expect(out.success).toBe(false);
    expect(out.errorReason).toBe(FAILED);
  });

  it("returns settlement_pending when validateReceipt throws", async () => {
    const out = await waitAndReturnSettleResponse(signerWith(okReceipt), TX, NETWORK, undefined, {
      failedStatusReason: FAILED,
      validateReceipt: () => {
        throw new Error("log decode failed");
      },
    });
    expect(out.success).toBe(false);
    expect(out.errorReason).toBe(ErrSettlementPending);
    expect(out.transaction).toBe(TX);
  });

  it("returns settlement_pending when onSuccess rejects", async () => {
    const out = await waitAndReturnSettleResponse(signerWith(okReceipt), TX, NETWORK, undefined, {
      failedStatusReason: FAILED,
      onSuccess: async () => {
        throw new Error("amount parse failed");
      },
    });
    expect(out.success).toBe(false);
    expect(out.errorReason).toBe(ErrSettlementPending);
    expect(out.transaction).toBe(TX);
  });

  it("returns success with the hash on a confirmed receipt", async () => {
    const out = await waitAndReturnSettleResponse(signerWith(okReceipt), TX, NETWORK, "0xpayer", {
      failedStatusReason: FAILED,
      amount: "100",
    });
    expect(out.success).toBe(true);
    expect(out.transaction).toBe(TX);
    expect(out.amount).toBe("100");
  });
});

const KEY = "pending-key";
const NON_RETRYABLE = "non_retryable_fallback";

/**
 * Minimal in-memory PendingSettlementStore whose set/delete can be forced to
 * reject, to exercise withPendingSettlementStore's storage-failure handling.
 */
class FakeStore implements PendingSettlementStore {
  entries = new Map<string, string>();
  setError?: Error;
  deleteError?: Error;

  async get(key: string): Promise<string | undefined> {
    return this.entries.get(key);
  }

  async set(key: string, tx: string): Promise<void> {
    if (this.setError) throw this.setError;
    this.entries.set(key, tx);
  }

  async delete(key: string): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    this.entries.delete(key);
  }
}

const pendingResult: SettleResponse = {
  success: false,
  errorReason: ErrSettlementPending,
  transaction: TX,
  network: NETWORK,
  payer: undefined,
};

const revertedResult: SettleResponse = {
  success: false,
  errorReason: FAILED,
  transaction: TX,
  network: NETWORK,
  payer: undefined,
};

const successResult: SettleResponse = {
  success: true,
  transaction: TX,
  network: NETWORK,
  payer: undefined,
};

describe("withPendingSettlementStore", () => {
  it("records a settlement_pending outcome for reconciliation", async () => {
    const store = new FakeStore();
    const out = await withPendingSettlementStore(store, KEY, async () => pendingResult);
    expect(out).toEqual(pendingResult);
    expect(store.entries.get(KEY)).toBe(TX);
  });

  it("clears the entry on success", async () => {
    const store = new FakeStore();
    store.entries.set(KEY, TX);
    const out = await withPendingSettlementStore(store, KEY, async () => successResult);
    expect(out).toEqual(successResult);
    expect(store.entries.has(KEY)).toBe(false);
  });

  it("clears (never sets) a terminal failure carrying a transaction hash", async () => {
    // Regression test: a reverted receipt also has a transaction hash, so a
    // naive "does this have a transaction?" check would cache it — leaving a
    // stale false-pending entry until TTL expiry (only settlement_pending is
    // safe to reconcile against).
    const store = new FakeStore();
    store.entries.set(KEY, TX);
    const out = await withPendingSettlementStore(store, KEY, async () => revertedResult);
    expect(out).toEqual(revertedResult);
    expect(store.entries.has(KEY)).toBe(false);
  });

  it("downgrades to non-retryable when persisting the pending entry fails", async () => {
    const store = new FakeStore();
    store.setError = new Error("redis unavailable");
    const out = await withPendingSettlementStore(
      store,
      KEY,
      async () => pendingResult,
      NON_RETRYABLE,
    );
    expect(out.success).toBe(false);
    expect(out.errorReason).toBe(NON_RETRYABLE);
    expect(out.transaction).toBe(TX);
    expect(out.errorMessage).toContain("redis unavailable");
  });

  it("still returns a successful result when clearing the entry fails", async () => {
    const store = new FakeStore();
    store.deleteError = new Error("redis unavailable");
    const out = await withPendingSettlementStore(store, KEY, async () => successResult);
    expect(out).toEqual(successResult);
  });

  it("still returns a terminal failure when clearing the entry fails", async () => {
    const store = new FakeStore();
    store.deleteError = new Error("redis unavailable");
    const out = await withPendingSettlementStore(store, KEY, async () => revertedResult);
    expect(out).toEqual(revertedResult);
  });

  it("leaves the store untouched when there is no pending key", async () => {
    const store = new FakeStore();
    const out = await withPendingSettlementStore(store, undefined, async () => pendingResult);
    expect(out).toEqual(pendingResult);
    expect(store.entries.size).toBe(0);
  });
});
