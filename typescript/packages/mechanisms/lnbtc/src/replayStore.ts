import type { ReplayStore } from "./types";

/**
 * In-process replay store for tests and examples.
 *
 * Not compliant for production: a restart loses consumed keys, and separate
 * processes do not share it. Production deployments need a restart-durable
 * store with an atomic insert, such as a table with a unique key column.
 */
export class InMemoryReplayStore implements ReplayStore {
  private readonly entries = new Map<string, number>();

  /**
   * Records a key if absent.
   *
   * @param key - Consumption key
   * @param retainUntil - Unix seconds to retain the entry until
   * @returns Whether the key was inserted
   */
  async consume(key: string, retainUntil: number): Promise<boolean> {
    if (this.entries.has(key)) return false;
    this.entries.set(key, retainUntil);
    return true;
  }
}
