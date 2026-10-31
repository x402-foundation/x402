import type { ChannelConfig } from "../types";
import { normalizeChannelId } from "../utils";
import type {
  ChannelQuery,
  ChannelStoreOptions,
  QueryPage,
  SettleQuery,
  SettleTarget,
} from "./query";

export type {
  ChannelQuery,
  ChannelStoreOptions,
  QueryPage,
  SettleQuery,
  SettleTarget,
} from "./query";
export {
  matchesChannelQuery,
  queryByScan,
  queryChannels,
  querySettleTargets,
  settleQueryByScan,
  sortChannels,
} from "./query";

export interface Channel {
  channelId: string;
  channelConfig: ChannelConfig;
  chargedCumulativeAmount: string;
  signedMaxClaimable: string;
  signature: string;
  balance: string;
  totalClaimed: string;
  withdrawRequestedAt: number;
  refundNonce: number;
  onchainSyncedAt?: number;
  lastRequestTimestamp: number;
}

export interface ChannelUpdateResult<T extends Channel = Channel> {
  channel: T | undefined;
  status: "updated" | "unchanged" | "deleted" | "conflict";
}

export interface ChannelStorage<T extends Channel = Channel> {
  get(channelId: string): Promise<T | undefined>;
  list(): Promise<T[]>;
  /**
   * Atomically inspects and mutates a channel record.
   *
   * Implementations must guarantee that no concurrent mutation can interleave between
   * reading `current` and writing the callback result for all application instances that
   * share the backend. The in-memory backend only provides this guarantee inside one JS
   * runtime; production multi-instance deployments need storage with backend-level atomic
   * conditional mutation, such as Redis/Valkey Lua scripts, SQL transactions, or Durable Objects.
   *
   * @param channelId - The channel identifier.
   * @param update - Mutation callback. Return `undefined` to delete, or `current` to leave unchanged.
   * @returns The final stored channel and whether storage updated, stayed unchanged, deleted, or lost a CAS race.
   *
   * Implementations may retry compare-and-write internally. When a mutation still cannot be applied,
   * return `{ status: "conflict" }` rather than throwing. The update callback must be synchronous
   * and deterministic so retries can safely re-run on a fresher `current`.
   *
   * The compare predicate is adapter-defined: a document revision, an `expectedCharged` field check,
   * or a full-document compare are all valid; this interface does not mandate one shape.
   */
  updateChannel(
    channelId: string,
    update: (current: T | undefined) => T | undefined,
  ): Promise<ChannelUpdateResult<T>>;
  /**
   * Optional indexed worker query. Omit it and {@link queryChannels} falls back
   * to {@link queryByScan}, which dumps `list()` then filters.
   *
   * Native adapters should honour `limit` / `cursor` as read bounds. The scan
   * shim only pages after loading every row.
   *
   * @param filter - Closed named query the managers actually run.
   * @param opts - Optional per-call store options.
   * @returns One page of matching channels.
   */
  query?(filter: ChannelQuery, opts?: ChannelStoreOptions): Promise<QueryPage<T>>;
  /**
   * Optional indexed settle-target query. Omit it and {@link querySettleTargets}
   * falls back to {@link settleQueryByScan}.
   *
   * @param filter - Settle query.
   * @param opts - Optional per-call store options.
   * @returns One page of distinct claimed `(network, receiver, token)` tuples.
   */
  settleQuery?(filter: SettleQuery, opts?: ChannelStoreOptions): Promise<QueryPage<SettleTarget>>;
}

/**
 * Best-effort per-channel admission lock. Loss or unavailability degrades to
 * optimistic mode: the durable charge CAS still serializes commits.
 */
export interface ChannelLockStorage {
  /** SET NX + TTL. Value is `pendingId`. Expired keys are free. */
  acquire(channelId: string, pendingId: string, ttlMs: number): Promise<boolean>;
  /** Compare-and-delete: releases only when `pendingId` still holds. */
  release(channelId: string, pendingId: string): Promise<void>;
  /** Any live lock, or this `pendingId` when provided. */
  isHeld(channelId: string, pendingId?: string): Promise<boolean>;
}

/**
 * Rethrows lock-store implementation/parse failures so callers fail closed.
 *
 * {@link TypeError}, {@link SyntaxError}, and {@link RangeError} indicate a broken
 * backend or unreadable hold record (including corrupt File `.hold` JSON). Redis
 * lock I/O (network, timeout) is not in this set and stays optimistic: callers
 * treat the lock as absent and the charge CAS still serializes commits.
 *
 * @param err - Error from acquire, release, or isHeld.
 */
export function rethrowLockImplementationError(err: unknown): void {
  if (err instanceof TypeError || err instanceof SyntaxError || err instanceof RangeError) {
    throw err;
  }
}

/**
 * Returns whether `value` implements {@link ChannelLockStorage}.
 *
 * @param value - Storage object to inspect.
 * @returns Whether acquire/release/isHeld are present.
 */
