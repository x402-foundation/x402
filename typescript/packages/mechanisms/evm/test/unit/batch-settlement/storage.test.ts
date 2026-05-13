import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryChannelStorage, type Channel } from "../../../src/batch-settlement/server/storage";
import {
  RedisChannelStorage,
  type RedisChannelStorageClient,
  type RedisEvalOptions,
  type RedisScanOptions,
  type RedisSetOptions,
} from "../../../src/batch-settlement/server/redisStorage";
import {
  InMemoryClientChannelStorage,
  type BatchSettlementClientContext,
} from "../../../src/batch-settlement/client/storage";
import type { ChannelConfig } from "../../../src/batch-settlement/types";

const CHANNEL_CONFIG: ChannelConfig = {
  payer: "0x1234567890123456789012345678901234567890",
  payerAuthorizer: "0x1234567890123456789012345678901234567890",
  receiver: "0x9876543210987654321098765432109876543210",
  receiverAuthorizer: "0x0000000000000000000000000000000000000000",
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  withdrawDelay: 900,
  salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
};

const CHANNEL_ID = "0xabc1230000000000000000000000000000000000000000000000000000000001";

const buildSession = (overrides: Partial<Channel> = {}): Channel => ({
  channelId: CHANNEL_ID,
  channelConfig: CHANNEL_CONFIG,
  chargedCumulativeAmount: "0",
  signedMaxClaimable: "0",
  signature: "0x",
  balance: "10000000",
  totalClaimed: "0",
  withdrawRequestedAt: 0,
  refundNonce: 0,
  lastRequestTimestamp: 0,
  ...overrides,
});

describe("InMemoryChannelStorage", () => {
  let storage: InMemoryChannelStorage;

  beforeEach(() => {
    storage = new InMemoryChannelStorage();
  });

  describe("get/updateChannel", () => {
    it("returns undefined when no session exists", async () => {
      expect(await storage.get(CHANNEL_ID)).toBeUndefined();
    });

    it("stores and retrieves a session", async () => {
      const session = buildSession({ chargedCumulativeAmount: "1000" });
      await storage.updateChannel(CHANNEL_ID, () => session);
      expect(await storage.get(CHANNEL_ID)).toEqual(session);
    });

    it("treats channelId case-insensitively", async () => {
      const session = buildSession({ chargedCumulativeAmount: "500" });
      await storage.updateChannel(CHANNEL_ID.toUpperCase(), () => session);
      expect(await storage.get(CHANNEL_ID.toLowerCase())).toEqual(session);
    });

    it("overwrites a session on subsequent update", async () => {
      await storage.updateChannel(CHANNEL_ID, () => buildSession({ chargedCumulativeAmount: "1" }));
      await storage.updateChannel(CHANNEL_ID, () => buildSession({ chargedCumulativeAmount: "2" }));
      const got = await storage.get(CHANNEL_ID);
      expect(got?.chargedCumulativeAmount).toBe("2");
    });

    it("deletes a session", async () => {
      await storage.updateChannel(CHANNEL_ID, () => buildSession());
      await storage.updateChannel(CHANNEL_ID, () => undefined);
      expect(await storage.get(CHANNEL_ID)).toBeUndefined();
    });

    it("delete is a no-op when nothing is stored", async () => {
      await expect(storage.updateChannel(CHANNEL_ID, () => undefined)).resolves.toEqual({
        channel: undefined,
        status: "unchanged",
      });
    });
  });

  describe("list", () => {
    it("returns [] for an empty storage", async () => {
      expect(await storage.list()).toEqual([]);
    });

    it("returns all stored sessions", async () => {
      const id1 = "0x1111111111111111111111111111111111111111111111111111111111111111";
      const id2 = "0x2222222222222222222222222222222222222222222222222222222222222222";
      await storage.updateChannel(id1, () => buildSession({ channelId: id1 }));
      await storage.updateChannel(id2, () => buildSession({ channelId: id2 }));
      const all = await storage.list();
      expect(all).toHaveLength(2);
      expect(all.map(s => s.channelId).sort()).toEqual([id1, id2].sort());
    });
  });

  describe("updateChannel", () => {
    it("inserts a new session when none exists", async () => {
      const session = buildSession({ chargedCumulativeAmount: "100" });
      const result = await storage.updateChannel(CHANNEL_ID, () => session);
      expect(result).toEqual({ channel: session, status: "updated" });
      expect(await storage.get(CHANNEL_ID)).toEqual(session);
    });

    it("updates from the current stored value", async () => {
      await storage.updateChannel(CHANNEL_ID, () =>
        buildSession({ chargedCumulativeAmount: "500" }),
      );
      const updated = buildSession({ chargedCumulativeAmount: "750" });
      const result = await storage.updateChannel(CHANNEL_ID, current =>
        current?.chargedCumulativeAmount === "500" ? updated : current,
      );
      expect(result.status).toBe("updated");
      expect((await storage.get(CHANNEL_ID))?.chargedCumulativeAmount).toBe("750");
    });

    it("can leave the channel unchanged", async () => {
      await storage.updateChannel(CHANNEL_ID, () =>
        buildSession({ chargedCumulativeAmount: "500" }),
      );
      const updated = buildSession({ chargedCumulativeAmount: "750" });
      const result = await storage.updateChannel(CHANNEL_ID, current =>
        current?.chargedCumulativeAmount === "499" ? updated : current,
      );
      expect(result.status).toBe("unchanged");
      expect((await storage.get(CHANNEL_ID))?.chargedCumulativeAmount).toBe("500");
    });

    it("serializes concurrent updateChannel mutations", async () => {
      await storage.updateChannel(CHANNEL_ID, () => buildSession({ chargedCumulativeAmount: "0" }));
      const winner = buildSession({ chargedCumulativeAmount: "100" });
      const loser = buildSession({ chargedCumulativeAmount: "200" });

      const [a, b] = await Promise.all([
        storage.updateChannel(CHANNEL_ID, current =>
          current?.chargedCumulativeAmount === "0" ? winner : current,
        ),
        storage.updateChannel(CHANNEL_ID, current =>
          current?.chargedCumulativeAmount === "0" ? loser : current,
        ),
      ]);

      expect([a, b].filter(result => result.status === "updated")).toHaveLength(1);
      const final = await storage.get(CHANNEL_ID);
      expect(["100", "200"]).toContain(final?.chargedCumulativeAmount);
    });
  });
});

