import { describe, expect, it } from "vitest";

import { InMemoryCardanoSettlementStore } from "../../src/settlementStore";
import { InMemoryMasumiTermsStorage, type MasumiTerms } from "../../src/exact/masumi/storage";
import type { PaymentRequirements } from "@x402/core/types";

const requirements = (overrides: Partial<PaymentRequirements> = {}): PaymentRequirements =>
  ({
    scheme: "exact",
    network: "cardano:preprod",
    amount: "5000000",
    asset: "lovelace",
    payTo: "addr_test1wzs4e6wc95hke",
    maxTimeoutSeconds: 600,
    extra: { assetTransferMethod: "masumi" },
    ...overrides,
  }) as PaymentRequirements;

const terms = (overrides: Partial<MasumiTerms> = {}): MasumiTerms => ({
  termsDigest: "digest-a",
  requirements: requirements(),
  ...overrides,
});

describe("Cardano facilitator settlement store", () => {
  it("shares owner-safe settlement claims across facilitator instances", async () => {
    const store = new InMemoryCardanoSettlementStore(2);
    expect(await store.claimSettlement({ txHash: "abc", ownerToken: "owner-a" })).toBe("fresh");
    expect(await store.claimSettlement({ txHash: "abc", ownerToken: "owner-b" })).toBe("in-flight");

    // Only the owner can advance the claim; another worker's token is ignored.
    await store.markSubmitted("abc", "owner-b");
    expect(await store.claimSettlement({ txHash: "abc", ownerToken: "owner-c" })).toBe("in-flight");
    await store.markSubmitted("abc", "owner-a");
    expect(await store.claimSettlement({ txHash: "abc", ownerToken: "owner-c" })).toBe("submitted");
  });

  it("retains definitive submission rejections as terminal tombstones", async () => {
    const store = new InMemoryCardanoSettlementStore();
    await store.claimSettlement({ txHash: "abc", ownerToken: "owner-a" });
    await store.markRejected("abc", "owner-a");

    expect(await store.claimSettlement({ txHash: "abc", ownerToken: "owner-b" })).toBe("rejected");
  });

  it("keeps Masumi terms permanently bound to their first transaction", async () => {
    const store = new InMemoryCardanoSettlementStore();
    expect(
      await store.claimSettlement({ txHash: "abc", ownerToken: "owner-a", termsDigest: "terms" }),
    ).toBe("fresh");
    expect(
      await store.claimSettlement({ txHash: "def", ownerToken: "owner-b", termsDigest: "terms" }),
    ).toBe("terms-conflict");
    expect(
      await store.claimSettlement({ txHash: "abc", ownerToken: "owner-c", termsDigest: "terms" }),
    ).toBe("in-flight");
    // The same transaction presented without its terms is a conflict too.
    expect(await store.claimSettlement({ txHash: "abc", ownerToken: "owner-d" })).toBe(
      "terms-conflict",
    );
  });

  it("claims Masumi terms and transaction atomically", async () => {
    const store = new InMemoryCardanoSettlementStore(1);
    // Terms + transaction need two entries; an empty store of one cannot evict.
    expect(
      await store.claimSettlement({ txHash: "abc", ownerToken: "owner-a", termsDigest: "terms" }),
    ).toBe("capacity-exceeded");
    // No partial terms binding was left behind.
    expect(await store.claimSettlement({ txHash: "def", ownerToken: "owner-b" })).toBe("fresh");
  });

  it("evicts the oldest settled claim once full instead of refusing", async () => {
    const store = new InMemoryCardanoSettlementStore(2);
    await store.claimSettlement({ txHash: "first", ownerToken: "a" });
    await store.markSubmitted("first", "a");
    await store.claimSettlement({ txHash: "second", ownerToken: "b" });
    await store.markSubmitted("second", "b");

    expect(await store.claimSettlement({ txHash: "third", ownerToken: "c" })).toBe("fresh");
    // `second` (newer) is retained; `first` was evicted, so a retry for it
    // starts over instead of being refused.
    expect(await store.claimSettlement({ txHash: "second", ownerToken: "e" })).toBe("submitted");
    expect(await store.claimSettlement({ txHash: "first", ownerToken: "d" })).toBe("fresh");
  });

  it("drops the Masumi terms binding together with the evicted claim", async () => {
    const store = new InMemoryCardanoSettlementStore(2);
    await store.claimSettlement({ txHash: "lock", ownerToken: "a", termsDigest: "terms" });
    await store.markSubmitted("lock", "a");

    // Two entries (transaction + terms) fill the store; the next claim evicts both.
    expect(await store.claimSettlement({ txHash: "other", ownerToken: "b" })).toBe("fresh");
    await store.markSubmitted("other", "b");
    // With the binding gone, the same terms can be claimed by another transaction.
    expect(
      await store.claimSettlement({ txHash: "replay", ownerToken: "c", termsDigest: "terms" }),
    ).toBe("fresh");
  });

  it("never evicts a claim that is still mid-submission", async () => {
    const store = new InMemoryCardanoSettlementStore(1);
    await store.claimSettlement({ txHash: "inflight", ownerToken: "a" });

    expect(await store.claimSettlement({ txHash: "other", ownerToken: "b" })).toBe(
      "capacity-exceeded",
    );
    expect(await store.claimSettlement({ txHash: "inflight", ownerToken: "c" })).toBe("in-flight");
  });

  it("releases an owned in-flight claim so the transaction can be claimed again", async () => {
    const store = new InMemoryCardanoSettlementStore();
    await store.claimSettlement({ txHash: "abc", ownerToken: "owner-a", termsDigest: "terms" });
    // Another worker's token cannot release it.
    await store.releaseClaim("abc", "owner-b");
    expect(await store.claimSettlement({ txHash: "abc", ownerToken: "owner-c" })).toBe(
      "terms-conflict",
    );
    await store.releaseClaim("abc", "owner-a");
    // Both the transaction and its terms binding are gone.
    expect(
      await store.claimSettlement({ txHash: "def", ownerToken: "owner-d", termsDigest: "terms" }),
    ).toBe("fresh");
    expect(await store.claimSettlement({ txHash: "abc", ownerToken: "owner-e" })).toBe("fresh");
  });

  it("never releases a claim that was already broadcast or rejected", async () => {
    const store = new InMemoryCardanoSettlementStore();
    await store.claimSettlement({ txHash: "sent", ownerToken: "a" });
    await store.markSubmitted("sent", "a");
    await store.releaseClaim("sent", "a");
    expect(await store.claimSettlement({ txHash: "sent", ownerToken: "b" })).toBe("submitted");

    await store.claimSettlement({ txHash: "bad", ownerToken: "c" });
    await store.markRejected("bad", "c");
    await store.releaseClaim("bad", "c");
    expect(await store.claimSettlement({ txHash: "bad", ownerToken: "d" })).toBe("rejected");
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new InMemoryCardanoSettlementStore(0)).toThrow(/positive integer/);
  });
});

