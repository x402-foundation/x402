import type { Channel, ChannelStorage, ChannelUpdateResult } from "./storage";

const DEFAULT_KEY_PREFIX = "x402:batch-settlement";
const DEFAULT_LOCK_RETRY_INTERVAL_MS = 10;
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
  return {1, false}
end

if operation == "set" then
  redis.call("SET", KEYS[1], nextValue)
  return {1, nextValue}
end

return {1, current or false}
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
  lockTtlMs?: number;
  lockRetryIntervalMs?: number;
  lockRenewalIntervalMs?: number;
  scanCount?: number;
};

type RedisUpdateOperation = "delete" | "keep" | "set";

type ParsedRedisUpdateResult = {
  applied: boolean;
};

/**
 * Redis-backed {@link ChannelStorage} with optimistic atomic updates.
 */
export class RedisChannelStorage implements ChannelStorage {
  private readonly client: RedisChannelStorageClient;
  private readonly keyPrefix: string;
  private readonly channelKeyPrefix: string;
  private readonly lockRetryIntervalMs: number;
  private readonly scanCount: number;

  /**
   * Creates Redis-backed server channel storage.
   *
   * @param options - Redis client and optional key/retry configuration.
   */
  constructor(options: RedisChannelStorageOptions) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.channelKeyPrefix = `${this.keyPrefix}:server:channel`;
    this.lockRetryIntervalMs = options.lockRetryIntervalMs ?? DEFAULT_LOCK_RETRY_INTERVAL_MS;
    this.scanCount = options.scanCount ?? DEFAULT_SCAN_COUNT;
  }

  /**
   * Loads a persisted channel record, if present.
   *
   * @param channelId - The channel identifier.
   * @returns Parsed channel record or `undefined` when the key is missing.
   */
  async get(channelId: string): Promise<Channel | undefined> {
    const raw = await this.client.get(this.channelKey(channelId));
    if (!raw) return undefined;
    return JSON.parse(raw) as Channel;
  }

  /**
   * Lists all stored channel records by scanning Redis keys.
   *
   * @returns Channel records sorted by channelId.
   */
  async list(): Promise<Channel[]> {
    const channels: Channel[] = [];
    for await (const keyOrKeys of this.client.scanIterator({
      MATCH: `${this.channelKeyPrefix}:*`,
      COUNT: this.scanCount,
    })) {
      const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      for (const key of keys) {
        if (key.endsWith(":lock")) continue;
        const raw = await this.client.get(key);
        if (!raw) continue;
        channels.push(JSON.parse(raw) as Channel);
      }
    }
    return channels.sort((a, b) => a.channelId.localeCompare(b.channelId));
  }

  /**
   * Atomically inspects and mutates a channel record with Redis compare-and-write retries.
   *
   * @param channelId - The channel identifier.
   * @param update - Mutation callback. Return `undefined` to delete, or `current` to leave unchanged.
   * @returns The final stored channel and whether storage updated, stayed unchanged, or deleted.
   */
  async updateChannel(
    channelId: string,
    update: (current: Channel | undefined) => Channel | undefined,
  ): Promise<ChannelUpdateResult> {
    const key = this.channelKey(channelId);
    while (true) {
      const currentRaw = await this.client.get(key);
      const current = currentRaw ? (JSON.parse(currentRaw) as Channel) : undefined;
      const next = update(current);

      if (next === current) {
        const result = await this.commitUpdate(key, currentRaw, "keep");
        if (result.applied) return { channel: current, status: "unchanged" };
        await sleep(this.lockRetryIntervalMs);
        continue;
      }

      if (!next) {
        const result = await this.commitUpdate(key, currentRaw, "delete");
        if (result.applied) {
          return { channel: undefined, status: current ? "deleted" : "unchanged" };
        }
        await sleep(this.lockRetryIntervalMs);
        continue;
      }

      const nextRaw = JSON.stringify(next);
      const result = await this.commitUpdate(key, currentRaw, "set", nextRaw);
      if (result.applied) return { channel: next, status: "updated" };
      await sleep(this.lockRetryIntervalMs);
    }
  }

  /**
   * Applies a channel mutation only if the key still contains the value that was inspected.
   *
   * @param key - Redis channel key to mutate.
   * @param expectedRaw - Raw JSON value observed before running the update callback.
   * @param operation - Mutation to apply when the observed value is still current.
   * @param nextRaw - Raw JSON value to write for set operations.
   * @returns Whether the mutation was applied.
   */
  private async commitUpdate(
    key: string,
    expectedRaw: string | null,
    operation: RedisUpdateOperation,
    nextRaw = "",
  ): Promise<ParsedRedisUpdateResult> {
    return parseRedisUpdateResult(
      await this.client.eval(UPDATE_CHANNEL_SCRIPT, {
        keys: [key],
        arguments: [expectedRaw === null ? "0" : "1", expectedRaw ?? "", operation, nextRaw],
      }),
    );
  }

  /**
   * Builds the Redis key for a stored channel record.
   *
   * @param channelId - The channel identifier.
   * @returns Redis key for the channel JSON.
   */
  private channelKey(channelId: string) {
    return `${this.channelKeyPrefix}:${channelId.toLowerCase()}`;
  }
}

/**
 * Parses the Redis script response.
 *
 * @param value - Raw response from the Redis client.
 * @returns Whether the compare-and-write applied.
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
 * @returns Promise resolved after the delay.
 */
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
