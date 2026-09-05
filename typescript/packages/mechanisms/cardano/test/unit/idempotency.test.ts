import { describe, expect, it } from "vitest";

import { InMemoryCardanoSettlementStore } from "../../src/idempotency";
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
    expect(
      await store.claimSettlement({
        txHash: "abc",
        mode: "server",
        ownerToken: "owner-a",
      }),
    ).toBe("fresh");
    expect(
      await store.claimSettlement({
        txHash: "abc",
        mode: "server",
        ownerToken: "owner-b",
      }),
    ).toBe("in-flight");

    expect(
      await store.claimSettlement({
        txHash: "abc",
        mode: "client",
        ownerToken: "owner-c",
      }),
    ).toBe("mode-conflict");
  });

  it("retains definitive submission rejections as terminal tombstones", async () => {
    const store = new InMemoryCardanoSettlementStore();
    await store.claimSettlement({ txHash: "abc", mode: "server", ownerToken: "owner-a" });
    await store.markRejected("abc", "owner-a");

    expect(
      await store.claimSettlement({ txHash: "abc", mode: "server", ownerToken: "owner-b" }),
    ).toBe("rejected");
  });

  it("keeps Masumi terms permanently bound to their first transaction", async () => {
    const store = new InMemoryCardanoSettlementStore();
    expect(
      await store.claimSettlement({
        txHash: "abc",
        mode: "server",
        ownerToken: "owner-a",
        termsDigest: "terms",
      }),
    ).toBe("fresh");
    expect(
      await store.claimSettlement({
        txHash: "def",
        mode: "server",
        ownerToken: "owner-b",
        termsDigest: "terms",
      }),
    ).toBe("terms-conflict");
    expect(
      await store.claimSettlement({
        txHash: "abc",
        mode: "server",
        ownerToken: "owner-c",
        termsDigest: "terms",
      }),
    ).toBe("in-flight");
  });

  it("claims Masumi terms and transaction atomically", async () => {
    const store = new InMemoryCardanoSettlementStore(1);
    expect(
      await store.claimSettlement({
        txHash: "abc",
        mode: "server",
        ownerToken: "owner-a",
        termsDigest: "terms",
      }),
    ).toBe("capacity-exceeded");
    expect(
      await store.claimSettlement({
        txHash: "def",
        mode: "server",
        ownerToken: "owner-b",
      }),
    ).toBe("fresh");
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
