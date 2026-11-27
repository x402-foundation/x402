/**
 * Response shaping and error classification for the batch-settlement
 * facilitator: pure functions over decoded channel accounts and settlement
 * outcomes, kept apart from the scheme's request handling.
 */

import type {
  Network,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { deepEqual } from "@x402/core/utils";

import {
  ErrSettlementPending,
  ErrUnsupportedTransactionVersion,
} from "../../exact/facilitator/errors";

import type { Channel } from "../../payment-channels/generated/accounts/channel";
import {
  ChannelBroadcastConfirmationError,
  SettlementConfirmationTimeoutError,
} from "../../payment-channels/facilitator";
import { ChannelStatus } from "../../payment-channels/onchain";
import { parseU64 } from "../../payment-channels/open";
import type {
  OpenBroadcastDisposition,
  PaymentChannelRecord,
} from "../../payment-channels/storage";
import { BATCH_SETTLEMENT_SCHEME, DYNAMIC_EXTRA_FIELDS } from "../constants";
import { BatchError } from "../errors";
import {
  redemptionStatusOf,
  type BatchChannelState,
  type BatchRedemptionChannelState,
} from "../types";

/** Reason reported when a channel is already mid-operation. */
export const CHANNEL_BUSY = "duplicate_settlement";

/** Every known onchain channel status byte accepted by this scheme. */
export const ALL_CHANNEL_STATUSES: readonly ChannelStatus[] = [
  ChannelStatus.Open,
  ChannelStatus.Closing,
  ChannelStatus.Sealed,
  ChannelStatus.Distributed,
];

/** Core x402 reason for a `paymentPayload.accepted` that does not equal the requirements. */
export const INVALID_PAYMENT_REQUIREMENTS = "invalid_payment_requirements";

/**
 * Check the request envelope: `paymentPayload.accepted` MUST equal
 * `paymentRequirements` (spec 4.5), apart from the `extra` keys left out of
 * requirements matching (`DYNAMIC_EXTRA_FIELDS`).
 *
 * @param accepted - The requirements the client signed against
 * @param requirements - The requirements the server forwarded
 * @returns The failure reason, or undefined when the envelope matches
 */
export function envelopeFailure(
  accepted: PaymentRequirements,
  requirements: PaymentRequirements,
): string | undefined {
  if (
    accepted.scheme !== BATCH_SETTLEMENT_SCHEME ||
    requirements.scheme !== BATCH_SETTLEMENT_SCHEME
  ) {
    return "unsupported_scheme";
  }
  const comparable = ({ extra, ...core }: PaymentRequirements) => {
    const stable = { ...extra };
    for (const field of DYNAMIC_EXTRA_FIELDS) delete stable[field];
    return { ...core, extra: stable };
  };
  return deepEqual(comparable(accepted), comparable(requirements))
    ? undefined
    : INVALID_PAYMENT_REQUIREMENTS;
}

/**
 * The signature carried by an error that means "broadcast, outcome unknown",
 * or `undefined` for anything else.
 *
 * @param error - The error a broadcast attempt threw
 * @returns The signature already on the network, when there is one
 */
export function pendingSignatureOf(error: unknown): string | undefined {
  if (error instanceof ChannelBroadcastConfirmationError) return error.signature;
  if (error instanceof SettlementConfirmationTimeoutError) return String(error.signature);
  return undefined;
}

/**
 *
 * @param channelId
 * @param channel
 * @param chargedCumulativeAmount
 */
/**
 * Project a decoded channel account onto the wire `channelState` snapshot.
 *
 * @param channelId - Channel PDA
 * @param channel - Decoded channel account
 * @param chargedCumulativeAmount - Server watermark to include, when known
 * @returns The corrective snapshot carried in responses and 402s
 */
function snapshotChannel(
  channelId: string,
  channel: Channel,
  chargedCumulativeAmount?: bigint,
): BatchChannelState {
  const snapshot: BatchChannelState = {
    channelId,
    balance: channel.deposit.toString(),
    totalClaimed: channel.settlement.settled.toString(),
    withdrawRequestedAt:
      channel.status === ChannelStatus.Closing ? Number(channel.closureStartedAt) : 0,
  };
  if (chargedCumulativeAmount !== undefined) {
    snapshot.chargedCumulativeAmount = chargedCumulativeAmount.toString();
  }
  return snapshot;
}

/**
 * Project a decoded channel account onto the flat `/verify` response `extra`
 * of the scheme spec (section 4.5): `channelId`, `balance`, `totalClaimed`
 * and `withdrawRequestedAt` as siblings, not a nested snapshot.
 *
 * @param channelId - Channel PDA
 * @param channel - Decoded channel account
 * @returns The verify response `extra`
 */
export function verifiedChannelExtra(
  channelId: string,
  channel: Channel,
): {
  channelId: string;
  balance: string;
  totalClaimed: string;
  withdrawRequestedAt: number;
} {
  const { chargedCumulativeAmount: _omitted, ...flat } = snapshotChannel(channelId, channel);
  void _omitted;
  return flat;
}

/**
 * Project a decoded channel account onto a `extra.channelStates[]` entry.
 *
 * @param channelId - Channel PDA
 * @param channel - Decoded channel account
 * @returns The channel's confirmed onchain state, or undefined for a status byte this scheme does not report
 */
export function redemptionSnapshot(
  channelId: string,
  channel: Channel,
): BatchRedemptionChannelState | undefined {
  const status = redemptionStatusOf(channel.status);
  if (status === undefined) return undefined;
  return {
    ...snapshotChannel(channelId, channel),
    payoutWatermark: channel.settlement.payoutWatermark.toString(),
    status,
  };
}

/**
 * Snapshot for a channel PDA that is absent onchain and permanently terminal
 * (closed and deallocated, or past `open_slot + OPEN_SLOT_WINDOW` so it can
 * never be opened). Watermarks are zeroed because no onchain account remains.
 *
 * @param channelId - Channel PDA
 * @returns The closed snapshot entry for `extra.channelStates[]`
 */
export function closedSnapshot(channelId: string): BatchRedemptionChannelState {
  return {
    balance: "0",
    channelId,
    payoutWatermark: "0",
    status: "closed",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
  };
}

/**
 * The state a confirmed distribute leaves behind: payout caught up to settled,
 * and a sealed channel paid out. It is valid only for a channel read before
 * that distribute was built; one read after may have settled more since, so
 * use {@link redemptionSnapshot} for it.
 *
 * @param channelId - Channel PDA
 * @param channel - Decoded channel account read before the distribute
 * @returns The channel's state after the distribute, or undefined for an unreported status byte
 */
export function distributedSnapshot(
  channelId: string,
  channel: Channel,
): BatchRedemptionChannelState | undefined {
  const state = redemptionSnapshot(channelId, channel);
  if (!state) return undefined;
  return {
    ...state,
    payoutWatermark: state.totalClaimed,
    status: state.status === "sealed" ? "distributed" : state.status,
  };
}

/**
 * Snapshot a batch's channels, or none unless every one was read and has a
 * reportable status: the server adopts only a complete batch.
 *
 * @param batch - The batch's channels
 * @param channels - The decoded channels in the same order, `undefined` where absent
 * @param snapshot - Projects a channel onto its reported state
 * @returns The states, or undefined when a channel was not read or has no reportable state
 */
export function completeStates(
  batch: readonly { channelId: string }[],
  channels: readonly (Channel | undefined)[] | undefined,
  snapshot: (channelId: string, channel: Channel) => BatchRedemptionChannelState | undefined,
): BatchRedemptionChannelState[] | undefined {
  if (!channels || channels.includes(undefined)) return undefined;
  const states = batch.map((item, index) => snapshot(item.channelId, channels[index]!));
  return states.every((state): state is BatchRedemptionChannelState => state !== undefined)
    ? states
    : undefined;
}

/**
 * Reject a claim or distribute whose effect is already onchain, with the
 * channels' state when every one can be reported.
 *
 * @param requirements - The request's requirements
 * @param message - Human-readable detail
 * @param batch - The batch's channels
 * @param channels - The decoded channels in the same order, `undefined` where absent
 * @returns The settle response
 */
export function appliedFailure(
  requirements: PaymentRequirements,
  message: string,
  batch: readonly { channelId: string }[],
  channels: readonly (Channel | undefined)[],
): SettleResponse {
  return resyncFailure(
    requirements.network,
    BatchError.CUMULATIVE_AMOUNT_MISMATCH,
    message,
    completeStates(batch, channels, redemptionSnapshot),
  );
}

/**
 * Parse a persisted positive slot floor from recovery storage.
 *
 * @param raw - Stored decimal slot string, if present
 * @returns Positive slot bigint, or undefined when absent or malformed
 */
export function parseStoredSlot(raw: string | undefined): bigint | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const slot = BigInt(raw);
  return slot > 0n ? slot : undefined;
}