describe("InMemoryMasumiTermsStorage", () => {
  it("stores an issued quote and returns it by terms digest", async () => {
    const store = new InMemoryMasumiTermsStorage();
    const issued = terms();

    const result = await store.updateTerms(issued.termsDigest, current => current ?? issued);

    expect(result.status).toBe("updated");
    expect(await store.get("digest-a")).toEqual(issued);
    expect(await store.get("digest-b")).toBeUndefined();
  });

  it("keeps the first quote for a digest so a later 402 cannot rotate it", async () => {
    const store = new InMemoryMasumiTermsStorage();
    const first = terms();
    const second = terms({ requirements: requirements({ amount: "9999999" }) });

    await store.updateTerms(first.termsDigest, current => current ?? first);
    const result = await store.updateTerms(second.termsDigest, current => current ?? second);

    expect(result.status).toBe("unchanged");
    expect((await store.get("digest-a"))?.requirements.amount).toBe("5000000");
  });

  it("binds the first transaction and reports the bound record to later callers", async () => {
    const store = new InMemoryMasumiTermsStorage();
    await store.updateTerms("digest-a", () => terms());

    const first = await store.updateTerms("digest-a", current =>
      current?.claimedTxHash === undefined ? { ...current!, claimedTxHash: "tx-a" } : current,
    );
    const second = await store.updateTerms("digest-a", current =>
      current?.claimedTxHash === undefined ? { ...current!, claimedTxHash: "tx-b" } : current,
    );

    expect(first.terms?.claimedTxHash).toBe("tx-a");
    expect(second.status).toBe("unchanged");
    expect(second.terms?.claimedTxHash).toBe("tx-a");
  });

  it("serializes concurrent updates for the same digest", async () => {
    const store = new InMemoryMasumiTermsStorage();
    await store.updateTerms("digest-a", () => terms());

    const claim = (txHash: string): Promise<string | undefined> =>
      store
        .updateTerms("digest-a", current => {
          if (current?.claimedTxHash !== undefined) return current;
          return { ...current!, claimedTxHash: txHash };
        })
        .then(result => result.terms?.claimedTxHash);

    const [a, b] = await Promise.all([claim("tx-a"), claim("tx-b")]);

    expect(a).toBe(b);
    expect(["tx-a", "tx-b"]).toContain(a);
  });

  it("evicts the oldest quote once capacity is exceeded", async () => {
    const store = new InMemoryMasumiTermsStorage({ maxEntries: 2 });
    await store.updateTerms("digest-a", () => terms({ termsDigest: "digest-a" }));
    await store.updateTerms("digest-b", () => terms({ termsDigest: "digest-b" }));
    await store.updateTerms("digest-c", () => terms({ termsDigest: "digest-c" }));

    expect(await store.get("digest-a")).toBeUndefined();
    expect(await store.get("digest-b")).toBeDefined();
    expect(await store.get("digest-c")).toBeDefined();
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new InMemoryMasumiTermsStorage({ maxEntries: 0 })).toThrow(
      /maxEntries must be a positive safe integer/,
    );
  });

  it("deletes a record when the callback returns undefined", async () => {
    const store = new InMemoryMasumiTermsStorage();
    await store.updateTerms("digest-a", () => terms());

    const result = await store.updateTerms("digest-a", () => undefined);

    expect(result.status).toBe("deleted");
    expect(await store.get("digest-a")).toBeUndefined();
  });
});
