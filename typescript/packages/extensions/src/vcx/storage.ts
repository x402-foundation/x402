/**
 * Copyright 2026 PayPal Holdings, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Default freshness window for transactionId uniqueness checks (spec §13.1).
 * 300 seconds = 5 minutes.
 */
export const DEFAULT_NONCE_FRESHNESS_MS = 300_000;

/**
 * Storage interface for transactionId uniqueness enforcement (spec §13.1).
 *
 * The VCX server extension uses this to reject envelopes whose
 * `transactionId` has been processed within the freshness window. A
 * load-balanced verifier without shared state defeats this check —
 * production implementations must use a store consistent across the
 * deployment surface (Redis, distributed cache, etc.).
 */
export interface NonceStorage {
  /**
   * Atomically check whether the nonce has been seen within the freshness
   * window, and record it if not.
   *
   * @returns `true` if the nonce was already present (the verifier MUST
   *   reject the request), `false` if it was newly recorded.
   */
  checkAndRecord(nonce: string, freshnessWindowMs: number): Promise<boolean>;
}

/**
 * In-memory NonceStorage. Suitable for single-process deployments and tests.
 * Not suitable for production with multiple verifier instances.
 */
export class InMemoryNonceStorage implements NonceStorage {
  private readonly seen = new Map<string, number>();

  /**
   * Check whether the nonce was seen within the freshness window, recording
   * it when newly observed.
   *
   * @param nonce - The transactionId nonce to check and record.
   * @param freshnessWindowMs - How long, in milliseconds, a recorded nonce
   *   remains in effect before it is eligible for eviction.
   * @returns `true` if the nonce was already present (reject the request),
   *   `false` if it was newly recorded.
   */
  async checkAndRecord(nonce: string, freshnessWindowMs: number): Promise<boolean> {
    const now = Date.now();
    this.evictExpired(now, freshnessWindowMs);
    if (this.seen.has(nonce)) return true;
    this.seen.set(nonce, now);
    return false;
  }

  /**
   * Drop recorded nonces older than the freshness window to bound memory use.
   *
   * @param now - The current timestamp in milliseconds.
   * @param freshnessWindowMs - The freshness window in milliseconds; nonces
   *   recorded before `now - freshnessWindowMs` are evicted.
   */
  private evictExpired(now: number, freshnessWindowMs: number): void {
    const cutoff = now - freshnessWindowMs;
    for (const [nonce, recordedAt] of this.seen) {
      if (recordedAt < cutoff) this.seen.delete(nonce);
    }
  }
}

/**
 * No-op NonceStorage. Always reports the nonce as new. Used when the
 * verifier explicitly opts out of replay protection — non-conformant with
 * spec §13.1.
 */
export class NoOpNonceStorage implements NonceStorage {
  /**
   * Always report the nonce as new, performing no replay tracking.
   *
   * @returns `false` always, signalling the nonce is treated as unseen.
   */
  async checkAndRecord(): Promise<boolean> {
    return false;
  }
}

/**
 * Storage interface for `delegatedTo.conditions.maxDaily` enforcement
 * (spec §9.2). Unlike `maxPerTransaction` (a per-request comparison),
 * `maxDaily` requires stateful tracking of every settled amount for a
 * given principal+agent pair within a rolling 24-hour window.
 *
 * No default implementation is shipped: the storage surface depends
 * heavily on the deployment topology (single-process Map, Redis,
 * relational DB, etc.) and on how the verifier observes settled amounts
 * (which depends on the x402 settlement-callback wiring). Verifiers that
 * register VCX without a `DailyLimitStore` and receive a credential
 * carrying `maxDaily` will, by default, log a warning and skip the
 * check; pass `strictDelegationConditions: true` to fail-closed instead.
 */
export interface DailyLimitStore {
  /**
   * Atomically add `amount` to the rolling-window total for the given
   * principal+agent pair and return the resulting total.
   *
   * The window is 24 hours from the first-recorded amount in the window;
   * implementations MAY use a sliding window with sub-second granularity
   * or a calendar-day window aligned to the verifier's timezone. The
   * spec does not currently pin one; the v1.1 revision may.
   *
   * @returns the new total after the addition. Compare against
   *   `delegatedTo.conditions.maxDaily` (decimal string, same scale as
   *   the payment amount) to decide whether to accept the request.
   */
  addAndGetTotal(opts: { principalDid: string; agentDid: string; amount: string }): Promise<string>;
}