/**
 * Snapshot a batch read at or past a terminal point: live accounts use
 * `redemptionSnapshot`, absent ones keep a preserved `distributed` snapshot
 * when available or else become `closedSnapshot` when `allowClosed` is true.
 * Returns undefined if any channel cannot be safely reported.
 *
 * @param batch - The batch's channels
 * @param channels - The decoded channels in the same order, `undefined` where absent
 * @param preserved - Previously recorded snapshots, if any
 * @param allowClosed - Whether absent PDAs were read with a confirmation slot floor
 * @returns The states, or undefined when a channel cannot be safely reported
 */
export function observedOrClosedStates(
  batch: readonly { channelId: string }[],
  channels: readonly (Channel | undefined)[],
  preserved?: readonly BatchRedemptionChannelState[],
  allowClosed = true,
): BatchRedemptionChannelState[] | undefined {
  const byId = preserved ? new Map(preserved.map(entry => [entry.channelId, entry])) : undefined;
  const states = batch.map((item, index) => {
    const live = channels[index];
    if (live) return redemptionSnapshot(item.channelId, live);
    const existing = byId?.get(item.channelId);
    if (existing?.status === "distributed") return existing;
    return allowClosed ? closedSnapshot(item.channelId) : undefined;
  });
  return states.every((state): state is BatchRedemptionChannelState => state !== undefined)
    ? states
    : undefined;
}

