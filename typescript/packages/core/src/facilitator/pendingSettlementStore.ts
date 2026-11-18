/**
 * TTL applied by the default in-memory {@link PendingSettlementStore}
 * implementation. A store implementation backed by a different mechanism
 * (e.g. Redis, for a multi-instance facilitator) is free to use its own TTL —
 * this constant only governs {@link InMemoryPendingSettlementStore}.
 */
export const PENDING_SETTLEMENT_TTL_MS = 5 * 60 * 1000;

/**
 * Lets a facilitator-side mechanism remember a broadcast-but-not-yet-confirmed
 * transaction hash, keyed by a deterministic identifier derived from the
 * payment payload (e.g. an EIP-3009/Permit2 signature, or an SVM message
 * hash/channel id). When a settle attempt's receipt/confirmation wait fails,
 * the mechanism stores the broadcast hash here before returning a
 * `settlement_pending` error. On a subsequent settle attempt for the same
 * payload (typically the resource server's single automatic retry — see
 * `x402ResourceServer.settlePayment`), the mechanism checks this store first
 * and, on a hit, reconciles against the already-broadcast transaction instead
 * of verifying and broadcasting a second one.
 *
 * This is an interface — not a concrete type — specifically so a
 * multi-instance facilitator (running several replicas with no session
 * affinity) can supply a shared, network-backed implementation (e.g. Redis)
 * instead of the in-memory default, which only works when a retry happens to
 * land back on the same process. Implementations must be safe for concurrent
 * use. Mechanism code must depend only on this interface, never on
 * {@link InMemoryPendingSettlementStore} directly.
 */
export interface PendingSettlementStore {
  /**
   * Returns the previously stored transaction hash for `key`, if any.
   * Returns `undefined` when there is no entry (including one that has
   * expired).
   *
   * @param key - Deterministic identifier derived from the payment payload
   * @returns The stored transaction hash, or `undefined` when absent
   */
  get(key: string): Promise<string | undefined>;

  /**
   * Records that `key`'s payment broadcast `txHash` but has not yet been
   * confirmed. A subsequent `set` for the same key overwrites the prior
   * value.
   *
   * @param key - Deterministic identifier derived from the payment payload
   * @param txHash - The broadcast transaction hash
   */
  set(key: string, txHash: string): Promise<void>;

  /**
   * Removes any pending entry for `key`, e.g. once the transaction is
   * confirmed (success) or the mechanism determines it terminally failed.
   *
   * @param key - Deterministic identifier derived from the payment payload
   */
  delete(key: string): Promise<void>;
}

/**
 * A single {@link InMemoryPendingSettlementStore} record.
 */
interface PendingSettlementEntry {
  txHash: string;
  storedAt: number;
}

/**
 * The default {@link PendingSettlementStore} implementation: a per-process
 * `Map` with lazy TTL pruning (mirrors the shape of
 * `@x402/mechanisms-svm`'s `SettlementCache`). It never performs network
 * I/O — `get` additionally prunes expired entries (O(n) in the number of
 * currently-stored entries, which stays small since entries only exist while
 * a settlement is genuinely pending), so every call adds no meaningful
 * latency to the settle hot path.
 *
 * Node.js is single-threaded, so no lock is required here. Suitable for
 * single-instance facilitators; multi-instance deployments should inject a
 * shared, network-backed {@link PendingSettlementStore} implementation
 * instead (e.g. Redis).
 */
export class InMemoryPendingSettlementStore implements PendingSettlementStore {
  private readonly entries = new Map<string, PendingSettlementEntry>();

  /**
   * Returns the previously stored transaction hash for `key`, if any.
   *
   * @param key - Deterministic identifier derived from the payment payload
   * @returns The stored transaction hash, or `undefined` when absent/expired
   */
  async get(key: string): Promise<string | undefined> {
    this.prune();
    return this.entries.get(key)?.txHash;
  }

  /**
   * Records that `key`'s payment broadcast `txHash` but has not yet been
   * confirmed.
   *
   * @param key - Deterministic identifier derived from the payment payload
   * @param txHash - The broadcast transaction hash
   */
  async set(key: string, txHash: string): Promise<void> {
    this.entries.set(key, { txHash, storedAt: Date.now() });
  }

  /**
   * Removes any pending entry for `key`.
   *
   * @param key - Deterministic identifier derived from the payment payload
   */
  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  /**
   * Returns a snapshot of the underlying map — use only in tests.
   *
   * @returns A plain object mapping each stored key to its transaction hash
   */
  entriesSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, entry] of this.entries) {
      out[key] = entry.txHash;
    }
    return out;
  }

  /**
   * Removes entries older than {@link PENDING_SETTLEMENT_TTL_MS}.
   */
  private prune(): void {
    const cutoff = Date.now() - PENDING_SETTLEMENT_TTL_MS;
    for (const [key, entry] of this.entries) {
      if (entry.storedAt < cutoff) {
        this.entries.delete(key);
      }
    }
  }
}
