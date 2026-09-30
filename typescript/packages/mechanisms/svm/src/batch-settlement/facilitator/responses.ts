/**
 * Response shaping and error classification for the batch-settlement
 * facilitator: pure functions over decoded channel accounts and settlement
 * outcomes, kept apart from the scheme's request handling.
 */

import type { Network, SettleResponse, VerifyResponse } from "@x402/core/types";

import { ErrSettlementPending } from "../../exact/facilitator/errors";

import type { Channel } from "../../payment-channels/generated/accounts/channel";
import {
  ChannelBroadcastConfirmationError,
  SettlementConfirmationTimeoutError,
} from "../../payment-channels/facilitator";
import { ChannelStatus } from "../../payment-channels/onchain";
import { parseU64 } from "../../payment-channels/open";
import { BatchError } from "../errors";
import type { BatchChannelState } from "../types";

/** Reason reported when a channel is already mid-operation. */
export const CHANNEL_BUSY = "duplicate_settlement";

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
 * a known `BatchError`, or the generic `transaction_failed`.
 *
 * @param error - The error a settlement path threw
 * @returns The reason code to report
 */
export function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(CHANNEL_BUSY)) return CHANNEL_BUSY;
  if (/\b429\b/.test(message) || /\b503\b/.test(message)) return BatchError.CHANNEL_STATE;
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
