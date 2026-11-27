import type { SettlementGuard, SettlementKey } from "./types";

/**
 * In-process settlement guard, and the facilitator's default. Successful claims
 * are kept as long as {@link SettlementGuard} requires. Not shared across
 * processes and lost on restart, so it suits only development, tests, or a
 * single process that accepts repeat-settlement risk. Production SHOULD use a
 * shared, durable {@link SettlementGuard} with atomic claims.
 */
export class SettlementCache implements SettlementGuard {
  private readonly entries = new Map<string, { network: string; maxEpoch: bigint }>();
  private readonly latestEpoch = new Map<string, bigint>();

  /**
   * Claim a key. The check and insert are synchronous, so concurrent settles of
   * the same transaction cannot both claim it.
   *
   * @param key - The settlement identity
   * @returns `true` if claimed, `false` if already held
   */
  claim(key: SettlementKey): boolean {
    const id = cacheKey(key);
    if (this.entries.has(id)) return false;
    this.entries.set(id, { network: key.network, maxEpoch: BigInt(key.maxEpoch) });
    return true;
  }

  /**
   * Drop a claim so the transaction can be settled again.
   *
   * @param key - The settlement identity
   */
  release(key: SettlementKey): void {
    this.entries.delete(cacheKey(key));
  }

  /**
   * Record the network's current epoch, and drop claims that no longer need to
   * be kept (see {@link SettlementGuard}).
   *
   * @param network - The CAIP-2 network id
   * @param epoch - The current epoch reported by the network
   */
  observeEpoch(network: string, epoch: string | bigint): void {
    const observed = BigInt(epoch);
    const previous = this.latestEpoch.get(network);
    if (previous !== undefined && observed <= previous) return;
    this.latestEpoch.set(network, observed);
    for (const [id, entry] of this.entries) {
      if (entry.network === network && entry.maxEpoch + 1n < observed) this.entries.delete(id);
    }
  }
}

/**
 * The map key for a settlement: network and digest.
 *
 * @param key - The settlement identity
 * @returns The map key
 */
function cacheKey(key: SettlementKey): string {
  return `${key.network}:${key.digest}`;
}
