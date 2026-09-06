import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  InMemoryPendingSettlementStore,
  PENDING_SETTLEMENT_TTL_MS,
  type PendingSettlementStore,
} from "../../../src/facilitator/pendingSettlementStore";

describe("InMemoryPendingSettlementStore", () => {
  it("returns undefined for a key that was never set", async () => {
    const store = new InMemoryPendingSettlementStore();
    expect(await store.get("missing-key")).toBeUndefined();
  });

  it("returns the stored transaction hash on a hit", async () => {
    const store = new InMemoryPendingSettlementStore();
    await store.set("key1", "0xabc");
    expect(await store.get("key1")).toBe("0xabc");
  });

  it("overwrites a prior value on a second set for the same key", async () => {
    const store = new InMemoryPendingSettlementStore();
    await store.set("key1", "0xabc");
    await store.set("key1", "0xdef");
    expect(await store.get("key1")).toBe("0xdef");
  });

  it("removes the entry on delete", async () => {
    const store = new InMemoryPendingSettlementStore();
    await store.set("key1", "0xabc");
    await store.delete("key1");
    expect(await store.get("key1")).toBeUndefined();
  });

  it("delete is a no-op for a key that was never set", async () => {
    const store = new InMemoryPendingSettlementStore();
    await expect(store.delete("missing-key")).resolves.toBeUndefined();
  });

  it("keeps entries independent by key", async () => {
    const store = new InMemoryPendingSettlementStore();
    await store.set("key1", "0xabc");
    await store.set("key2", "0xdef");
    expect(await store.get("key1")).toBe("0xabc");
    expect(await store.get("key2")).toBe("0xdef");
    await store.delete("key1");
    expect(await store.get("key1")).toBeUndefined();
    expect(await store.get("key2")).toBe("0xdef");
  });

  describe("TTL expiry", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("prunes an entry once it is older than the TTL", async () => {
      const store = new InMemoryPendingSettlementStore();
      await store.set("key1", "0xabc");

      vi.advanceTimersByTime(PENDING_SETTLEMENT_TTL_MS + 1);

      expect(await store.get("key1")).toBeUndefined();
    });

    it("keeps an entry that has not yet reached the TTL", async () => {
      const store = new InMemoryPendingSettlementStore();
      await store.set("key1", "0xabc");

      vi.advanceTimersByTime(PENDING_SETTLEMENT_TTL_MS - 1);

      expect(await store.get("key1")).toBe("0xabc");
    });

    it("prunes lazily: an expired entry is only removed when accessed", async () => {
      const store = new InMemoryPendingSettlementStore();
      await store.set("key1", "0xabc");
      await store.set("key2", "0xdef");

      vi.advanceTimersByTime(PENDING_SETTLEMENT_TTL_MS + 1);

      // Accessing key1 triggers a prune pass that also drops key2.
      expect(await store.get("key1")).toBeUndefined();
      expect(await store.get("key2")).toBeUndefined();
    });

    it("does not prune an entry refreshed by a later set", async () => {
      const store = new InMemoryPendingSettlementStore();
      await store.set("key1", "0xabc");

      vi.advanceTimersByTime(PENDING_SETTLEMENT_TTL_MS - 1000);
      await store.set("key1", "0xdef"); // refresh storedAt

      vi.advanceTimersByTime(2000); // total elapsed since first set > TTL, but < TTL since refresh

      expect(await store.get("key1")).toBe("0xdef");
    });
  });
});

/**
 * A minimal test double proving that mechanism code depending on
 * {@link PendingSettlementStore} only needs the interface, never the
 * concrete {@link InMemoryPendingSettlementStore} implementation.
 */
class RecordingPendingSettlementStore implements PendingSettlementStore {
  readonly getCalls: string[] = [];
  readonly setCalls: Array<{ key: string; txHash: string }> = [];
  readonly deleteCalls: string[] = [];
  private readonly entries = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    this.getCalls.push(key);
    return this.entries.get(key);
  }

  async set(key: string, txHash: string): Promise<void> {
    this.setCalls.push({ key, txHash });
    this.entries.set(key, txHash);
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    this.entries.delete(key);
  }
}

describe("PendingSettlementStore interface (test double)", () => {
  it("a custom implementation satisfies the interface and behaves like the default store", async () => {
    const store: PendingSettlementStore = new RecordingPendingSettlementStore();

    expect(await store.get("k")).toBeUndefined();
    await store.set("k", "0x1");
    expect(await store.get("k")).toBe("0x1");
    await store.delete("k");
    expect(await store.get("k")).toBeUndefined();
  });

  it("records interactions distinctly from the in-memory implementation", async () => {
    const store = new RecordingPendingSettlementStore();
    await store.set("k", "0x1");
    await store.get("k");
    await store.delete("k");

    expect(store.setCalls).toEqual([{ key: "k", txHash: "0x1" }]);
    expect(store.getCalls).toEqual(["k"]);
    expect(store.deleteCalls).toEqual(["k"]);
  });
});
