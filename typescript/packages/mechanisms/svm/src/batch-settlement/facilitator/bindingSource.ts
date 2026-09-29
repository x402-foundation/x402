import { isAddress } from "@solana/kit";
import type {
  FacilitatorContext,
  Network,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";

import type { PaymentChannelStorage } from "../../payment-channels/storage";
import type { BatchPendingSettlementStore } from "./recovery";

import { BatchError } from "../errors";
import { readReceiverBindingFromOpen } from "../receiverBinding";
import type { BatchDelegatedReceiverAuth, BatchDelegatedSettleContext } from "./delegatedAuthStore";
import {
  BatchReceiverAuthorizerConflictError,
  type BatchReceiverAuthorizerStore,
} from "./receiverAuthorizerStore";
import type {
  BatchReceiverBindingHistoryReader,
  BatchReceiverBindingHistorySignature,
  BindingSourceConfig,
} from "./types";
import { BINDING_HISTORY_PAGE_LIMIT } from "./constants";

/** Optional configuration for the batch-settlement SVM facilitator. */
export interface BatchSvmFacilitatorConfig {
  /**
   * Durable record of pending signatures and completed operation outcomes, so
   * retries — including after a restart — reconcile instead of rebroadcasting.
   * Defaults to an in-memory store. Production deployments should supply a
   * shared durable store whose TTL covers their client retry window.
   */
  pendingSettlementStore?: BatchPendingSettlementStore | undefined;
  /** Called before completing a payout; implementations must deduplicate by transaction. */
  onDistributionConfirmed?: (
    response: SettleResponse,
    requirements: PaymentRequirements,
  ) => Promise<void>;
  /** Shared, facilitator-owned lifecycle index used for rent cleanup. */
  channelStorage?: PaymentChannelStorage | undefined;
  /**
   * Idle window advertised as `extra.maxIdleSecs`: seconds without
   * facilitator-visible lifecycle activity after which rent cleanup MAY
   * abandon-close an Open channel at its settled watermark. `0` disables and
   * is not advertised. Defaults to `DEFAULT_MAX_IDLE_SECS` (seven days).
   */
  maxIdleSecs?: number | undefined;
  maxPriorityFeeMicroLamports?: number | undefined;
  maxComputeUnits?: number | undefined;
  maxRequiredSignatures?: number | undefined;
  /**
   * Receiver authorizer each channel was opened for. Required unless
   * {@link receiverBindingHistoryReader} is set. When this is the only source,
   * the open is bound and read back before broadcast, and a failed write does
   * not send the transaction. When a history reader is also set, a failed
   * write still broadcasts. A missing row is resolved from that reader and
   * written back here.
   */
  receiverAuthorizerStore?: BatchReceiverAuthorizerStore | undefined;
  /**
   * Explicit full-history reader of the open transaction's binding memo.
   * Used only when set here: the facilitator does not adopt one from the
   * signer or a public RPC. Used when the store misses, and as the only
   * record when no store is configured. Configuring both is allowed: the
   * store is primary, a failed store write still broadcasts the open, and
   * the history reader is the fallback plus the source for write-back.
   */
  receiverBindingHistoryReader?: BatchReceiverBindingHistoryReader | undefined;
  /**
   * Opt in to facilitator-delegated close authorization. Advertised as
   * `/supported` `extra.receiverAuthorizer`. The caller identity is kept only
   * in {@link BatchDelegatedReceiverAuth.identityStore}; losing it fails
   * closed and the client falls back to `request_close`.
   */
  delegatedReceiverAuth?: BatchDelegatedReceiverAuth | undefined;
}

/**
 * Require a store or an explicit history reader, and reject a value that lacks its methods.
 *
 * @param config - Facilitator configuration
 */
export function assertBindingSource(config: BindingSourceConfig): void {
  const store = config.receiverAuthorizerStore;
  const historyReader = config.receiverBindingHistoryReader;
  if (store !== undefined && !isReceiverAuthorizerStore(store)) {
    throw new Error("receiverAuthorizerStore must implement bind, get, and delete");
  }
  if (historyReader !== undefined && !isReceiverBindingHistoryReader(historyReader)) {
    throw new Error(
      "receiverBindingHistoryReader must implement getSignaturesForAddress and getTransaction",
    );
  }
  if (store === undefined && historyReader === undefined) {
    throw new Error(
      "BatchSvmScheme requires a receiverAuthorizerStore or a receiverBindingHistoryReader",
    );
  }
}

/**
 * Require the delegated-auth callbacks when the option is set.
 *
 * @param delegated - Delegated receiver-authorizer config, when opted in
 * @returns The same config, or undefined when delegation is off
 */
export function assertDelegatedReceiverAuth(
  delegated: BatchDelegatedReceiverAuth | undefined,
): BatchDelegatedReceiverAuth | undefined {
  if (delegated === undefined) return undefined;
  if (
    !isAddress(delegated.receiverAuthorizer) ||
    typeof delegated.resolveCallerIdentity !== "function"
  ) {
    throw new Error(
      "delegatedReceiverAuth requires a receiverAuthorizer address and resolveCallerIdentity",
    );
  }
  const store = delegated.identityStore;
  if (
    !store ||
    typeof store.bind !== "function" ||
    typeof store.get !== "function" ||
    typeof store.delete !== "function"
  ) {
    throw new Error("delegatedReceiverAuth.identityStore must implement bind, get, and delete");
  }
  return delegated;
}

/**
 * Receiver authorizer bound to a channel: the store, then the open
 * transaction. A store hit is not re-read. A history read is written back
 * when a store is configured.
 *
 * @param store - Binding store, when configured
 * @param historyReader - Full-history open reader, when configured
 * @param network - CAIP-2 network the channel was opened on
 * @param channelId - Channel PDA
 * @returns The bound key, or undefined when neither source has it
 */
export async function readReceiverAuthorizer(
  store: BatchReceiverAuthorizerStore | undefined,
  historyReader: BatchReceiverBindingHistoryReader | undefined,
  network: Network,
  channelId: string,
): Promise<string | undefined> {
  const stored = store ? (await store.get(network, channelId))?.receiverAuthorizer : undefined;
  if (stored !== undefined) return stored;
  if (!historyReader) return undefined;
  const fromHistory = await readBindingFromHistory(historyReader, network, channelId);
  if (fromHistory === undefined) return undefined;
  if (store) {
    try {
      await store.bind({ channelId, network, receiverAuthorizer: fromHistory });
    } catch (error) {
      if (error instanceof BatchReceiverAuthorizerConflictError) {
        throw new Error(`${BatchError.RECEIVER_AUTHORIZER_MISMATCH}: ${error.message}`);
      }
      throw error;
    }
  }
  return fromHistory;
}

/**
 * Caller identity for a delegated open, required before broadcast.
 *
 * @param delegated - Delegated receiver-authorizer config, when opted in
 * @param receiverAuthorizer - Key the open is binding
 * @param channelId - Channel PDA
 * @param payer - Channel payer
 * @param requirements - Payment requirements for the open
 * @param context - Facilitator extensions
 * @returns The identity, or undefined when this open is not delegated
 */
export async function delegatedIdentityForOpen(
  delegated: BatchDelegatedReceiverAuth | undefined,
  receiverAuthorizer: string,
  channelId: string,
  payer: string,
  requirements: PaymentRequirements,
  context?: FacilitatorContext,
): Promise<string | undefined> {
  if (!delegated || receiverAuthorizer !== delegated.receiverAuthorizer) return undefined;
  const identity = await resolveDelegatedIdentity(delegated, {
    channelId,
    facilitatorContext: context,
    network: requirements.network,
    payer,
    step: "deposit",
  });
  if (!identity) {
    throw new Error(
      `${BatchError.DELEGATED_UNAUTHENTICATED}: caller identity is required to open a delegated channel`,
    );
  }
  return identity;
}

/**
 * Whether `bound` is the key this facilitator advertises for delegated closes.
 *
 * @param delegated - Delegated receiver-authorizer config, when opted in
 * @param bound - Receiver authorizer bound to the channel
 * @returns True when a delegated close must match the stored caller identity
 */
export function isDelegatedAuthorizer(
  delegated: BatchDelegatedReceiverAuth | undefined,
  bound: string,
): boolean {
  return delegated?.receiverAuthorizer === bound;
}

/**
 * Resolve a delegated settle's caller identity. Throws and empty results are
 * unauthenticated.
 *
 * @param delegated - Delegated receiver-authorizer config, when opted in
 * @param ctx - Settle context passed to the operator resolver
 * @returns Stable identity, or undefined when the caller is unauthenticated
 */
export async function resolveDelegatedIdentity(
  delegated: BatchDelegatedReceiverAuth | undefined,
  ctx: BatchDelegatedSettleContext,
): Promise<string | undefined> {
  const resolve = delegated?.resolveCallerIdentity;
  if (!resolve) return undefined;
  try {
    const identity = await resolve(ctx);
    if (typeof identity !== "string" || identity.length === 0) return undefined;
    return identity;
  } catch {
    return undefined;
  }
}

/**
 * Identity recorded for a delegated channel.
 *
 * @param delegated - Delegated receiver-authorizer config, when opted in
 * @param network - CAIP-2 network the channel was opened on
 * @param channelId - Channel PDA
 * @returns Stored identity, or undefined when this facilitator has no row
 */
export async function storedDelegatedIdentity(
  delegated: BatchDelegatedReceiverAuth | undefined,
  network: Network,
  channelId: string,
): Promise<string | undefined> {
  const store = delegated?.identityStore;
  if (!store) return undefined;
  return (await store.get(network, channelId))?.callerIdentity;
}

/**
 * Sum the still-undistributed settled amount across channels.
 *
 * @param channels - Settled and already-paid watermarks
 * @returns Atomic units still owed to recipients
 */
export function calculateDistributionAmount(
  channels: readonly { payoutWatermark: bigint; settled: bigint }[],
): bigint {
  return channels.reduce((total, channel) => {
    if (channel.payoutWatermark > channel.settled) {
      throw new Error(`${BatchError.CHANNEL_STATE}: payout watermark exceeds settled amount`);
    }
    return total + channel.settled - channel.payoutWatermark;
  }, 0n);
}

/**
 * Page channel signatures back to the oldest successful transaction and
 * return the binding memo on its open.
 *
 * @param historyReader - Full-history open reader
 * @param network - CAIP-2 network the channel was opened on
 * @param channelId - Channel PDA
 * @returns The bound key, or undefined when no open carries exactly one
 */
async function readBindingFromHistory(
  historyReader: BatchReceiverBindingHistoryReader,
  network: Network,
  channelId: string,
): Promise<string | undefined> {
  const pages: BatchReceiverBindingHistorySignature[][] = [];
  let before: string | undefined;
  for (;;) {
    const page = await historyReader.getSignaturesForAddress(network, channelId, {
      limit: BINDING_HISTORY_PAGE_LIMIT,
      ...(before !== undefined ? { before } : {}),
    });
    if (page.length === 0) break;
    pages.push(page);
    const oldest = page[page.length - 1];
    if (!oldest || page.length < BINDING_HISTORY_PAGE_LIMIT) break;
    before = oldest.signature;
  }
  for (let pageIndex = pages.length - 1; pageIndex >= 0; pageIndex -= 1) {
    const page = pages[pageIndex];
    if (!page) continue;
    for (let index = page.length - 1; index >= 0; index -= 1) {
      const item = page[index];
      if (!item || item.err) continue;
      const wire = await historyReader.getTransaction(network, item.signature);
      if (!wire) continue;
      const bound = readReceiverBindingFromOpen(wire, channelId);
      if (bound !== undefined) return bound;
    }
  }
  return undefined;
}

/**
 * Whether a value can record and read receiver-authorizer bindings.
 *
 * @param value - Configured store
 * @returns True when bind, get, and delete are functions
 */
function isReceiverAuthorizerStore(value: object): value is BatchReceiverAuthorizerStore {
  const store = value as Partial<BatchReceiverAuthorizerStore>;
  return (
    typeof store.bind === "function" &&
    typeof store.get === "function" &&
    typeof store.delete === "function"
  );
}

/**
 * Whether a value can page channel signatures and read their transactions.
 *
 * @param value - Configured history reader
 * @returns True when both read methods are functions
 */
function isReceiverBindingHistoryReader(value: object): value is BatchReceiverBindingHistoryReader {
  const historyReader = value as Partial<BatchReceiverBindingHistoryReader>;
  return (
    typeof historyReader.getSignaturesForAddress === "function" &&
    typeof historyReader.getTransaction === "function"
  );
}
