/**
 * How long a transaction is held in the duplicate settlement cache (ms).
 * Covers the Solana blockhash lifetime (~60-90s) with margin.
 */
export const SETTLEMENT_TTL_MS = 120_000;

/**
 * In-memory cache for deduplicating concurrent settlement requests.
 *
 * Because Node.js is single-threaded, no lock is required — the cache
 * check + insert must simply occur before the first `await` in the settle path.
 */
export class SettlementCache {
  private readonly entries = new Map<string, number>();

  /**
   * Returns `true` if `key` is already pending settlement (duplicate),
   * or `false` after recording it as newly pending.
   *
   * Callers should reject the settlement when this returns `true`.
   *
   * @param key - The unique identifier for the settlement (typically the base64 transaction).
   * @returns `true` if the key was already present (duplicate); `false` otherwise.
   */
  isDuplicate(key: string): boolean {
    this.prune();
    if (this.entries.has(key)) {
      return true;
    }
    this.entries.set(key, Date.now());
    return false;
  }

  /**
   * Remove entries older than the settlement TTL.
   * Leverages Map insertion-order guarantee to break early.
   */
  private prune(): void {
    const cutoff = Date.now() - SETTLEMENT_TTL_MS;
    for (const [key, timestamp] of this.entries) {
      if (timestamp < cutoff) {
        this.entries.delete(key);
      } else {
        break;
      }
    }
  }
}
