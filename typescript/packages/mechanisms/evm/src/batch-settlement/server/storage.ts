import type { ChannelConfig } from "../types";
import { normalizeChannelId } from "../utils";

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

export interface ChannelUpdateResult {
  channel: Channel | undefined;
  status: "updated" | "unchanged" | "deleted";
}

export interface ChannelStorage {
  get(channelId: string): Promise<Channel | undefined>;
  list(): Promise<Channel[]>;
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
   * @returns The final stored channel and whether storage updated, stayed unchanged, or deleted.
   */
  updateChannel(
    channelId: string,
    update: (current: Channel | undefined) => Channel | undefined,
  ): Promise<ChannelUpdateResult>;
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
 * In-memory {@link ChannelStorage} backed by a Map keyed by `channelId`.
 */
export class InMemoryChannelStorage implements ChannelStorage, ChannelLockStorage {
  private readonly channels = new Map<string, Channel>();
  private readonly channelLocks = new Map<string, Promise<void>>();
  private readonly admissionLocks = new Map<string, { pendingId: string; expiresAt: number }>();

  /**
   * Returns the channel record for a channel, if present.
   *
   * @param channelId - The channel identifier.
   * @returns The channel record or undefined when not found.
   */
  async get(channelId: string): Promise<Channel | undefined> {
    return this.channels.get(normalizeChannelId(channelId));
  }

  /**
   * Lists all stored channel records.
   *
   * @returns All channel records in storage.
   */
  async list(): Promise<Channel[]> {
    return [...this.channels.values()];
  }

  /**
   * Atomically inspects and mutates a channel record while holding a per-channel lock.
   *
   * @param channelId - The channel identifier.
   * @param update - Mutation callback. Return `undefined` to delete, or `current` to leave unchanged.
   * @returns The final stored channel and whether storage updated, stayed unchanged, or deleted.
   */
  async updateChannel(
    channelId: string,
    update: (current: Channel | undefined) => Channel | undefined,
  ): Promise<ChannelUpdateResult> {
    const key = normalizeChannelId(channelId);
    return this.withChannelLock(key, async () => {
      const current = this.channels.get(key);
      const next = update(current);

      if (next === current) {
        return { channel: current, status: "unchanged" };
      }

      if (!next) {
        this.channels.delete(key);
        return { channel: undefined, status: current ? "deleted" : "unchanged" };
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
   * Runs `fn` after any prior locked work for the same channel key has finished.
   *
   * @param key - Lowercased channel id used as the lock key.
   * @param fn - Async work to run while holding the logical per-channel lock.
   * @returns The resolved result of `fn`.
   */
  private async withChannelLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
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
