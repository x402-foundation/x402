import type { Channel, ChannelLockStorage, ChannelStorage, ChannelUpdateResult } from "./channel";
import { normalizeChannelId } from "../utils";

const DEFAULT_KEY_PREFIX = "x402:batch-settlement";
const DEFAULT_LOCK_RETRY_INTERVAL_MS = 10;
const DEFAULT_MAX_UPDATE_WAIT_MS = 5_000;
const DEFAULT_SCAN_COUNT = 100;

const UPDATE_CHANNEL_SCRIPT = `
local current = redis.call("GET", KEYS[1])
local expectedExists = ARGV[1]
local expected = ARGV[2]
local operation = ARGV[3]
local nextValue = ARGV[4]

if expectedExists == "0" then
  if current ~= false then
    return {0, current}
  end
elseif current ~= expected then
  return {0, current or false}
end

if operation == "delete" then
  redis.call("DEL", KEYS[1])
  redis.call("DEL", KEYS[2])
  return {1, false}
end

if operation == "set" then
  redis.call("SET", KEYS[1], nextValue)
  return {1, nextValue}
end

return {1, current or false}
`;

const COMPARE_AND_DEL_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export type RedisEvalOptions = {
  keys: string[];
  arguments: string[];
};

export type RedisSetOptions = {
  NX?: true;
  PX?: number;
};

export type RedisScanOptions = {
  MATCH?: string;
  COUNT?: number;
};

export type RedisChannelStorageClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(script: string, options: RedisEvalOptions): Promise<unknown>;
  scanIterator(options: RedisScanOptions): AsyncIterable<string | string[]>;
};

export type RedisChannelStorageOptions = {
  client: RedisChannelStorageClient;
  keyPrefix?: string;
  /** Wall-clock budget for internal compare-and-write retries before returning `conflict`. */
  maxUpdateWaitMs?: number;
  /** Delay between Redis compare retries. */
  lockRetryIntervalMs?: number;
  scanCount?: number;
};

type RedisUpdateOperation = "delete" | "keep" | "set";

type ParsedRedisUpdateResult = {
  applied: boolean;
};

/** Redis-backed admission-lock storage. */
export class RedisChannelLockStorage implements ChannelLockStorage {
  protected readonly client: RedisChannelStorageClient;
  protected readonly keyPrefix: string;

  /**
   * Creates a Redis lock store.
   *
   * @param options - Redis client and key prefix.
   */
  constructor(options: Pick<RedisChannelStorageOptions, "client" | "keyPrefix">) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  /**
   * Acquires a per-channel admission lock with a single atomic `SET NX PX`.
   *
   * Intentionally not re-entrant: do not add a GET-then-SET PX refresh for the same
   * `pendingId`; that pattern races and can extend another holder's lock.
   *
   * @param channelId - The channel identifier.
   * @param pendingId - Request-scoped lock owner stored as the key value.
   * @param ttlMs - Lock TTL passed as `PX`.
   * @returns Whether this request now holds the lock.
   */
  async acquire(channelId: string, pendingId: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.set(this.lockKey(channelId), pendingId, {
      NX: true,
      PX: ttlMs,
    });
    return result === "OK";
  }

  /**
   * Releases the admission lock only when `pendingId` still holds it.
   *
   * @param channelId - The channel identifier.
   * @param pendingId - Request-scoped lock owner.
   */
  async release(channelId: string, pendingId: string): Promise<void> {
    await this.client.eval(COMPARE_AND_DEL_SCRIPT, {
      keys: [this.lockKey(channelId)],
      arguments: [pendingId],
    });
  }

  /**
   * Returns whether a live admission lock exists, optionally matching `pendingId`.
   *
   * @param channelId - The channel identifier.
   * @param pendingId - When set, require this request to hold the lock.
   * @returns Whether a live lock (or this request's lock) is present.
   */
  async isHeld(channelId: string, pendingId?: string): Promise<boolean> {
    const current = await this.client.get(this.lockKey(channelId));
    if (!current) return false;
    return pendingId === undefined || current === pendingId;
  }

  /**
   * Returns the Redis key for a channel admission lock.
   *
   * @param channelId - Channel identifier.
   * @returns Redis lock key.
   */
  protected lockKey(channelId: string): string {
    return `${this.keyPrefix}:server:lock:${normalizeChannelId(channelId)}`;
  }
}

