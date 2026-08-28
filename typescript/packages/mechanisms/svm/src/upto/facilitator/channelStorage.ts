import type { Network } from "@x402/core/types";

/**
 * Stored payment-channel facts used by facilitator rent cleanup.
 *
 * Only stores what the channel account refetch does not provide:
 * `payTo` (distribution preimage), `tokenProgram`, abandon-policy
 * `firstSeenAt`, voucher `expiresAt`, and `network`. Payer/payee/mint/
 * openSlot/status are read live before acting.
 *
 * Written on deposit (pre-broadcast) and claim settle; deleted when the PDA is gone.
 */
export interface UptoChannelRecord {
  channelId: string;
  /** Distribution recipient sealed at open (`requirements.payTo`). */
  payTo: string;
  tokenProgram: string;
  /** Wall-clock ms when the facilitator first stored this channel. */
  firstSeenAt: number;
  /** Client voucher expiry (Unix seconds). Never shrinks on later upserts. */
  expiresAt: number;
  network: Network;
}

/** Pluggable storage of channels the facilitator sponsors rent for. */
export interface UptoChannelStorage {
  get(channelId: string): Promise<UptoChannelRecord | undefined>;
  /**
   * Every stored record, in any order. The rent cleanup manager sorts by
   * channel id before scanning, so implementations do not have to.
   */
  list(): Promise<UptoChannelRecord[]>;
  upsert(record: UptoChannelRecord): Promise<void>;
  delete(channelId: string): Promise<void>;
}

/**
 * In-memory {@link UptoChannelStorage}. Preserves `firstSeenAt` and the
 * maximum `expiresAt` across upserts of the same `channelId`.
 */
export class InMemoryUptoChannelStorage implements UptoChannelStorage {
  private readonly channels = new Map<string, UptoChannelRecord>();

  /**
   * Look up a single stored channel.
   *
   * @param channelId - Channel PDA
   * @returns Stored record, or undefined when absent
   */
  async get(channelId: string): Promise<UptoChannelRecord | undefined> {
    return this.channels.get(channelId);
  }

  /**
   * List every stored channel record.
   *
   * @returns All stored channel records
   */
  async list(): Promise<UptoChannelRecord[]> {
    return [...this.channels.values()];
  }

  /**
   * Insert or replace a record. Keeps the earlier `firstSeenAt` and the
   * later `expiresAt` when the channel was already stored.
   *
   * @param record - Full channel storage record
   */
  async upsert(record: UptoChannelRecord): Promise<void> {
    const existing = this.channels.get(record.channelId);
    this.channels.set(record.channelId, {
      ...record,
      firstSeenAt: existing?.firstSeenAt ?? record.firstSeenAt,
      expiresAt: existing ? Math.max(existing.expiresAt, record.expiresAt) : record.expiresAt,
    });
  }

  /**
   * Remove a channel from storage.
   *
   * @param channelId - Channel PDA to remove
   */
  async delete(channelId: string): Promise<void> {
    this.channels.delete(channelId);
  }
}
