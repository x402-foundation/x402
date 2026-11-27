/* eslint-disable jsdoc/require-jsdoc */
import {
  address,
  getBase64Codec,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import type { PendingSettlementStore } from "@x402/core/facilitator";
import type { Network, PaymentRequirements, SettleResponse } from "@x402/core/types";

import { findAssociatedTokenPda } from "@solana-program/token-2022";

import { SLOT_COMMITMENT } from "../../payment-channels/commitments";
import type { Channel } from "../../payment-channels/generated/accounts/channel";
import type { ChannelStatus } from "../../payment-channels/onchain";
import { OPEN_SLOT_WINDOW, parseU64 } from "../../payment-channels/open";
import type { BatchFacilitatorSigner } from "../../payment-channels/signer";
import type { FacilitatorConfirmedTransaction, FacilitatorTokenBalance } from "../../signer";
import type { BatchChannelConfig } from "../types";
import { ALL_CHANNEL_STATUSES, closedFailure } from "./responses";
import type { BatchTerms } from "./types";

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
  Map<string, Promise<SettleResponse>>
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
 * Thrown when a confirmed sweep, seal or cooperative refund cannot be
 * attributed from balance evidence because the merchant recipient is also the
 * refund or treasury beneficiary of a closed channel, or, with a cause, because
 * the visible transaction does not carry the balances the payout is read from.
 * The transaction landed; only its accounting is unresolved, so it is reported
 * with its own reason rather than left pending.
 */
export class PayoutAttributionAmbiguousError extends Error {
  constructor(cause?: unknown) {
    super(
      cause === undefined
        ? "closed-channel payout shares its recipient with refund or treasury; transfer attribution is ambiguous"
        : `confirmed payout cannot be attributed: ${cause instanceof Error ? cause.message : String(cause)}`,
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
  signer: Pick<BatchFacilitatorSigner, "isBlockhashValid" | "getConfirmedTransaction">,
  signature: string,
  network: string,
  wire: string | undefined,
): Promise<boolean> {
  if (!wire || !signer.isBlockhashValid) return false;
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

/**
 * Whether `network`'s current slot is past `openSlot + OPEN_SLOT_WINDOW`, when
 * a channel PDA can have been deallocated (and can no longer be opened).
 * `slotCache` avoids repeated `getSlot` calls across a batch.
 *
 * @param signer - Facilitator signer with `getSlot`
 * @param network - CAIP-2 network
 * @param openSlot - Channel's `openSlot` from `channelConfig`
 * @param slotCache - Per-request slot cache shared across a batch
 * @param slotCache.value - Cached cluster slot, populated lazily on the first absent channel
 * @returns `true` only when `currentSlot > openSlot + OPEN_SLOT_WINDOW`
 */
export async function channelPastCloseGate(
  signer: Pick<BatchFacilitatorSigner, "getSlot">,
  network: string,
  openSlot: number,
  slotCache: { value?: bigint } = {},
): Promise<boolean> {
  if (!Number.isSafeInteger(openSlot) || openSlot <= 0) return false;
  if (slotCache.value === undefined) {
    try {
      const current = await signer.getSlot(network, SLOT_COMMITMENT);
      if (typeof current !== "bigint") return false;
      slotCache.value = current;
    } catch {
      return false;
    }
  }
  return slotCache.value > BigInt(openSlot) + OPEN_SLOT_WINDOW;
}

/**
 * Read a claim or distribute batch, detecting any channel absent past
 * `open_slot + OPEN_SLOT_WINDOW` and returning a closed-channel resync failure
 * with live peer snapshots validated against the request's terms.
 *
 * @param args - Batch inputs and channel read/validation callbacks
 * @param args.network - CAIP-2 network
 * @param args.prepared - Prepared claim or distribute entries in request order
 * @param args.configOf - Extracts each entry's channel config
 * @param args.requirements - Request payment requirements
 * @param args.fetchChannelOrClosed - Reads one channel or flags it closed past the close gate
 * @param args.assertClaimChannel - Validates live channels against the request terms
 * @returns All decoded live channels, or a closed-channel resync response
 */
export async function readBatchOrClosed<T extends { channelId: string; terms: BatchTerms }>(args: {
  network: Network;
  prepared: readonly T[];
  configOf: (item: T) => BatchChannelConfig;
  requirements: PaymentRequirements;
  fetchChannelOrClosed: (
    network: string,
    channelId: string,
    openSlot: number,
    slotCache: { value?: bigint },
  ) => Promise<{ channel: Channel; closed: false } | { channel: undefined; closed: true }>;
  assertClaimChannel: (
    channel: Channel,
    config: BatchChannelConfig,
    terms: BatchTerms,
    requirements: PaymentRequirements,
    allowedStatuses: readonly ChannelStatus[],
  ) => void;
}): Promise<{ channels: Channel[] } | { response: SettleResponse }> {
  const channels: (Channel | undefined)[] = [];
  const slotCache: { value?: bigint } = {};
  let hasClosed = false;
  for (const item of args.prepared) {
    const observed = await args.fetchChannelOrClosed(
      args.network,
      item.channelId,
      args.configOf(item).openSlot,
      slotCache,
    );
    if (observed.closed) hasClosed = true;
    channels.push(observed.channel);
  }
  if (hasClosed) {
    for (let index = 0; index < args.prepared.length; index += 1) {
      const live = channels[index];
      if (!live) continue;
      const item = args.prepared[index]!;
      args.assertClaimChannel(
        live,
        args.configOf(item),
        item.terms,
        args.requirements,
        ALL_CHANNEL_STATUSES,
      );
    }
    return { response: closedFailure(args.network, args.prepared, channels) };
  }
  return { channels: channels as Channel[] };
}

/**
 * Forward a facilitator signer and record the slot from each confirmation so
 * subsequent account reads use it as `minContextSlot` without a second RPC.
 *
 * @param signer - Facilitator signer supplied to the scheme
 * @param rememberSlot - Records the highest confirmed slot seen on a network
 * @returns The same signer wrapped to record confirmation slots
 */
export function withConfirmationSlot(
  signer: BatchFacilitatorSigner,
  rememberSlot: (network: string, slot: bigint) => void,
): BatchFacilitatorSigner {
  return new Proxy(signer, {
    get: (target, property) => {
      if (property === "confirmTransaction") {
        return (
          signature: string,
          network: string,
          options?: { searchTransactionHistory?: boolean },
        ) => {
          const confirm = target.confirmTransaction.bind(target);
          const confirmation =
            options === undefined
              ? confirm(signature, network)
              : confirm(signature, network, options);
          return confirmation.then(status => {
            if (status?.slot !== undefined) rememberSlot(network, BigInt(status.slot));
            return status;
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A confirmed transaction whose pre and post token balances are visible. */
export type ConfirmedEvidence = FacilitatorConfirmedTransaction & {
  meta: {
    preTokenBalances: readonly FacilitatorTokenBalance[];
    postTokenBalances: readonly FacilitatorTokenBalance[];
  };
};

export function hasTokenBalances(
  evidence: FacilitatorConfirmedTransaction | null | undefined,
): evidence is ConfirmedEvidence {
  return Boolean(evidence?.meta?.preTokenBalances && evidence.meta.postTokenBalances);
}

/**
 * The increase of an owner's token balance of one mint across a confirmed transaction.
 *
 * @param evidence - Confirmed transaction with its token balances
 * @param owner - Owner of the token account
 * @param mint - Token mint
 * @param tokenProgram - Token program that owns the mint
 * @returns The balance increase
 */
export async function ownerBalanceChange(
  evidence: ConfirmedEvidence,
  owner: string,
  mint: string,
  tokenProgram: string,
): Promise<bigint> {
  const [account] = await findAssociatedTokenPda({
    mint: address(mint),
    owner: address(owner),
    tokenProgram: address(tokenProgram),
  });
  const index = evidence.transaction.message.accountKeys
    .map(item => (typeof item === "string" ? item : item.pubkey))
    .indexOf(account);
  if (index < 0) throw new Error("token account is absent from the transaction");
  const balanceAt = (balances: readonly FacilitatorTokenBalance[]): bigint => {
    const entry = balances.find(item => item.accountIndex === index);
    if (!entry) return 0n;
    if (entry.mint !== mint || entry.owner !== owner) throw new Error("token balance mismatch");
    return parseU64(entry.uiTokenAmount.amount, "token balance");
  };
  const change =
    balanceAt(evidence.meta.postTokenBalances) - balanceAt(evidence.meta.preTokenBalances);
  if (change < 0n) throw new Error("negative balance change");
  return change;
}
