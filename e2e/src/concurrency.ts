/**
 * Concurrency utilities for parallel E2E test execution.
 *
 * - Semaphore: bounds how many combos run at once.
 * - ResourceLock: async mutex keyed by arbitrary strings, used to serialize
 *   access to shared mutable network/account state across facilitator processes.
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
 * Keyed async mutex for shared resources (EVM accounts, Permit2 state, etc.).
 *
 * Parallel E2E runs multiple server+facilitator combos that may share the same
 * on-chain accounts across Go, Python, and TypeScript facilitator processes.
 * This lock serializes work that touches those accounts while leaving unrelated
 * scenarios fully parallel.
 */
export class ResourceLock {
  private locks = new Map<string, Promise<void>>();

  /**
   * Acquire the lock for a resource key. Returns a release function.
   */
  async acquire(key: string): Promise<() => void> {
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

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

  /**
   * Acquire multiple resource locks in a stable order to avoid deadlocks.
   */
  async acquireAll(keys: string[]): Promise<() => void> {
    const uniqueKeys = [...new Set(keys)].sort();
    const releases: Array<() => void> = [];
    for (const key of uniqueKeys) {
      releases.push(await this.acquire(key));
    }
    return () => {
      for (const release of releases.reverse()) {
        release();
      }
    };
  }
}
