import type { PaymentRequirements } from "@x402/core/types";

/**
 * One issued Masumi 402, keyed by the `termsDigest` the seller signed.
 *
 * The digest binds every value the buyer pays against, so a record is the
 * authoritative copy of a quote: a paid retry must present exactly these
 * requirements, and only the first transaction may claim them.
 */
export interface MasumiTerms {
  termsDigest: string;
  /** Requirements exactly as served in the 402. */
  requirements: PaymentRequirements;
  /** Canonical transaction id bound to these terms by the first paid retry. */
  claimedTxHash?: string;
}

export interface MasumiTermsUpdateResult {
  terms: MasumiTerms | undefined;
  status: "updated" | "unchanged" | "deleted";
}

export interface MasumiTermsStorage {
  get(termsDigest: string): Promise<MasumiTerms | undefined>;

  /**
   * Atomically inspects and mutates one terms record.
   *
   * Implementations must guarantee that no concurrent mutation can interleave
   * between reading `current` and writing the callback result for all
   * application instances that share the backend. The in-memory backend only
   * provides this guarantee inside one JS runtime; production multi-instance
   * deployments need storage with backend-level atomic conditional mutation,
   * such as Redis/Valkey Lua scripts, SQL transactions, or Durable Objects.
   *
   * @param termsDigest - The Masumi terms digest.
   * @param update - Mutation callback. Return `undefined` to delete, or `current` to leave unchanged.
   * @returns The final stored record and whether storage updated, stayed unchanged, or deleted.
   */
  updateTerms(
    termsDigest: string,
    update: (current: MasumiTerms | undefined) => MasumiTerms | undefined,
  ): Promise<MasumiTermsUpdateResult>;
}

export interface InMemoryMasumiTermsStorageOptions {
  /**
   * Maximum retained quotes. The oldest issued record is evicted first, so a
   * long-running process cannot grow without bound on an anonymous endpoint.
   */
  maxEntries?: number;
}

/** Default retained quotes for {@link InMemoryMasumiTermsStorage}. */
export const DEFAULT_MASUMI_TERMS_STORAGE_ENTRIES = 10_000;

/**
 * Process-local {@link MasumiTermsStorage} keyed by `termsDigest`.
 *
 * Suitable for tests and single-process development servers. Quotes are lost
 * on restart and are not shared between workers, so a production deployment
 * must supply a durable implementation.
 */
export class InMemoryMasumiTermsStorage implements MasumiTermsStorage {
  private readonly terms = new Map<string, MasumiTerms>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly maxEntries: number;

  /**
   * Creates a bounded in-memory quote store.
   *
   * @param options - Capacity settings.
   */
  constructor(options: InMemoryMasumiTermsStorageOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MASUMI_TERMS_STORAGE_ENTRIES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("maxEntries must be a positive safe integer");
    }
    this.maxEntries = maxEntries;
  }

  /**
   * Returns the stored quote for a terms digest, if present.
   *
   * @param termsDigest - The Masumi terms digest.
   * @returns The stored record, or undefined when unknown.
   */
  async get(termsDigest: string): Promise<MasumiTerms | undefined> {
    return this.terms.get(termsDigest);
  }

  /**
   * Atomically inspects and mutates one record while holding a per-digest lock.
   *
   * @param termsDigest - The Masumi terms digest.
   * @param update - Mutation callback. Return `undefined` to delete, or `current` to leave unchanged.
   * @returns The final stored record and whether storage updated, stayed unchanged, or deleted.
   */
  async updateTerms(
    termsDigest: string,
    update: (current: MasumiTerms | undefined) => MasumiTerms | undefined,
  ): Promise<MasumiTermsUpdateResult> {
    return this.withLock(termsDigest, async () => {
      const current = this.terms.get(termsDigest);
      const next = update(current);

      if (next === current) {
        return { terms: current, status: "unchanged" as const };
      }
      if (!next) {
        this.terms.delete(termsDigest);
        return {
          terms: undefined,
          status: current ? ("deleted" as const) : ("unchanged" as const),
        };
      }

      this.terms.set(termsDigest, next);
      // Map preserves insertion order, so the first key is the oldest quote.
      while (this.terms.size > this.maxEntries) {
        const oldest = this.terms.keys().next().value as string | undefined;
        if (oldest === undefined || oldest === termsDigest) break;
        this.terms.delete(oldest);
      }
      return { terms: next, status: "updated" as const };
    });
  }

  /**
   * Runs `fn` after any prior locked work for the same digest has finished.
   *
   * @param key - Terms digest used as the lock key.
   * @param fn - Async work to run while holding the logical per-digest lock.
   * @returns The resolved result of `fn`.
   */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const next = previous.catch(() => {}).then(() => current);
    this.locks.set(key, next);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === next) {
        this.locks.delete(key);
      }
    }
  }
}