/**
 * Refresh `extra.channelStates` on a replayed successful distribute response,
 * converting absent PDAs to `closed` only when `allowClosed` is true (unless a
 * terminal `distributed` snapshot was already recorded). Non-success responses
 * are returned unchanged.
 *
 * @param response - The previously cached distribute response
 * @param batch - The batch's channels
 * @param channels - Current chain reads for the batch, `undefined` where absent
 * @param allowClosed - Whether the replay reads were constrained to the confirmation slot
 * @returns The refreshed response, or `response` unchanged
 */
export function refreshDistributionReplay(
  response: SettleResponse,
  batch: readonly { channelId: string }[],
  channels: readonly (Channel | undefined)[],
  allowClosed = true,
): SettleResponse {
  if (!response.success) return response;
  const existing = Array.isArray(response.extra?.channelStates)
    ? (response.extra.channelStates as BatchRedemptionChannelState[])
    : undefined;
  const channelStates = observedOrClosedStates(batch, channels, existing, allowClosed);
  return channelStates ? { ...response, extra: { ...response.extra, channelStates } } : response;
}

/**
 * Reject a claim, seal, or distribute whose batch contains at least one channel
 * absent onchain past `open_slot + OPEN_SLOT_WINDOW`, attaching `status: "closed"`
 * for absent channels and live snapshots for present channels.
 *
 * @param network - CAIP-2 network of the request
 * @param batch - The batch's channels
 * @param channels - The decoded channels in the same order, `undefined` where absent
 * @param payer - Channel payer when recoverable
 * @returns The settle response
 */
export function closedFailure(
  network: Network,
  batch: readonly { channelId: string }[],
  channels: readonly (Channel | undefined)[],
  payer = "",
): SettleResponse {
  return resyncFailure(
    network,
    BatchError.CHANNEL_STATE,
    "channel closed onchain",
    observedOrClosedStates(batch, channels),
    payer,
  );
}

/**
 * The states a confirmed distribute reports. A fresh sweep reports the channels
 * read before it; a recovered one re-reads the chain, reporting `status: "closed"`
 * for any account already absent at or past the confirmation slot. An RPC read
 * error or an unrecognized onchain status byte omits the field.
 *
 * @param batch - The batch's channels
 * @param channelsBefore - The channels read before the sweep, if it was just built
 * @param readChannel - Reads a channel now
 * @param allowClosed - Whether absent accounts were read with a confirmation slot floor
 * @returns The states, or undefined when an RPC read failed or a channel has an unreported status
 */
export async function distributionStates(
  batch: readonly { channelId: string }[],
  channelsBefore: readonly (Channel | undefined)[] | undefined,
  readChannel: (channelId: string) => Promise<Channel | undefined>,
  allowClosed = true,
): Promise<BatchRedemptionChannelState[] | undefined> {
  if (channelsBefore) return completeStates(batch, channelsBefore, distributedSnapshot);
  const channels = await Promise.all(batch.map(item => readChannel(item.channelId))).catch(
    () => undefined,
  );
  if (!channels) return undefined;
  return observedOrClosedStates(batch, channels, undefined, allowClosed);
}

/**
 * Reject a redemption whose effect is already onchain, carrying the channels'
 * state so the server adopts it instead of resubmitting. Without a complete
 * state it is a plain failure.
 *
 * @param network - CAIP-2 network of the request
 * @param reason - Machine-readable reason
 * @param message - Human-readable detail
 * @param states - The channels' confirmed onchain state, when every channel has one
 * @param payer - Channel payer when recoverable
 * @returns The settle response
 */
