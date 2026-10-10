/**
 * In-memory TTL cache for Lightning payment_hash deduplication.
 *
 * Prevents replay attacks where a client resubmits a previously-settled invoice.
 * TTL is set to invoice expiry + SETTLEMENT_TTL_BUFFER_MS to cover the full
 * window in which a duplicate could arrive.
 *
 * For production deployments with multiple server instances, replace this with
 * a shared cache (Redis, etc.) implementing the same interface.
 */
export interface SettlementCache {
  isSettled(paymentHash: string): boolean;
  markSettled(paymentHash: string, ttlMs: number): void;
}

export function createInMemorySettlementCache(): SettlementCache {
  const store = new Map<string, number>();

  function purgeExpired() {
    const now = Date.now();
    for (const [key, expiresAt] of store) {
      if (now > expiresAt) store.delete(key);
    }
  }

  return {
    isSettled(paymentHash: string): boolean {
      purgeExpired();
      const expiresAt = store.get(paymentHash);
      return expiresAt !== undefined && Date.now() <= expiresAt;
    },
    markSettled(paymentHash: string, ttlMs: number): void {
      store.set(paymentHash, Date.now() + ttlMs);
    },
  };
}
