import { isAddress } from "@solana/kit";
import type {
  FacilitatorContext,
  Network,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";

import {
  assertPaymentChannelStorage,
  CallerIdentityConflictError,
  checkOpenBindings,
  ReceiverAuthorizerConflictError,
  type PaymentChannelRecord,
  type PaymentChannelStorage,
} from "../../payment-channels/storage";
import type { BatchPendingSettlementStore } from "./recovery";

import { BatchError } from "../errors";
import { readReceiverBindingFromOpen } from "../receiverBinding";
import type {
  BatchDelegatedReceiverAuth,
  BatchDelegatedSettleContext,
  BatchReceiverBindingHistoryReader,
  BatchReceiverBindingHistorySignature,
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
  /**
   * Shared channel storage: lifecycle index, receiver-authorizer binding, and
   * delegated caller identity. Defaults to an in-memory store. Use a durable
   * implementation when more than one process must read the row. A failed
   * write does not broadcast the transaction.
   */
  channelStorage?: PaymentChannelStorage | undefined;
  /**
   * Called when reverting a failed open fails. The settle error is unchanged.
   * Defaults to a warning.
   */
  onStorageError?: ((error: unknown, network: string, channelId: string) => void) | undefined;
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
   * Optional fallback for a channel row with no receiver-authorizer binding.
   * Reads the open transaction's binding memo and writes it back through
   * `recordOpen` when the row is absent. Used only when set here: the
   * facilitator does not adopt one from the signer or a public RPC. A failed
   * channel write still does not broadcast the open.
   */
  receiverBindingHistoryReader?: BatchReceiverBindingHistoryReader | undefined;
  /**
   * Opt in to facilitator-delegated close authorization. Advertised as
   * `/supported` `extra.receiverAuthorizer`. Requires
   * {@link BatchDelegatedReceiverAuth.resolveCallerIdentity}; the identity
   * it returns is written on the channel row. A missing or different
   * identity fails the close, and the client falls back to `request_close`.
   */
  delegatedReceiverAuth?: BatchDelegatedReceiverAuth | undefined;
}

/**
 * Reject a channel store or history reader that lacks its methods. Both may
 * be omitted: storage then defaults to in-memory, and history stays off.
 *
 * @param channelStorage - Configured channel storage, when set
 * @param historyReader - Configured open-transaction reader, when set
 */
export function assertBindingSource(
  channelStorage: object | undefined,
  historyReader: BatchReceiverBindingHistoryReader | undefined,
): void {
  if (channelStorage !== undefined) assertPaymentChannelStorage(channelStorage);
  if (historyReader !== undefined && !isReceiverBindingHistoryReader(historyReader)) {
    throw new Error(
      "receiverBindingHistoryReader must implement getSignaturesForAddress and getTransaction",
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
  return delegated;
}

/** Receiver authorizer and caller identity read from one channel row, then history. */
export interface ChannelBinding {
  receiverAuthorizer: string | undefined;
  callerIdentity: string;
}

/**
 * Receiver authorizer bound to a channel: the channel row, then the open
 * transaction. A stored key is not re-read. A history read is written back
 * with `recordOpen` when the row is absent. An empty stored key is a miss:
 * discovery indexes a channel without the binding memo.
 *
 * @param storage - Channel storage
 * @param historyReader - Full-history open reader, when configured
 * @param network - CAIP-2 network the channel was opened on
 * @param channelId - Channel PDA
 * @param loaded - Row already read, so seal and refund do not get twice
 * @returns The bound key and the caller identity on the row
 */
export async function readReceiverAuthorizer(
  storage: PaymentChannelStorage,
  historyReader: BatchReceiverBindingHistoryReader | undefined,
  network: Network,
  channelId: string,
  loaded?: PaymentChannelRecord | undefined,
): Promise<ChannelBinding> {
  const record = loaded ?? (await storage.get(network, channelId));
  const callerIdentity = record?.callerIdentity ?? "";
  if (record?.receiverAuthorizer) {
    return { callerIdentity, receiverAuthorizer: record.receiverAuthorizer };
  }
  if (!historyReader) return { callerIdentity, receiverAuthorizer: undefined };
  const fromHistory = await readBindingFromHistory(historyReader, network, channelId);
  if (fromHistory === undefined) return { callerIdentity, receiverAuthorizer: undefined };
  if (record === undefined) {
    const requested: PaymentChannelRecord = {
      callerIdentity: "",
      channelId,
      expiresAt: 0,
      lastActivityAt: Date.now(),
      network,
      payTo: "",
      receiverAuthorizer: fromHistory,
      tokenProgram: "",
    };
    try {
      const write = await storage.recordOpen(requested);
      checkOpenBindings(requested, write.record);
    } catch (error) {
      if (
        error instanceof ReceiverAuthorizerConflictError ||
        error instanceof CallerIdentityConflictError
      ) {
        throw new Error(`${BatchError.RECEIVER_AUTHORIZER_MISMATCH}: ${error.message}`);
      }
      throw error;
    }
  }
  return { callerIdentity, receiverAuthorizer: fromHistory };
}

/**
 * Require a channel's stored binding to be the advertised key.
 *
 * @param bound - Resolved binding, undefined when unavailable
 * @param advertised - `extra.receiverAuthorizer` of the request
 * @param channelId - Channel PDA, for the message
 * @returns The bound key
 */
export function requireReceiverAuthorizer(
  bound: string | undefined,
  advertised: string,
  channelId: string,
): string {
  if (bound === undefined) {
    throw new Error(
      `${BatchError.RECEIVER_BINDING_UNAVAILABLE}: no receiver authorizer is bound to ${channelId}`,
    );
  }
  if (bound !== advertised) {
    throw new Error(
      `${BatchError.RECEIVER_AUTHORIZER_MISMATCH}: advertised key is not the channel's binding`,
    );
  }
  return bound;
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