export function resyncFailure(
  network: Network,
  reason: string,
  message: string,
  states: readonly BatchRedemptionChannelState[] | undefined,
  payer = "",
): SettleResponse {
  const failure = settleFailure(network, reason, payer, message);
  return states ? { ...failure, extra: { channelStates: states } } : failure;
}

/**
 *
 * @param channelId
 * @param channel
 * @param network
 * @param transaction
 */
/**
 * Successful `deposit` settlement response with the confirmed channel state.
 *
 * @param channelId - Channel PDA
 * @param channel - Decoded channel account after the deposit landed
 * @param network - CAIP-2 network
 * @param transaction - Confirmed transaction signature
 * @param amount - Amount this deposit or top-up moved into escrow, not the
 * channel's running total (spec section 4.5)
 * @returns The settle response
 */
export function depositResponse(
  channelId: string,
  channel: Channel,
  network: Network,
  transaction: string,
  amount: bigint,
): SettleResponse {
  return {
    success: true,
    payer: channel.payer,
    transaction,
    network,
    amount: amount.toString(),
    extra: {
      channelState: snapshotChannel(channelId, channel),
    },
  };
}

/**
 *
 * @param claims
 * @param network
 * @param transaction
 */
/**
 * Successful `claim` settlement response listing every channel and the
 * cumulative amount the claim advanced it to.
 *
 * @param claims - Channels the transaction claimed
 * @param network - CAIP-2 network
 * @param transaction - Confirmed transaction signature
 * @returns The settle response
 */
export function claimResponse(
  claims: readonly { channelId: string; cumulative: bigint }[],
  network: Network,
  transaction: string,
): SettleResponse {
  return {
    amount: "",
    extra: {
      accepts: claims.map(item => ({
        channelId: item.channelId,
        totalClaimed: item.cumulative.toString(),
      })),
    },
    network,
    payer: "",
    success: true,
    transaction,
  };
}

/**
 *
 * @param channelId
 * @param channel
 * @param network
 * @param transaction
 */
/**
 * Successful `refund` settlement response with the channel state after the
 * close was broadcast.
 *
 * @param channelId - Channel PDA
 * @param channel - Decoded channel account
 * @param network - CAIP-2 network
 * @param transaction - Confirmed transaction signature
 * @returns The settle response
 */
export function refundResponse(
  channelId: string,
  channel: Channel,
  network: Network,
  transaction: string,
): SettleResponse {
  return {
    success: true,
    payer: channel.payer,
    transaction,
    network,
    // Initiation only: the grace period may still be running (spec 4.5).
    amount: "",
    extra: { channelState: snapshotChannel(channelId, channel) },
  };
}

/**
 *
 * @param channelId
 * @param payer
 * @param network
 * @param transaction
 */
/**
 * `refund` response replayed from a durable record when the channel account
 * is already gone, so only the identity the record kept is reported.
 *
 * @param channelId - Channel PDA
 * @param payer - Channel payer
 * @param network - CAIP-2 network
 * @param transaction - Confirmed transaction signature
 * @returns The settle response
 */
export function recoveredRefundResponse(
  channelId: string,
  payer: string,
  network: Network,
  transaction: string,
): SettleResponse {
  return {
    extra: { channelId },
    network,
    payer,
    success: true,
    transaction,
  };
}

/**
 * Successful `seal` response: the final voucher was applied with
 * `settle_and_seal` and the sealed `distribute` paid the receiver and returned
 * the remainder to the payer in the same transaction.
 *
 * @param args - Final channel accounting
 * @param args.channelId - Channel PDA
 * @param args.payer - Channel payer
 * @param args.network - CAIP-2 network
 * @param args.transaction - Confirmed transaction signature
 * @param args.paidToReceiver - Amount this transaction moved to `payTo`
 * @param args.deposit - Channel deposit before the close
 * @param args.finalSettled - Final settled watermark; `deposit - finalSettled` went back to the payer
 * @returns The settle response
 */
export function sealResponse(args: {
  channelId: string;
  payer: string;
  network: Network;
  transaction: string;
  paidToReceiver: bigint;
  deposit: bigint;
  finalSettled: bigint;
}): SettleResponse {
  return {
    success: true,
    payer: args.payer,
    transaction: args.transaction,
    network: args.network,
    amount: args.paidToReceiver.toString(),
    extra: {
      channelState: {
        channelId: args.channelId,
        balance: args.deposit.toString(),
        totalClaimed: args.finalSettled.toString(),
        withdrawRequestedAt: 0,
      } satisfies BatchChannelState,
      paidToReceiver: args.paidToReceiver.toString(),
    },
  };
}

