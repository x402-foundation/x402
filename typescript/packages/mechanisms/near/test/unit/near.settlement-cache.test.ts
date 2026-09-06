import { describe, expect, it } from "vitest";
import { SettlementCache } from "../../src/settlement-cache";

describe("SettlementCache (spec §10)", () => {
  it("flags a key as duplicate only while it is in flight", () => {
    const cache = new SettlementCache();
    expect(cache.isDuplicate("key-a", 100n)).toBe(false); // first insert
    expect(cache.isDuplicate("key-a", 100n)).toBe(true); // duplicate
    cache.release("key-a");
    expect(cache.isDuplicate("key-a", 100n)).toBe(false); // re-insertable after release
  });

  it("evicts entries whose max_block_height has passed", () => {
    const cache = new SettlementCache();
    cache.isDuplicate("key-b", 100n);
    cache.evictExpired(50n); // window not yet passed
    expect(cache.isDuplicate("key-b", 100n)).toBe(true);
    cache.evictExpired(101n); // window passed
    expect(cache.isDuplicate("key-b", 100n)).toBe(false);
  });
});
