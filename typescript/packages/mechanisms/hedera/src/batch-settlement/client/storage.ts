import { normalizeChannelId } from "../utils";

/**
 * Client-side channel fields mirrored from PAYMENT-RESPONSE / recovery flows.
 */
export interface BatchSettlementClientContext {
  /** Current cumulative amount charged by the server for this channel */
  chargedCumulativeAmount?: string;
  /** Current onchain channel balance */
  balance?: string;
  /** Total claimed onchain */
  totalClaimed?: string;
  /** Latest client-signed maxClaimableAmount cap (after corrective recovery, optional) */
  signedMaxClaimable?: string;
  /** Client voucher signature for {@link signedMaxClaimable} (optional) */
  signature?: `0x${string}`;
}

export interface ClientChannelStorage {
  get(key: string): Promise<BatchSettlementClientContext | undefined>;
  set(key: string, context: BatchSettlementClientContext): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Default in-memory {@link ClientChannelStorage} (channel records do not survive process restart).
 */
export class InMemoryClientChannelStorage implements ClientChannelStorage {
  private readonly channels = new Map<string, BatchSettlementClientContext>();

  /**
   * Returns the channel record for `key` if present.
   *
   * @param key - Channel storage key (a canonical `bytes32` channel id).
   * @returns Persisted context or undefined.
   */
  async get(key: string): Promise<BatchSettlementClientContext | undefined> {
    return this.channels.get(normalizeChannelId(key));
  }

  /**
   * Stores or replaces the channel record for `key`.
   *
   * @param key - Channel storage key (a canonical `bytes32` channel id).
   * @param context - Channel fields to persist.
   * @returns Resolves when stored.
   */
  async set(key: string, context: BatchSettlementClientContext): Promise<void> {
    this.channels.set(normalizeChannelId(key), context);
  }

  /**
   * Removes the channel record for `key` if it exists.
   *
   * @param key - Channel storage key (a canonical `bytes32` channel id).
   * @returns Resolves when removed.
   */
  async delete(key: string): Promise<void> {
    this.channels.delete(normalizeChannelId(key));
  }
}