/**
 * A failed verification response.
 *
 * @param reason - Machine-readable reason
 * @param payer - Channel payer when recoverable
 * @param message - Optional human-readable detail
 * @returns The verify response
 */
export function verifyFailure(reason: string, payer: string, message?: string): VerifyResponse {
  return {
    isValid: false,
    invalidReason: reason,
    ...(message ? { invalidMessage: message } : {}),
    payer,
  };
}

/**
 * A failed settlement response.
 *
 * @param network - CAIP-2 network of the request
 * @param reason - Machine-readable reason
 * @param payer - Channel payer when recoverable
 * @param message - Optional human-readable detail
 * @returns The settle response
 */
export function settleFailure(
  network: Network,
  reason: string,
  payer: string,
  message?: string,
): SettleResponse {
  return {
    success: false,
    network,
    transaction: "",
    errorReason: reason,
    ...(message ? { errorMessage: message } : {}),
    payer,
  };
}

/**
 * A response for work that was broadcast but whose outcome is not yet
 * confirmed; the caller retries with the same request.
 *
 * @param network - CAIP-2 network
 * @param payer - Channel payer when recoverable
 * @param signature - The broadcast signature
 * @param message - What is still pending
 * @returns The settle response
 */
export function settlementPending(
  network: Network,
  payer: string,
  signature: string,
  message: string,
): SettleResponse {
  return {
    errorMessage: message,
    errorReason: ErrSettlementPending,
    network,
    payer,
    success: false,
    transaction: signature,
  };
}

/**
 *
 * @param error
 */
/**
 * Map a thrown error onto the scheme's reason vocabulary: the busy marker,
 * a known `BatchError`, `unsupported_transaction_version`, or the generic
 * `transaction_failed`.
 *
 * @param error - The error a settlement path threw
 * @returns The reason code to report
 */
export function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(CHANNEL_BUSY)) return CHANNEL_BUSY;
  if (/\b429\b/.test(message) || /\b503\b/.test(message)) return BatchError.CHANNEL_STATE;
  if (message.startsWith(ErrUnsupportedTransactionVersion)) return ErrUnsupportedTransactionVersion;
  const known = Object.values(BatchError).find(value => message.includes(value));
  return known ?? "transaction_failed";
}

/**
 *
 * @param value
 */
/**
 * Parse an optional `extra.recentSlot` hint.
 *
 * @param value - Raw hint value, if any
 * @returns The slot as a bigint, or undefined when absent
 */
export function parseOptionalSlot(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  return parseU64(value as string | number | bigint, "extra.recentSlot");
}

/**
 * Whether an open broadcast failed definitively: the send was rejected, the
 * transaction landed with an error, or its blockhash expired unlanded.
 * Pending and a failed attempt to persist a pending signature are kept.
 *
 * @param result - Durable broadcast result
 * @returns `revert` only for a definitive open failure
 */
export function openDisposition(
  result: { signature: string; channel: unknown } | SettleResponse,
): OpenBroadcastDisposition {
  if ("channel" in result) return "keep";
  if (result.success !== false || result.errorReason !== "transaction_failed") return "keep";
  if (result.errorMessage?.includes("failed to persist")) return "keep";
  return "revert";
}

/**
 * Channel facts for an activity or open write. Bindings stay empty unless
 * the caller sets them; activity never changes a stored binding.
 *
 * @param fields - Channel key and the facts this write knows
 * @param fields.network - CAIP-2 network
 * @param fields.channelId - Channel PDA
 * @param fields.payTo - Distribution recipient
 * @param fields.tokenProgram - Token program that owns the mint
 * @param fields.expiresAt - Voucher expiry in Unix seconds, `0` for batch
 * @param fields.receiverAuthorizer - Binding memo key, empty for activity
 * @param fields.callerIdentity - Delegated caller, empty when not delegated
 * @returns A storage record stamped with the current activity time
 */
export function activityRecord(fields: {
  network: Network;
  channelId: string;
  payTo: string;
  tokenProgram: string;
  expiresAt: number;
  receiverAuthorizer?: string;
  callerIdentity?: string;
}): PaymentChannelRecord {
  return {
    callerIdentity: fields.callerIdentity ?? "",
    channelId: fields.channelId,
    expiresAt: fields.expiresAt,
    lastActivityAt: Date.now(),
    network: fields.network,
    payTo: fields.payTo,
    receiverAuthorizer: fields.receiverAuthorizer ?? "",
    tokenProgram: fields.tokenProgram,
  };
}
