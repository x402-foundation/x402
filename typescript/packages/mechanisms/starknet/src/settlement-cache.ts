/**
 * Settlement bookkeeping for the Starknet `exact` facilitator.
 *
 * Mirrors the sibling mechanisms' `settlement-cache` module. Both maps are
 * optimizations, not the authority: the SNIP-9 nonce is the onchain replay
 * protection, and a settlement that already landed is reconciled from chain
 * state. This bookkeeping is per-process and synchronous, so a horizontally
 * scaled facilitator does not share guards between replicas; a duplicate
 * `/settle` landing on another replica is caught by the onchain nonce, which
 * makes the second broadcast revert rather than pay twice.
 */

/** Base retention for attempts and landed-tx bindings after their guard closes. */
const SETTLED_TX_TTL_SECONDS = 4 * 60 * 60;

/**
 * How far back, in time, a rescue scan can reach past its attempt record
 * (mirrors the scheme's scan margin). A landed-tx binding must not be evicted
 * while a living attempt could still scan back to its transaction, or a single
 * transfer could be credited to a second authorization once its binding died.
 */
const RESCUE_REACH_MARGIN_SECONDS = 15 * 60;

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
 * Normalize a felt to its decimal string, for use as a numeric map key.
 *
 * @param felt - The felt value
 * @returns The normalized key, or null when the value is not a felt
 */
function feltKey(felt: string): string | null {
  try {
    return BigInt(felt).toString();
  } catch {
    return null;
  }
}

/**
 * In-memory settlement bookkeeping for one facilitator instance.
 *
 * The maps are optimizations, not the authority: the SNIP-9 nonce is the
 * onchain replay protection, and it is what still holds across replicas.
 */
export class SettlementCache {
  /** (payer, nonce) → the epoch second past which the authorization cannot execute. */
  private readonly inFlight = new Map<string, number>();

  /** txHash felt → the (payer, nonce) it settles, and when it was bound. */
  private readonly settledTx = new Map<string, { key: string; at: number }>();

  /**
   * (payer, nonce) → when this facilitator first attempted to broadcast it, and
   * how long the record is kept.
   *
   * Outlives the in-flight guard so a caller that lost its success response can
   * still retry after eviction, and so the consumed-nonce rescue can require
   * that WE attempted this authorization. A settled SNIP-9 payload is public:
   * its signature is compiled into the settlement transaction's calldata, so
   * anyone who reads the chain can replay it. Caller binding means only this
   * facilitator can ever consume the nonce, so a rescue request with no local
   * attempt on record is not a retry - it is a third party presenting someone
   * else's completed payment.
   *
   * `keepUntil` is derived from the GUARD's horizon, not the attempt time: the
   * record must outlive the guard's eviction whatever window the requirements
   * advertised, or the retry that eviction exists to allow would be denied the
   * rescue. Carried on the entry itself so eviction cannot depend on the order
   * maps are swept in.
   */
  private readonly attempted = new Map<string, { at: number; keepUntil: number }>();

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
   * Whether this facilitator ever attempted to settle this authorization.
   *
   * @param key - The composite `payer:nonce` key
   * @returns True when an attempt is on record
   */
  hasAttempted(key: string): boolean {
    return this.attempted.has(key);
  }

  /**
   * When this facilitator first attempted this authorization, in epoch seconds.
   *
   * The consuming transaction cannot predate the attempt by more than the
   * authorization's own window, so this is what bounds how far back the rescue
   * has to look - a bound in TIME, which a block count only approximates.
   *
   * @param key - The composite `payer:nonce` key
   * @returns The attempt time, or undefined when none is on record
   */
  attemptedAt(key: string): number | undefined {
    return this.attempted.get(key)?.at;
  }

  /**
   * Mark an authorization as being settled, until it can no longer execute, and
   * record the attempt for the longer rescue-eligibility window.
   *
   * @param key - The composite `payer:nonce` key
   * @param heldUntilSec - Epoch second past which the guard may be evicted
   */
  hold(key: string, heldUntilSec: number): void {
    this.inFlight.set(key, heldUntilSec);
    const nowSec = Math.floor(Date.now() / 1000);
    const prior = this.attempted.get(key);
    this.attempted.set(key, {
      at: prior?.at ?? nowSec,
      keepUntil: Math.max(heldUntilSec, nowSec) + SETTLED_TX_TTL_SECONDS,
    });
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
   * Bind a landed tx to (payer, nonce). One tx may only ever settle one nonce,
   * otherwise a self-attesting account could turn a single onchain payment into
   * many free resource releases.
   *
   * Keys numerically: transaction hashes are felts, and the two sources that
   * must collide here - the hash the executor returns and the hash carried on a
   * scanned event - share no padding or case convention.
   *
   * @param txHash - The landed settlement transaction hash
   * @param payer - The payer account contract address
   * @param nonce - The SNIP-9 OutsideExecution nonce
   * @returns False if the tx is already bound to a different nonce, else true
   */
  bindTxToNonce(txHash: string, payer: string, nonce: string): boolean {
    const txKey = feltKey(txHash);
    if (txKey === null) return false;
    const key = nonceKey(payer, nonce);
    const prior = this.settledTx.get(txKey);
    if (prior !== undefined && prior.key !== key) return false;
    this.settledTx.set(txKey, { key, at: Math.floor(Date.now() / 1000) });
    return true;
  }

  /**
   * Evict guards whose authorization can no longer execute, and landed-tx
   * bindings older than the rescue scan window.
   *
   * @param nowSec - The current time in epoch seconds
   */
  evictExpired(nowSec: number): void {
    for (const [key, expiry] of this.inFlight) {
      if (expiry <= nowSec) this.inFlight.delete(key);
    }
    // Attempts live until their own keepUntil - a horizon derived from the
    // guard's expiry at hold() time, so it cannot be shortened by the order
    // this sweep deletes guards in, and survives any advertised window.
    for (const [key, entry] of this.attempted) {
      if (nowSec > entry.keepUntil) this.attempted.delete(key);
    }
    // A binding may only be evicted once NO living attempt could still scan
    // back to its transaction: the rescue reaches back to roughly its attempt
    // time minus the scan margin, so a binding is still reachable while some
    // attempt began no later than the binding plus that margin. Without this,
    // a transfer whose binding aged out could be credited a second time to a
    // near-simultaneous authorization whose attempt record survived.
    let earliestAliveAttempt = Infinity;
    for (const entry of this.attempted.values()) {
      if (entry.at < earliestAliveAttempt) earliestAliveAttempt = entry.at;
    }
    for (const [tx, { at }] of this.settledTx) {
      const expired = nowSec - at > SETTLED_TX_TTL_SECONDS;
      const reachable = earliestAliveAttempt <= at + RESCUE_REACH_MARGIN_SECONDS;
      if (expired && !reachable) this.settledTx.delete(tx);
    }
  }
}
