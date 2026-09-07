import type { SettlementGuard, SettlementKey } from "./types";

/**
 * Default TTL for settlement dedup entries (ms). Sized to exceed a typical
 * freshness window so a payment cannot be settled twice within its own validity.
 */
export const SETTLEMENT_TTL_MS = 10 * 60 * 1000;

/**
 * In-process settlement dedup keyed on the transaction digest. Prevents one
 * facilitator process from settling the same payment twice — the check-plus-insert
 * is synchronous, so it runs before the first `await` in settle. Not
 * cross-instance: a scaled facilitator supplies a shared `SettlementGuard`.
 */
export class SettlementCache implements SettlementGuard {
  private readonly entries = new Map<string, number>();

  /**
   * Create a settlement cache.
   *
   * @param ttlMs - Entry lifetime in milliseconds
   */
  constructor(private readonly ttlMs: number = SETTLEMENT_TTL_MS) {}

  /**
   * Returns `true` if the settlement's digest is already pending (a duplicate),
   * or `false` after recording it as newly pending.
   *
   * @param payment - The settlement identity; keyed on `digest`
   * @returns Whether the digest was already present
   */
  isDuplicate(payment: SettlementKey): boolean {
    this.prune();
    if (this.entries.has(payment.digest)) return true;
    this.entries.set(payment.digest, Date.now());
    return false;
  }

  /**
   * Remove entries older than the TTL.
   */
  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, timestamp] of this.entries) {
      if (timestamp < cutoff) this.entries.delete(key);
    }
  }
}
