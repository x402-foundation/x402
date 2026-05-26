import type { ChannelConfig } from "../types";

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
  pendingRequest?: PendingRequest;
}

export interface PendingRequest {
  pendingId: string;
  signedMaxClaimable: string;
  expiresAt: number;
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
 * In-memory {@link ChannelStorage} backed by a Map keyed by `channelId`.
 */
export class InMemoryChannelStorage implements ChannelStorage {
  private readonly channels = new Map<string, Channel>();
  private readonly channelLocks = new Map<string, Promise<void>>();

  /**
   * Returns the channel record for a channel, if present.
   *
   * @param channelId - The channel identifier.
   * @returns The channel record or undefined when not found.
   */
  async get(channelId: string): Promise<Channel | undefined> {
    return this.channels.get(channelId.toLowerCase());
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
    const key = channelId.toLowerCase();
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