type RedisValue = {
  expiresAt?: number;
  value: string;
};

class MockRedisClient implements RedisChannelStorageClient {
  readonly store = new Map<string, RedisValue>();
  updateConflicts = 0;
  nextChannelGetDelay: Deferred<void> | undefined;
  nextUpdateEvalDelay: Deferred<void> | undefined;

  async get(key: string): Promise<string | null> {
    await this.maybeDelayChannelGet(key);
    this.expireKey(key);
    return this.store.get(key)?.value ?? null;
  }

  async set(key: string, value: string, options?: RedisSetOptions): Promise<string | null> {
    this.expireKey(key);
    if (options?.NX && this.store.has(key)) {
      return null;
    }

    this.store.set(key, {
      value,
      ...(options?.PX ? { expiresAt: Date.now() + options.PX } : {}),
    });
    return "OK";
  }

  async del(key: string): Promise<number> {
    this.expireKey(key);
    return this.store.delete(key) ? 1 : 0;
  }

  async eval(script: string, options: RedisEvalOptions): Promise<unknown> {
    const [key] = options.keys;
    this.expireKey(key);
    if (!script.includes("expectedExists")) {
      throw new Error("Unsupported Redis script");
    }

    if (this.nextUpdateEvalDelay) {
      const delay = this.nextUpdateEvalDelay;
      this.nextUpdateEvalDelay = undefined;
      await delay.promise;
    }

    const [expectedExists, expected, operation, nextValue] = options.arguments;
    const current = this.store.get(key);
    const matches = expectedExists === "0" ? current === undefined : current?.value === expected;

    if (!matches) {
      this.updateConflicts += 1;
      return [0, current?.value ?? null];
    }

    if (operation === "delete") {
      this.store.delete(key);
      return [1, null];
    }

    if (operation === "set") {
      this.store.set(key, { value: nextValue });
      return [1, nextValue];
    }

    if (operation === "keep") {
      return [1, current?.value ?? null];
    }

    throw new Error("Unsupported Redis update operation");
  }

  async *scanIterator(options: RedisScanOptions): AsyncIterable<string[]> {
    const prefix = options.MATCH?.replace(/\*$/, "") ?? "";
    this.expireAll();
    yield [...this.store.keys()].filter(key => key.startsWith(prefix));
  }

  private expireAll() {
    for (const key of this.store.keys()) {
      this.expireKey(key);
    }
  }

  private expireKey(key: string) {
    const value = this.store.get(key);
    if (value?.expiresAt && value.expiresAt <= Date.now()) {
      this.store.delete(key);
    }
  }

