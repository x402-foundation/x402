import { SETTLEMENT_TTL_MS } from "./constants";

/**
 * In-memory cache for deduplicating concurrent settlement requests.
 *
 * XRPL transaction submission is idempotent on the transaction hash:
 * `submitAndWait` for an already-submitted hash resolves with the same
 * `tesSUCCESS` outcome instead of failing, so every concurrent `/settle`
 * call carrying the same signed blob would otherwise report success.
 * Because Node.js is single-threaded, no lock is required — the cache
 * check + insert must simply occur before the first `await` in the
 * settle path.
 *
 * Unlike Solana, whose blockhash lifetime bounds the replay window at a
 * protocol-fixed ~60-90s, an XRPL transaction stays landable until its
 * `LastLedgerSequence`, which the scheme derives from the payment's
 * `maxTimeoutSeconds`. An entry must therefore be retained until its
 * transaction can no longer land, so callers pass a per-entry TTL sized
 * to that window; {@link SETTLEMENT_TTL_MS} is only the default floor.
 *
 * A scheme instance creates its own cache by default; pass a shared
 * instance to the constructor when several scheme instances should
 * block each other's duplicates. This is a per-process guard — a
 * horizontally scaled facilitator must back it with a shared atomic
 * store so duplicates routed to different replicas are still caught.
 */
export class SettlementCache {
  /** Maps a settlement key to the absolute time (ms epoch) it may be evicted. */
  private readonly entries = new Map<string, number>();

  /**
   * Returns `true` if `key` is already pending settlement (duplicate),
   * or `false` after recording it as newly pending.
   *
   * Callers should reject the settlement when this returns `true`.
   *
   * @param key - The unique identifier for the settlement (the signed transaction hash).
   * @param ttlMs - How long to retain the entry, in milliseconds; must cover the
   *   transaction's landable window. Defaults to {@link SETTLEMENT_TTL_MS}.
   * @returns `true` if the key was already present (duplicate); `false` otherwise.
   */
  isDuplicate(key: string, ttlMs: number = SETTLEMENT_TTL_MS): boolean {
    this.prune();
    if (this.entries.has(key)) {
      return true;
    }
    this.entries.set(key, Date.now() + ttlMs);
    return false;
  }

  /**
   * Remove entries whose retention window has elapsed. Entries carry
   * heterogeneous TTLs, so every entry is checked rather than stopping at
   * the first live one; the cache only ever holds recently-seen settlements,
   * so this stays small.
   */
  private prune(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}
