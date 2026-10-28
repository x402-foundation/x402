import { createHash } from "node:crypto";
import { HEDERA_TRANSFER_EXECUTOR_IN_FLIGHT_TTL_MS } from "../../constants";
import type { ExactHederaTransferExecutorPayload } from "../../types";
import { normalizeHederaAccountIdentifier } from "../../utils";

/**
 * Returns the in-flight key of a `transferExecutor` payload: a hash of
 * `(network, executor, payer, authorization)` (scheme_exact_hedera.md, Verification).
 *
 * @param network - CAIP-2 network
 * @param payload - Payload with string fields
 * @returns Hex SHA-256 of the canonical encoding
 */
export function transferExecutorInFlightKey(
  network: string,
  payload: ExactHederaTransferExecutorPayload,
): string {
  // Ids are canonicalized so `0.0.0123` and `0.0.123` share a key; hex is case-insensitive.
  const fields = [
    network,
    normalizeHederaAccountIdentifier(payload.executor),
    normalizeHederaAccountIdentifier(payload.payer),
    payload.authorization.toLowerCase(),
  ];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/**
 * A settle's hold on a key. Only its holder can mark it pending or release it.
 */
export type InFlightHold = {
  readonly key: string;
};

/**
 * A held key.
 */
type InFlightEntry<Pending> = {
  hold: InFlightHold;
  acquiredAt: number;
  /**
   * What a pending settlement left for a retry, until a retry takes it.
   */
  pending?: Pending;
};

/**
 * In-memory set of payload keys being settled. A key expires
 * `HEDERA_TRANSFER_EXECUTOR_IN_FLIGHT_TTL_MS` after it was taken or last
 * renewed, even if never released. Check and insert are synchronous, so callers that acquire before
 * their first `await` need no lock.
 */
export class InFlightGuard<Pending> {
  /**
   * Held keys, in insertion order.
   */
  private readonly entries = new Map<string, InFlightEntry<Pending>>();

  /**
   * Takes a key.
   *
   * @param key - Payload key
   * @returns The hold, or undefined when the key is held and unexpired
   */
  tryAcquire(key: string): InFlightHold | undefined {
    this.prune();
    if (this.entries.has(key)) {
      return undefined;
    }
    const hold: InFlightHold = { key };
    this.entries.set(key, { hold, acquiredAt: Date.now() });
    return hold;
  }

  /**
   * Restarts a key's expiry just before its settle submits, so the key covers
   * the transaction's valid duration however long verification took. A hold
   * that lost its key takes it again, unless another settle holds it.
   *
   * @param hold - The settle's hold
   */
  renew(hold: InFlightHold): void {
    this.prune();
    const entry = this.entries.get(hold.key);
    if (entry !== undefined && entry.hold !== hold) {
      return;
    }
    // Re-inserted, so insertion order stays expiry order.
    this.entries.delete(hold.key);
    this.entries.set(hold.key, { hold, acquiredAt: Date.now() });
  }

  /**
   * Keeps a key for a pending settlement. While the hold is current, the expiry
   * stays where `tryAcquire` or `renew` set it. A settle that outlived the TTL lost its
   * key, but the transaction it broadcast may still land, so the key is taken
   * again, with a fresh expiry.
   *
   * @param hold - The settle's hold
   * @param pending - What a retry needs to finish the settlement
   */
  holdPending(hold: InFlightHold, pending: Pending): void {
    this.prune();
    const entry = this.entries.get(hold.key);
    if (entry?.hold === hold) {
      entry.pending = pending;
      return;
    }
    this.entries.delete(hold.key);
    this.entries.set(hold.key, { hold, acquiredAt: Date.now(), pending });
  }

  /**
   * Hands a pending settlement's hold to a retry. The key stays held, with its
   * expiry, but is no longer pending, so an identical concurrent settle finds
   * it in flight instead of also taking it.
   *
   * @param key - Payload key
   * @param matches - Whether the retry may take this pending settlement
   * @returns The hold, now the retry's to mark pending again or release, and
   *          what the pending settlement left; undefined when the key is not held
   *          because of a pending settlement, or `matches` refuses it
   */
  takePending(
    key: string,
    matches: (pending: Pending) => boolean,
  ): { hold: InFlightHold; pending: Pending } | undefined {
    this.prune();
    const entry = this.entries.get(key);
    const pending = entry?.pending;
    if (entry === undefined || pending === undefined || !matches(pending)) {
      return undefined;
    }
    delete entry.pending;
    return { hold: entry.hold, pending };
  }

  /**
   * Read-only check.
   *
   * @param key - Payload key
   * @returns True when the key is held and unexpired
   */
  isHeld(key: string): boolean {
    this.prune();
    return this.entries.has(key);
  }

  /**
   * Releases a hold. A key that expired and was taken by another settle stays held.
   *
   * @param hold - The settle's hold
   */
  release(hold: InFlightHold): void {
    if (this.entries.get(hold.key)?.hold === hold) {
      this.entries.delete(hold.key);
    }
  }

  /**
   * Drops expired keys.
   */
  private prune(): void {
    const cutoff = Date.now() - HEDERA_TRANSFER_EXECUTOR_IN_FLIGHT_TTL_MS;
    for (const [key, { acquiredAt }] of this.entries) {
      if (acquiredAt > cutoff) {
        // Later entries were acquired no earlier.
        break;
      }
      this.entries.delete(key);
    }
  }
}