  private async maybeDelayChannelGet(key: string) {
    if (key.endsWith(":lock") || !this.nextChannelGetDelay) return;
    const delay = this.nextChannelGetDelay;
    this.nextChannelGetDelay = undefined;
    await delay.promise;
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const waitFor = async (condition: () => boolean) => {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > 500) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
};

describe("RedisChannelStorage", () => {
  let client: MockRedisClient;
  let storage: RedisChannelStorage;

  beforeEach(() => {
    client = new MockRedisClient();
    storage = new RedisChannelStorage({
      client,
      keyPrefix: "test:x402",
      lockRetryIntervalMs: 1,
    });
  });

  it("returns undefined when no channel exists", async () => {
    expect(await storage.get(CHANNEL_ID)).toBeUndefined();
  });

  it("stores and retrieves a channel", async () => {
    const channel = buildSession({ chargedCumulativeAmount: "1000" });
    await storage.updateChannel(CHANNEL_ID, () => channel);
    expect(await storage.get(CHANNEL_ID)).toEqual(channel);
  });

  it("treats channelId case-insensitively", async () => {
    const channel = buildSession({ chargedCumulativeAmount: "500" });
    await storage.updateChannel(CHANNEL_ID.toUpperCase(), () => channel);
    expect(await storage.get(CHANNEL_ID.toLowerCase())).toEqual(channel);
  });

  it("lists stored channels sorted by channelId", async () => {
    const id1 = "0x2222222222222222222222222222222222222222222222222222222222222222";
    const id2 = "0x1111111111111111111111111111111111111111111111111111111111111111";
    await storage.updateChannel(id1, () => buildSession({ channelId: id1 }));
    await storage.updateChannel(id2, () => buildSession({ channelId: id2 }));
    await client.set(`test:x402:server:channel:${id1}:lock`, "other");

    expect((await storage.list()).map(channel => channel.channelId)).toEqual([id2, id1]);
  });

  it("reports unchanged when the callback returns the current channel", async () => {
    const channel = buildSession({ chargedCumulativeAmount: "500" });
    await storage.updateChannel(CHANNEL_ID, () => channel);

    await expect(storage.updateChannel(CHANNEL_ID, current => current)).resolves.toEqual({
      channel,
      status: "unchanged",
    });
  });

  it("deletes a channel", async () => {
    const channel = buildSession();
    await storage.updateChannel(CHANNEL_ID, () => channel);

    await expect(storage.updateChannel(CHANNEL_ID, () => undefined)).resolves.toEqual({
      channel: undefined,
      status: "deleted",
    });
    expect(await storage.get(CHANNEL_ID)).toBeUndefined();
  });

  it("delete is a no-op when nothing is stored", async () => {
    await expect(storage.updateChannel(CHANNEL_ID, () => undefined)).resolves.toEqual({
      channel: undefined,
      status: "unchanged",
    });
  });

  it("retries concurrent updateChannel mutations after Redis compare conflicts", async () => {
    await storage.updateChannel(CHANNEL_ID, () => buildSession({ chargedCumulativeAmount: "0" }));
    const firstEvalDelay = deferred<void>();
    client.nextUpdateEvalDelay = firstEvalDelay;

    const first = storage.updateChannel(CHANNEL_ID, current =>
      buildSession({
        chargedCumulativeAmount: String(Number(current?.chargedCumulativeAmount ?? "0") + 1),
      }),
    );

    await waitFor(() => client.nextUpdateEvalDelay === undefined);

    const second = storage.updateChannel(CHANNEL_ID, current =>
      buildSession({
        chargedCumulativeAmount: String(Number(current?.chargedCumulativeAmount ?? "0") + 1),
      }),
    );

    await waitFor(() =>
      (client.store.get(`test:x402:server:channel:${CHANNEL_ID}`)?.value ?? "").includes(
        '"chargedCumulativeAmount":"1"',
      ),
    );
    firstEvalDelay.resolve();

    const results = await Promise.all([first, second]);
    expect(results.map(result => result.status)).toEqual(["updated", "updated"]);
    expect(client.updateConflicts).toBe(1);
    expect((await storage.get(CHANNEL_ID))?.chargedCumulativeAmount).toBe("2");
  });
});

describe("InMemoryClientChannelStorage", () => {
  let storage: InMemoryClientChannelStorage;

  beforeEach(() => {
    storage = new InMemoryClientChannelStorage();
  });

  it("returns undefined when no context exists", async () => {
    expect(await storage.get(CHANNEL_ID)).toBeUndefined();
  });

  it("stores and retrieves a context", async () => {
    const ctx: BatchSettlementClientContext = {
      chargedCumulativeAmount: "1000",
      balance: "10000000",
      totalClaimed: "0",
      depositAmount: "10000000",
      signedMaxClaimable: "1000",
      signature: "0xdeadbeef",
    };
    await storage.set(CHANNEL_ID, ctx);
    expect(await storage.get(CHANNEL_ID)).toEqual(ctx);
  });

  it("overwrites a context on subsequent set", async () => {
    await storage.set(CHANNEL_ID, { chargedCumulativeAmount: "1" });
    await storage.set(CHANNEL_ID, { chargedCumulativeAmount: "2" });
    const got = await storage.get(CHANNEL_ID);
    expect(got?.chargedCumulativeAmount).toBe("2");
  });

  it("deletes a context", async () => {
    await storage.set(CHANNEL_ID, { chargedCumulativeAmount: "5" });
    await storage.delete(CHANNEL_ID);
    expect(await storage.get(CHANNEL_ID)).toBeUndefined();
  });

  it("delete is a no-op when nothing is stored", async () => {
    await expect(storage.delete(CHANNEL_ID)).resolves.toBeUndefined();
  });

  it("uses keys verbatim (no normalization)", async () => {
    await storage.set(CHANNEL_ID.toUpperCase(), { chargedCumulativeAmount: "1" });
    expect(await storage.get(CHANNEL_ID.toLowerCase())).toBeUndefined();
    expect(await storage.get(CHANNEL_ID.toUpperCase())).toEqual({ chargedCumulativeAmount: "1" });
  });
});