/** Redis-backed channel storage with optimistic atomic updates. */
export class RedisChannelStorage<T extends Channel = Channel>
  extends RedisChannelLockStorage
  implements ChannelStorage<T>
{
  private readonly channelKeyPrefix: string;
  private readonly lockRetryIntervalMs: number;
  private readonly maxUpdateWaitMs: number;
  private readonly scanCount: number;

  /**
   * Creates Redis-backed channel storage.
   *
   * @param options - Redis client and storage options.
   */
  constructor(options: RedisChannelStorageOptions) {
    super(options);
    this.channelKeyPrefix = `${this.keyPrefix}:server:channel`;
    this.lockRetryIntervalMs = options.lockRetryIntervalMs ?? DEFAULT_LOCK_RETRY_INTERVAL_MS;
    this.maxUpdateWaitMs = options.maxUpdateWaitMs ?? DEFAULT_MAX_UPDATE_WAIT_MS;
    this.scanCount = options.scanCount ?? DEFAULT_SCAN_COUNT;
  }

  /**
   * Loads a persisted channel record, if present.
   *
   * @param channelId - The channel identifier.
   * @returns Parsed channel record or `undefined` when the key is missing.
   */
  async get(channelId: string): Promise<T | undefined> {
    const raw = await this.client.get(this.channelKey(channelId));
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  }

  /**
   * Lists all stored channel records by scanning Redis keys.
   *
   * @returns Channel records sorted by channelId.
   */
  async list(): Promise<T[]> {
    const channels: T[] = [];
    for await (const keyOrKeys of this.client.scanIterator({
      MATCH: `${this.channelKeyPrefix}:*`,
      COUNT: this.scanCount,
    })) {
      const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      for (const key of keys) {
        if (key.endsWith(":lock")) continue;
        const raw = await this.client.get(key);
        if (!raw) continue;
        channels.push(JSON.parse(raw) as T);
      }
    }
    return channels.sort((a, b) => a.channelId.localeCompare(b.channelId));
  }

  /**
   * Atomically inspects and mutates a channel record with Redis compare-and-write retries.
   *
   * Retries contested compare-and-write until `maxUpdateWaitMs` elapses, then returns
   * `{ status: "conflict" }`. A successful delete also drops the admission lock key.
   *
   * @param channelId - The channel identifier.
   * @param update - Mutation callback. Return `undefined` to delete, or `current` to leave unchanged.
   * @returns The final stored channel and whether storage updated, stayed unchanged, deleted, or conflicted.
   */
  async updateChannel(
    channelId: string,
    update: (current: T | undefined) => T | undefined,
  ): Promise<ChannelUpdateResult<T>> {
    const key = this.channelKey(channelId);
    const deadline = Date.now() + this.maxUpdateWaitMs;

    while (true) {
      const currentRaw = await this.client.get(key);
      const current = currentRaw ? (JSON.parse(currentRaw) as T) : undefined;
      const next = update(current);

      if (next === current) {
        const result = await this.commitUpdate(channelId, currentRaw, "keep");
        if (result.applied) return { channel: current, status: "unchanged" };
      } else if (!next) {
        const result = await this.commitUpdate(channelId, currentRaw, "delete");
        if (result.applied) {
          return { channel: undefined, status: current ? "deleted" : "unchanged" };
        }
      } else {
        const nextRaw = JSON.stringify(next);
        const result = await this.commitUpdate(channelId, currentRaw, "set", nextRaw);
        if (result.applied) return { channel: next, status: "updated" };
      }

      if (Date.now() >= deadline) {
        return { channel: current, status: "conflict" };
      }
      await sleep(this.lockRetryIntervalMs);
    }
  }

  /**
   * Applies a mutation if the inspected value is still current.
   *
   * @param channelId - Channel identifier.
   * @param expectedRaw - Previously observed value.
   * @param operation - Mutation to apply.
   * @param nextRaw - Value for set operations.
   * @returns Whether the mutation applied.
   */
  private async commitUpdate(
    channelId: string,
    expectedRaw: string | null,
    operation: RedisUpdateOperation,
    nextRaw = "",
  ): Promise<ParsedRedisUpdateResult> {
    return parseRedisUpdateResult(
      await this.client.eval(UPDATE_CHANNEL_SCRIPT, {
        keys: [this.channelKey(channelId), this.lockKey(channelId)],
        arguments: [expectedRaw === null ? "0" : "1", expectedRaw ?? "", operation, nextRaw],
      }),
    );
  }

  /**
   * Returns the Redis key for a channel record.
   *
   * @param channelId - Channel identifier.
   * @returns Redis channel key.
   */
  private channelKey(channelId: string) {
    return `${this.channelKeyPrefix}:${normalizeChannelId(channelId)}`;
  }
}

/**
 * Validates the Redis compare-and-write response.
 *
 * @param value - Raw script response.
 * @returns Parsed update result.
 */
function parseRedisUpdateResult(value: unknown): ParsedRedisUpdateResult {
  if (!Array.isArray(value) || value.length < 1) {
    throw new Error("Unexpected Redis update response");
  }

  const [applied, raw] = value;
  if (applied !== 0 && applied !== 1) {
    throw new Error("Unexpected Redis update status");
  }

  if (raw !== false && raw !== null && raw !== undefined && typeof raw !== "string") {
    throw new Error("Unexpected Redis update value");
  }

  return { applied: applied === 1 };
}

/**
 * Resolves after the requested delay.
 *
 * @param ms - Delay in milliseconds.
 * @returns A promise resolved after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
