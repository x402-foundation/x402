/**
 * Duplicate-settlement guard for the Starknet `exact` facilitator.
 *
 * Mirrors the sibling mechanisms' `settlement-cache` module. The guard is an
 * optimization, not the authority: the SNIP-9 nonce is the onchain replay
 * protection. This bookkeeping is per-process and synchronous, so a
 * horizontally scaled facilitator does not share guards between replicas; a
 * duplicate `/settle` landing on another replica is caught by the onchain
 * nonce, which makes the second broadcast revert rather than pay twice.
 *
 * The broadcast hash of a settlement whose confirmation timed out lives
 * elsewhere: in the facilitator's `PendingSettlementStore` (from
 * `@x402/core/facilitator`), which is asynchronous and therefore CAN be backed
 * by shared storage, so the resource server's single settle retry reconciles
 * against the already-broadcast transaction whichever replica it lands on.
 */

/**
 * Compose the in-memory dedup key from payer and nonce, numerically normalized.
 *
 * @param payer - The payer account contract address
 * @param nonce - The SNIP-9 OutsideExecution nonce
 * @returns The composite `payer:nonce` key
 */
export function nonceKey(payer: string, nonce: string): string {
  return `${BigInt(payer)}:${BigInt(nonce)}`;
}

/**
 * In-memory duplicate-settlement guard for one facilitator instance.
 *
 * The guard is an optimization, not the authority: the SNIP-9 nonce is the
 * onchain replay protection, and it is what still holds across replicas.
 */
export class SettlementCache {
  /** (payer, nonce) → the epoch second past which the authorization cannot execute. */
  private readonly inFlight = new Map<string, number>();

  /**
   * Whether a settlement for this authorization is already outstanding.
   *
   * @param key - The composite `payer:nonce` key
   * @returns True when a settlement is in flight
   */
  isInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  /**
   * Mark an authorization as being settled, until it can no longer execute.
   *
   * @param key - The composite `payer:nonce` key
   * @param heldUntilSec - Epoch second past which the guard may be evicted
   */
  hold(key: string, heldUntilSec: number): void {
    this.inFlight.set(key, heldUntilSec);
  }

  /**
   * Release an authorization after a broadcast that provably consumed nothing.
   *
   * @param key - The composite `payer:nonce` key
   */
  release(key: string): void {
    this.inFlight.delete(key);
  }

  /**
   * Evict guards whose authorization can no longer execute.
   *
   * @param nowSec - The current time in epoch seconds
   */
  evictExpired(nowSec: number): void {
    for (const [key, expiry] of this.inFlight) {
      if (expiry <= nowSec) this.inFlight.delete(key);
    }
  }
}
