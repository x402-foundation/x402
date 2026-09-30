import { describe, expect, it, vi } from "vitest";

import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import {
  CallerIdentityConflictError,
  checkOpenBindings,
  InMemoryPaymentChannelStorage,
  ReceiverAuthorizerConflictError,
  writeThenBroadcast,
  type PaymentChannelRecord,
} from "../../src/payment-channels/storage";

function record(overrides: Partial<PaymentChannelRecord> = {}): PaymentChannelRecord {
  return {
    callerIdentity: "",
    channelId: "chan-a",
    expiresAt: 0,
    lastActivityAt: 10,
    network: SOLANA_DEVNET_CAIP2,
    payTo: USDC_MAINNET_ADDRESS,
    receiverAuthorizer: "",
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    ...overrides,
  };
}

describe("payment-channel facilitator storage", () => {
  it("keeps open facts and only moves expiry and activity forward on a compatible open", async () => {
    const storage = new InMemoryPaymentChannelStorage();
    const created = await storage.recordOpen(
      record({ callerIdentity: "svc-1", expiresAt: 50, receiverAuthorizer: "auth-a" }),
    );
    expect(created.revertToken).not.toBe("");

    const again = await storage.recordOpen(
      record({
        callerIdentity: "svc-1",
        expiresAt: 40,
        lastActivityAt: 30,
        payTo: "other",
        receiverAuthorizer: "auth-a",
      }),
    );
    expect(again.revertToken).toBe("");
    expect(again.record).toMatchObject({
      callerIdentity: "svc-1",
      expiresAt: 50,
      lastActivityAt: 30,
      payTo: USDC_MAINNET_ADDRESS,
      receiverAuthorizer: "auth-a",
    });
    expect(() => checkOpenBindings(record({ receiverAuthorizer: "auth-b" }), again.record)).toThrow(
      ReceiverAuthorizerConflictError,
    );
    expect(() => checkOpenBindings(record({ callerIdentity: "svc-2" }), again.record)).toThrow(
      CallerIdentityConflictError,
    );
  });

  it.each([
    ["callerIdentity", { callerIdentity: "svc-2" }, CallerIdentityConflictError],
    ["receiverAuthorizer", { receiverAuthorizer: "auth-b" }, ReceiverAuthorizerConflictError],
  ] as const)(
    "leaves the row and revert token untouched on a conflicting %s",
    async (_name, conflict, errorClass) => {
      const storage = new InMemoryPaymentChannelStorage();
      const first = record({
        callerIdentity: "svc-1",
        expiresAt: 50,
        receiverAuthorizer: "auth-a",
      });
      const created = await storage.recordOpen(first);

      const requested = record({ ...conflict, expiresAt: 90, lastActivityAt: 30 });
      const conflicting = await storage.recordOpen(requested);
      expect(conflicting.revertToken).toBe("");
      expect(conflicting.record).toMatchObject({
        callerIdentity: "svc-1",
        expiresAt: 50,
        lastActivityAt: 10,
        receiverAuthorizer: "auth-a",
      });
      expect(() => checkOpenBindings(requested, conflicting.record)).toThrow(errorClass);
      expect(await storage.get(SOLANA_DEVNET_CAIP2, "chan-a")).toMatchObject({
        expiresAt: 50,
        lastActivityAt: 10,
      });

      await storage.revertOpen(created);
      expect(await storage.get(SOLANA_DEVNET_CAIP2, "chan-a")).toBeUndefined();
    },
  );

  it("rotates the revert token on a same-identity open", async () => {
    const storage = new InMemoryPaymentChannelStorage();
    const created = await storage.recordOpen(
      record({ callerIdentity: "svc-1", receiverAuthorizer: "auth-a" }),
    );
    await storage.recordOpen(
      record({ callerIdentity: "svc-1", lastActivityAt: 11, receiverAuthorizer: "auth-a" }),
    );
    await storage.revertOpen(created);
    expect(await storage.get(SOLANA_DEVNET_CAIP2, "chan-a")).toMatchObject({ lastActivityAt: 11 });
  });

  it("reverts only the row this open created", async () => {
    const storage = new InMemoryPaymentChannelStorage();
    const created = await storage.recordOpen(record());
    await storage.revertOpen(created);
    expect(await storage.get(SOLANA_DEVNET_CAIP2, "chan-a")).toBeUndefined();

    await storage.recordOpen(record({ channelId: "chan-b" }));
    const existing = await storage.recordOpen(record({ channelId: "chan-b", lastActivityAt: 20 }));
    await storage.revertOpen(existing);
    expect(await storage.get(SOLANA_DEVNET_CAIP2, "chan-b")).toMatchObject({ lastActivityAt: 20 });
  });

  it("does not revert an open after a later open rotates the token", async () => {
    const storage = new InMemoryPaymentChannelStorage();
    const created = await storage.recordOpen(record());
    await storage.recordOpen(record({ lastActivityAt: 11 }));
    await storage.revertOpen(created);
    expect(await storage.get(SOLANA_DEVNET_CAIP2, "chan-a")).toMatchObject({ lastActivityAt: 11 });
  });

  it("keeps activity, including a row it had to create, and leaves the revert token alone", async () => {
    const storage = new InMemoryPaymentChannelStorage();
    const created = await storage.recordOpen(record({ receiverAuthorizer: "auth-a" }));
    await storage.recordActivity(
      record({ lastActivityAt: 5, payTo: "ignored", receiverAuthorizer: "other" }),
      record({ channelId: "chan-b", lastActivityAt: 40 }),
    );
    expect(await storage.get(SOLANA_DEVNET_CAIP2, "chan-a")).toMatchObject({
      lastActivityAt: 10,
      payTo: USDC_MAINNET_ADDRESS,
      receiverAuthorizer: "auth-a",
    });
    expect(await storage.get(SOLANA_DEVNET_CAIP2, "chan-b")).toMatchObject({ lastActivityAt: 40 });
    await storage.revertOpen(created);
    expect(await storage.get(SOLANA_DEVNET_CAIP2, "chan-a")).toBeUndefined();
  });

  it("reverts an open that fails before reservation and keeps one that is pending", async () => {
    const storage = new InMemoryPaymentChannelStorage();
    await expect(
      writeThenBroadcast({
        kind: "open",
        records: [record()],
        storage,
        broadcast: async () => {
          throw new Error("send rejected");
        },
      }),
    ).rejects.toThrow("send rejected");
    expect(await storage.get(SOLANA_DEVNET_CAIP2, "chan-a")).toBeUndefined();

    const onStorageError = vi.fn();
    const failing = {
      recordOpen: (input: PaymentChannelRecord) => storage.recordOpen(input),
      revertOpen: () => Promise.reject(new Error("revert down")),
      recordActivity: (...records: PaymentChannelRecord[]) => storage.recordActivity(...records),
      get: (network: string, channelId: string) => storage.get(network, channelId),
      list: (network: string) => storage.list(network),
      delete: (network: string, channelId: string) => storage.delete(network, channelId),
    };
    await expect(
      writeThenBroadcast({
        kind: "open",
        onStorageError,
        records: [record({ channelId: "chan-c" })],
        storage: failing,
        broadcast: async () => {
          throw new Error("send rejected");
        },
      }),
    ).rejects.toThrow("send rejected");
    expect(onStorageError).toHaveBeenCalledWith(expect.any(Error), SOLANA_DEVNET_CAIP2, "chan-c");

    await writeThenBroadcast({
      kind: "open",
      records: [record({ channelId: "chan-d" })],
      storage,
      broadcast: async reserved => {
        reserved();
        return { disposition: "keep", value: "pending" };
      },
    });
    expect(await storage.get(SOLANA_DEVNET_CAIP2, "chan-d")).toBeDefined();
  });

  it("keeps an open when the broadcast was reserved and then throws", async () => {
    const storage = new InMemoryPaymentChannelStorage();
    await expect(
      writeThenBroadcast({
        kind: "open",
        records: [record()],
        storage,
        broadcast: async reserved => {
          reserved();
          throw new Error("postcondition mismatch");
        },
      }),
    ).rejects.toThrow("postcondition mismatch");
    expect(await storage.get(SOLANA_DEVNET_CAIP2, "chan-a")).toBeDefined();
  });

  it("keeps activity when the broadcast fails", async () => {
    const storage = new InMemoryPaymentChannelStorage();
    await expect(
      writeThenBroadcast({
        kind: "activity",
        records: [record({ lastActivityAt: 80 })],
        storage,
        broadcast: async () => {
          throw new Error("claim failed");
        },
      }),
    ).rejects.toThrow("claim failed");
    expect(await storage.get(SOLANA_DEVNET_CAIP2, "chan-a")).toMatchObject({ lastActivityAt: 80 });
  });

  it("does not broadcast when the open write fails", async () => {
    const broadcast = vi.fn();
    const storage = new InMemoryPaymentChannelStorage();
    vi.spyOn(storage, "recordOpen").mockRejectedValue(new Error("storage unavailable"));
    await expect(
      writeThenBroadcast({
        kind: "open",
        records: [record()],
        storage,
        broadcast,
      }),
    ).rejects.toThrow("storage unavailable");
    expect(broadcast).not.toHaveBeenCalled();
  });
});