export function isChannelLockStorage(value: object): value is ChannelLockStorage {
  return (
    "acquire" in value &&
    typeof value.acquire === "function" &&
    "release" in value &&
    typeof value.release === "function" &&
    "isHeld" in value &&
    typeof value.isHeld === "function"
  );
}

/**
 * Returns a shallow copy of a channel record.
 *
 * @param record - Stored channel record.
 * @returns A copied channel record.
 */
function cloneChannel<T extends Channel>(record: T): T {
  return { ...record };
}

/**
 * In-memory {@link ChannelStorage} backed by a Map keyed by `channelId`.
 */
export class InMemoryChannelStorage<T extends Channel = Channel>
  implements ChannelStorage<T>, ChannelLockStorage
{
  private readonly channels = new Map<string, T>();
  private readonly channelLocks = new Map<string, Promise<void>>();
  private readonly admissionLocks = new Map<string, { pendingId: string; expiresAt: number }>();

  /**
   * Returns a shallow copy of the channel record, if present.
   *
   * @param channelId - The channel identifier.
   * @returns A copy of the channel record or undefined when not found.
   */
  async get(channelId: string): Promise<T | undefined> {
    const stored = this.channels.get(normalizeChannelId(channelId));
    return stored ? cloneChannel(stored) : undefined;
  }

  /**
   * Lists shallow copies of all stored channel records.
   *
   * @returns All channel records in storage, sorted by channelId.
   */
  async list(): Promise<T[]> {
    return [...this.channels.values()]
      .map(cloneChannel)
      .sort((a, b) => a.channelId.localeCompare(b.channelId));
  }

  /**
   * Atomically inspects and mutates a channel record while holding a per-channel lock.
   *
   * `current` is a shallow copy. In-place mutation that returns `current` is a
   * no-op; persist by returning a new object.
   *
   * @param channelId - The channel identifier.
   * @param update - Mutation callback. Return `undefined` to delete, or `current` to leave unchanged.
   * @returns The final stored channel and whether storage updated, stayed unchanged, or deleted.
   */
  async updateChannel(
    channelId: string,
    update: (current: T | undefined) => T | undefined,
  ): Promise<ChannelUpdateResult<T>> {
    const key = normalizeChannelId(channelId);
    return this.withChannelLock(key, async () => {
      const stored = this.channels.get(key);
      const current = stored ? cloneChannel(stored) : undefined;
      const next = update(current);

      if (next === current) {
        return { channel: current, status: "unchanged" };
      }

      if (!next) {
        this.channels.delete(key);
        this.admissionLocks.delete(key);
        return { channel: undefined, status: stored ? "deleted" : "unchanged" };
      }

      this.channels.set(key, next);
      return { channel: next, status: "updated" };
    });
  }

  /**
   * Acquires a per-channel admission lock if none is live.
   *
   * @param channelId - The channel identifier.
   * @param pendingId - Request-scoped lock owner.
   * @param ttlMs - Lock time-to-live in milliseconds.
   * @returns Whether this request now holds the lock.
   */
  async acquire(channelId: string, pendingId: string, ttlMs: number): Promise<boolean> {
    const key = normalizeChannelId(channelId);
    const current = this.admissionLocks.get(key);
    const now = Date.now();
    if (current && current.expiresAt > now) {
      return false;
    }
    this.admissionLocks.set(key, { pendingId, expiresAt: now + ttlMs });
    return true;
  }

  /**
   * Releases the admission lock only when `pendingId` still holds it.
   *
   * @param channelId - The channel identifier.
   * @param pendingId - Request-scoped lock owner.
   */
  async release(channelId: string, pendingId: string): Promise<void> {
    const key = normalizeChannelId(channelId);
    if (this.admissionLocks.get(key)?.pendingId === pendingId) {
      this.admissionLocks.delete(key);
    }
  }

  /**
   * Returns whether a live admission lock exists, optionally matching `pendingId`.
   *
   * @param channelId - The channel identifier.
   * @param pendingId - When set, require this request to hold the lock.
   * @returns Whether a live lock (or this request's lock) is present.
   */
  async isHeld(channelId: string, pendingId?: string): Promise<boolean> {
    const key = normalizeChannelId(channelId);
    const current = this.admissionLocks.get(key);
    if (!current || current.expiresAt <= Date.now()) {
      this.admissionLocks.delete(key);
      return false;
    }
    return pendingId === undefined || current.pendingId === pendingId;
  }

  /**
   * Serializes asynchronous work for one channel key.
   *
   * @param key - Channel lock key.
   * @param fn - Work to run under the lock.
   * @returns The work result.
   */
  private async withChannelLock<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const previous = this.channelLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const next = previous.catch(() => {}).then(() => current);
    this.channelLocks.set(key, next);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.channelLocks.get(key) === next) {
        this.channelLocks.delete(key);
      }
    }
  }
}
