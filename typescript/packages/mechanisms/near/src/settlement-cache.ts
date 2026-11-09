import { DEFAULT_SETTLEMENT_TTL_MS } from "./constants";

/**
 * In-memory cache for deduplicating concurrent settlement requests (spec §10).
 *
 * NEAR's onchain access-key nonce already guarantees a delegate action lands
 * at most once, but two `/settle` calls racing before either lands could each
 * observe a "successful" outer transaction and return `success: true`. This
 * cache closes that window. It is a NEAR-flavored adaptation of the SVM
 * mitigation: same in-process-map pattern, but eviction is tied to NEAR's
 * `max_block_height` (and a TTL safety net) rather than Solana's blockhash
 * lifetime.
 *
 * Because Node.js is single-threaded, no lock is required — the check + insert
 * (`isDuplicate`) must simply occur before the first `await` in the settle path.
 * The cache holds no persistent state; restarting the facilitator clears it
 * with no correctness consequence, because the onchain nonce still prevents
 * double execution.
 */
export class SettlementCache {
  private readonly entries = new Map<string, { insertedAt: number; maxBlockHeight: bigint }>();

  /**
   * Creates a settlement cache.
   *
   * @param ttlMs - Safety-net eviction age, used only when neither
   *   `release` (receipt observed) nor `evictExpired` (`max_block_height`
   *   passed) fires for an entry.
   */
  constructor(private readonly ttlMs: number = DEFAULT_SETTLEMENT_TTL_MS) {}

  /**
   * Returns `true` if `key` is already being settled (duplicate); otherwise
   * records it as pending and returns `false`.
   *
   * Callers MUST reject the settlement when this returns `true`, and MUST call
   * this synchronously before the first `await` in the settle path.
   *
   * @param key - Hash of the exact `signedDelegateAction` bytes (spec §10).
   * @param maxBlockHeight - The delegate action's `max_block_height`, used as a
   *   chain-aware eviction bound.
   * @returns `true` if the key was already pending (duplicate); `false` otherwise.
   */
  isDuplicate(key: string, maxBlockHeight: bigint): boolean {
    this.pruneByTtl();
    if (this.entries.has(key)) {
      return true;
    }
    this.entries.set(key, { insertedAt: Date.now(), maxBlockHeight });
    return false;
  }

  /**
   * Evicts a key once its inner `ft_transfer` receipt outcome is authoritatively
   * known (spec §10 eviction trigger). Safe to call in a `finally` block.
   *
   * @param key - The key previously inserted by `isDuplicate`.
   */
  release(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Evicts entries whose delegate window has passed — i.e. the delegate action
   * can no longer land (spec §10 eviction trigger).
   *
   * @param currentBlockHeight - The current final block height.
   */
  evictExpired(currentBlockHeight: bigint): void {
    for (const [key, entry] of this.entries) {
      if (entry.maxBlockHeight < currentBlockHeight) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Removes entries older than the TTL safety net.
   */
  private pruneByTtl(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.insertedAt < cutoff) {
        this.entries.delete(key);
      }
    }
  }
}
