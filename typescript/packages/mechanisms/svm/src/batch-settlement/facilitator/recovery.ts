/* eslint-disable jsdoc/require-jsdoc */
import {
  getBase64Codec,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import type { PendingSettlementStore } from "@x402/core/facilitator";

import type { FacilitatorSvmSigner } from "../../signer";

/** Batch recovery records must outlive an unresolved transaction. */
export interface BatchPendingSettlementStore extends PendingSettlementStore {
  /** Atomically reserve an operation before sending. Required across processes. */
  setIfAbsent?(key: string, value: string): Promise<boolean>;
  /** Remove only this transaction, preserving a successor reserved by another worker. */
  deleteIfEquals?(key: string, value: string): Promise<boolean>;
}

/** Reference store: process-local recovery, with no eviction of unresolved work. */
export class InMemoryBatchPendingSettlementStore implements BatchPendingSettlementStore {
  private readonly records = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.records.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.records.set(key, value);
  }

  async setIfAbsent(key: string, value: string): Promise<boolean> {
    if (this.records.has(key)) return false;
    this.records.set(key, value);
    return true;
  }

  async deleteIfEquals(key: string, value: string): Promise<boolean> {
    if (this.records.get(key) !== value) return false;
    this.records.delete(key);
    return true;
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }
}

const distributionPasses = new WeakMap<
  PendingSettlementStore,
  Map<string, Promise<import("@x402/core/types").SettleResponse>>
>();

export function distributionsForStore(store: PendingSettlementStore) {
  let passes = distributionPasses.get(store);
  if (!passes) distributionPasses.set(store, (passes = new Map()));
  return passes;
}

// Coalesce before any awaits, including when two schemes share a local store.
const reservations = new WeakMap<PendingSettlementStore, Map<string, Promise<boolean>>>();

/**
 * Reserve through the store, or serialize legacy stores within this process.
 *
 * @param store - Replaceable recovery storage
 * @param key - Operation being reserved
 * @param signature - Locally derived transaction identity
 * @returns Whether this caller owns the first broadcast
 */
export async function reserveBroadcast(
  store: BatchPendingSettlementStore,
  key: string,
  signature: string,
): Promise<boolean> {
  if (store.setIfAbsent) return store.setIfAbsent(key, signature);
  let pending = reservations.get(store);
  if (!pending) reservations.set(store, (pending = new Map()));
  const previous = pending.get(key) ?? Promise.resolve(false);
  const next = previous
    .catch(() => false)
    .then(async () => {
      if (await store.get(key)) return false;
      await store.set(key, signature);
      return true;
    });
  pending.set(key, next);
  try {
    return await next;
  } finally {
    if (pending.get(key) === next) pending.delete(key);
  }
}

/**
 * Thrown when a confirmed sweep cannot be attributed from balance evidence
 * because the merchant recipient is also the refund or treasury beneficiary
 * of a closed channel. The transaction landed; only its accounting is
 * unresolved, so it is reported with its own reason rather than left pending.
 */
export class PayoutAttributionAmbiguousError extends Error {
  constructor() {
    super(
      "closed-channel payout shares its recipient with refund or treasury; transfer attribution is ambiguous",
    );
    this.name = "PayoutAttributionAmbiguousError";
  }
}

/**
 * Whether a broadcast whose confirmation was never observed can no longer
 * land. Blockhash validity is checked before the final history lookup, so a
 * transaction included right before its blockhash expired is still found and
 * stays on the reconcile path. Anything uncertain answers `false`: a
 * transaction that may have landed is never reported as failed.
 *
 * @param signer - Facilitator signer; needs `isBlockhashValid` and `getConfirmedTransaction`
 * @param signature - Recorded signature of the broadcast
 * @param network - Network it was submitted to
 * @param wire - The signed bytes that were (or would have been) sent
 * @returns `true` only when the blockhash is invalid and no record of the signature exists
 */
export async function broadcastExpiredWithoutLanding(
  signer: Pick<FacilitatorSvmSigner, "isBlockhashValid" | "getConfirmedTransaction">,
  signature: string,
  network: string,
  wire: string | undefined,
): Promise<boolean> {
  if (!wire || !signer.isBlockhashValid || !signer.getConfirmedTransaction) return false;
  try {
    const transaction = getTransactionDecoder().decode(getBase64Codec().encode(wire));
    const { lifetimeToken } = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    );
    if (await signer.isBlockhashValid(lifetimeToken, network)) return false;
    return (await signer.getConfirmedTransaction(signature, network)) === null;
  } catch {
    return false;
  }
}

/**
 * Drop the signed bytes kept for rebroadcast. Best effort: the outcome they
 * describe is already recorded elsewhere.
 *
 * @param store - Recovery storage holding the wire record
 * @param network - Network the bytes were built for
 * @param signature - Their locally derived signature
 */
export async function discardWire(
  store: PendingSettlementStore,
  network: string,
  signature: string,
): Promise<void> {
  try {
    await store.delete(`batch:transaction:${network}:${signature}:wire`);
  } catch {
    /* keep recorded outcome */
  }
}
