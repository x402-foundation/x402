import { describe, expect, it, beforeEach } from "vitest";
import { InMemoryPaymentUrlCache } from "../../src/types";

describe("InMemoryPaymentUrlCache", () => {
  let cache: InMemoryPaymentUrlCache;

  beforeEach(() => {
    cache = new InMemoryPaymentUrlCache();
  });

  it("should return undefined for a missing key", () => {
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("should store and retrieve an entry", () => {
    const entry = { timestamp: Date.now(), resourceUrl: "https://api.example.com/resource" };
    cache.set("key1", entry);
    expect(cache.get("key1")).toEqual(entry);
  });

  it("should overwrite an existing entry", () => {
    const entry1 = { timestamp: 1000, resourceUrl: "https://api.example.com/a" };
    const entry2 = { timestamp: 2000, resourceUrl: "https://api.example.com/b" };
    cache.set("key1", entry1);
    cache.set("key1", entry2);
    expect(cache.get("key1")).toEqual(entry2);
  });

  it("should delete an entry", () => {
    cache.set("key1", { timestamp: Date.now(), resourceUrl: "https://api.example.com/resource" });
    cache.delete("key1");
    expect(cache.get("key1")).toBeUndefined();
  });

  it("should no-op delete on a missing key", () => {
    expect(() => cache.delete("nonexistent")).not.toThrow();
  });

  describe("clearOlderThan", () => {
    it("should remove entries older than the cutoff", () => {
      const old = { timestamp: 1000, resourceUrl: "https://api.example.com/old" };
      const recent = { timestamp: 9000, resourceUrl: "https://api.example.com/recent" };
      cache.set("old", old);
      cache.set("recent", recent);

      cache.clearOlderThan(5000);

      expect(cache.get("old")).toBeUndefined();
      expect(cache.get("recent")).toEqual(recent);
    });

    it("should keep entries at exactly the cutoff timestamp", () => {
      const entry = { timestamp: 5000, resourceUrl: "https://api.example.com/resource" };
      cache.set("key1", entry);
      cache.clearOlderThan(5000);
      expect(cache.get("key1")).toEqual(entry);
    });

    it("should be a no-op on an empty cache", () => {
      expect(() => cache.clearOlderThan(Date.now())).not.toThrow();
    });
  });
});
