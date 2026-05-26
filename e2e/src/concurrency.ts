/**
 * Concurrency utilities for parallel E2E test execution.
 *
 * - Semaphore: bounds how many combos run at once.
 * - FacilitatorLock: async mutex keyed by facilitator name, used to serialize
 *   EVM tests through the same facilitator (prevents nonce collisions).
 */

/**
 * Counting semaphore that limits concurrent async operations.
 */
export class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return () => this.release();
    }

    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.permits--;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.permits++;
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }
}

/**
 * Per-facilitator async mutex for EVM tests.
 *
 * EVM transactions use `PendingNonceAt()` — two concurrent EVM tests routed
 * through the same facilitator will get the same nonce and one will fail.
 * This lock serializes EVM tests per facilitator while allowing SVM tests
 * (which use blockhash + random memo) to proceed freely.
 */
export class FacilitatorLock {
  private locks = new Map<string, Promise<void>>();

  /**
   * Acquire the EVM lock for a facilitator. Returns a release function.
   * Only call this for EVM tests — SVM tests should skip locking entirely.
   */
  async acquire(facilitatorName: string): Promise<() => void> {
    const key = `evm:${facilitatorName}`;

    // Wait for the current holder (if any) to finish
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    // Set up our own lock
    let releaseFn: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    this.locks.set(key, lockPromise);

    return () => {
      this.locks.delete(key);
      releaseFn!();
    };
  }
}
