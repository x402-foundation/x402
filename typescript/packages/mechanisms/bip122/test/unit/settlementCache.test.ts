import { describe, it, expect, vi, afterEach } from "vitest";
import { createInMemorySettlementCache } from "../../src/exact/settlementCache";

describe("createInMemorySettlementCache", () => {
  afterEach(() => vi.useRealTimers());

  it("returns false for unknown hash", () => {
    const cache = createInMemorySettlementCache();
    expect(cache.isSettled("unknown")).toBe(false);
  });

  it("returns true immediately after marking", () => {
    const cache = createInMemorySettlementCache();
    cache.markSettled("hash1", 60_000);
    expect(cache.isSettled("hash1")).toBe(true);
  });

  it("returns false after TTL expires", () => {
    vi.useFakeTimers();
    const cache = createInMemorySettlementCache();
    cache.markSettled("hash2", 1000);
    vi.advanceTimersByTime(1001);
    expect(cache.isSettled("hash2")).toBe(false);
  });

  it("handles multiple independent hashes", () => {
    const cache = createInMemorySettlementCache();
    cache.markSettled("a", 10_000);
    cache.markSettled("b", 10_000);
    expect(cache.isSettled("a")).toBe(true);
    expect(cache.isSettled("b")).toBe(true);
    expect(cache.isSettled("c")).toBe(false);
  });
});