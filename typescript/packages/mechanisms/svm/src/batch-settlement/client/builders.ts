/**
 * Single-shot client builders for a channel the caller already tracks.
 *
 * {@link BatchSvmScheme} drives a channel's lifecycle from its own channel
 * storage. These builders take the channel's tracked state instead, for a
 * caller that keeps that state elsewhere (or restores it from the resource
 * server's PAYMENT-RESPONSE): each returns the payload for one operation and
 * changes no state.
 */

import type { PaymentRequirements } from "@x402/core/types";

import { buildTopUpPaymentChannelTransaction, parseU64 } from "../../payment-channels/open";
import { requireTokenProgramHint } from "../../payment-channels/requirements";
import { createRpcClient, resolveBlockhash, resolveTransactionVersion } from "../../utils";
import { deriveBatchChannelId } from "../codec";
import { BatchError } from "../errors";
import type {
  BatchChannelConfig,
  BatchDepositPayload,
  BatchRefundPayload,
  BatchVoucherPayload,
} from "../types";
import { type BatchClientSigner, BatchChannelTracker, buildRefundPayload } from "./channel";

/** A client-signed channel as its payer tracks it. */
export interface BatchTrackedChannel {
  channelConfig: BatchChannelConfig;
  /** Cumulative amount the resource server confirmed (decimal string). */
  chargedCumulativeAmount: string;
  /** Escrowed deposit (decimal string). */
  deposit: string;
}

/** Inputs every builder shares. */
export interface BatchBuildArgs {
  /** The payer, who is also the channel's `payerAuthorizer`. */
  signer: BatchClientSigner;
  channel: BatchTrackedChannel;
  /** The route's batch-settlement requirements. */
  requirements: PaymentRequirements;
}

/** Inputs of a builder that signs a transaction. */
export interface BatchTransactionBuildArgs extends BatchBuildArgs {
  /** Blockhash to build against; defaults to the challenge hint or the RPC's latest. */
  blockhash?: { blockhash: string; lastValidBlockHeight: bigint } | undefined;
  /** RPC endpoint for the blockhash fallback. */
  rpcUrl?: string | undefined;
  /** Versions the signer can sign; defaults to `[0, 1]`. */
  transactionVersions?: readonly number[] | undefined;
}

interface Resolved {
  channelId: string;
  tracker: BatchChannelTracker;
  charged: bigint;
  deposit: bigint;
  feePayer: string;
  memo: string | undefined;
}

/**
 * Validate the tracked channel against the route and rebuild its tracker.
 *
 * @param args - Builder inputs
 * @returns The resolved channel
 */
async function resolve(args: BatchBuildArgs): Promise<Resolved> {
  const { channelConfig } = args.channel;
  if ((channelConfig.voucherSigner ?? "client") !== "client") {
    throw new Error(
      `${BatchError.PAYLOAD_TYPE}: server-signed channels are driven by BatchSvmScheme`,
    );
  }
  if (channelConfig.payer !== args.signer.address) {
    throw new Error(`${BatchError.CHANNEL_STATE}: the signer is not the channel payer`);
  }
  if (channelConfig.payerAuthorizer !== args.signer.address) {
    throw new Error(
      `${BatchError.VOUCHER_SIGNATURE}: the signer is not the channel payerAuthorizer`,
    );
  }
  const extra = args.requirements.extra ?? {};
  const feePayer = extra.feePayer;
  if (typeof feePayer !== "string" || feePayer.length === 0) {
    throw new Error(`${BatchError.FEE_PAYER_MISMATCH}: extra.feePayer must be a non-empty string`);
  }
  if (feePayer === args.signer.address) {
    throw new Error(
      `${BatchError.FEE_PAYER_MISMATCH}: extra.feePayer must not equal the channel payer`,
    );
  }
  const memo = extra.memo;
  if (memo !== undefined && typeof memo !== "string") {
    throw new Error("extra.memo must be a string when present");
  }
  const channelId = await deriveBatchChannelId(channelConfig, feePayer);
  const charged = parseU64(args.channel.chargedCumulativeAmount, "chargedCumulativeAmount");
  const deposit = parseU64(args.channel.deposit, "deposit");
  return {
    channelId,
    charged,
    deposit,
    feePayer,
    memo,
    tracker: new BatchChannelTracker(channelId, channelConfig, args.signer, charged),
  };
}

/**
 * The voucher that pays the route's amount on a channel with room for it: it
 * authorizes exactly `chargedCumulativeAmount + amount`, never expiring.
 *
 * @param args - Builder inputs
 * @returns The `voucher` payload
 */
export async function buildBatchVoucherPayload(args: BatchBuildArgs): Promise<BatchVoucherPayload> {
  const resolved = await resolve(args);
  const charge = parseU64(args.requirements.amount, "amount");
  if (resolved.charged + charge > resolved.deposit) {
    throw new Error(
      `${BatchError.CUMULATIVE_EXCEEDS_DEPOSIT}: ${resolved.charged + charge} exceeds the ${resolved.deposit} deposit; top up first`,
    );
  }
  return {
    channelConfig: args.channel.channelConfig,
    type: "voucher",
    voucher: await resolved.tracker.previewVoucher(charge),
  };
}

/**
 * A top-up of `depositAmount` that also pays the route's amount: a canonical
 * payer-signed `top_up` plus the voucher for `chargedCumulativeAmount + amount`.
 *
 * @param args - Builder inputs and the amount to add
 * @param args.depositAmount - Escrow to add (base units)
 * @returns The `deposit` payload
 */
export async function buildBatchTopUpPayload(
  args: BatchTransactionBuildArgs & { depositAmount: bigint | string },
): Promise<BatchDepositPayload> {
  const transactionVersion = resolveTransactionVersion(
    args.requirements.extra,
    args.transactionVersions,
  );
  const resolved = await resolve(args);
  const amount = parseU64(args.depositAmount, "depositAmount");
  if (amount === 0n) throw new Error("depositAmount must be positive");
  const charge = parseU64(args.requirements.amount, "amount");
  if (resolved.charged + charge > resolved.deposit + amount) {
    throw new Error(
      `${BatchError.CUMULATIVE_EXCEEDS_DEPOSIT}: the top-up does not cover the next charge`,
    );
  }
  const tokenProgram = requireTokenProgramHint(
    args.requirements.extra ?? {},
    "extra.tokenProgram is not a supported SPL token program",
  );
  const blockhash =
    args.blockhash ??
    (await resolveBlockhash(
      createRpcClient(args.requirements.network, args.rpcUrl),
      args.requirements,
    ));
  const topUp = await buildTopUpPaymentChannelTransaction({
    amount,
    blockhash,
    channelId: resolved.channelId,
    feePayer: resolved.feePayer,
    memo: resolved.memo,
    mint: args.requirements.asset,
    payer: args.signer,
    tokenProgram,
    transactionVersion,
  });
  return {
    channelConfig: args.channel.channelConfig,
    deposit: { amount: amount.toString(), transaction: topUp.transaction },
    type: "deposit",
    voucher: await resolved.tracker.previewVoucher(charge),
  };
}

/**
 * A client-mode refund: the voucher at the confirmed cumulative, and with
 * `withTransaction` a payer-signed `request_close` for a facilitator that
 * cannot close cooperatively.
 *
 * @param args - Builder inputs
 * @param args.withTransaction - Include a payer-signed `request_close`
 * @returns The `refund` payload
 */
export async function buildBatchRefundPayload(
  args: BatchTransactionBuildArgs & { withTransaction?: boolean | undefined },
): Promise<BatchRefundPayload> {
  const transactionVersion = resolveTransactionVersion(
    args.requirements.extra,
    args.transactionVersions,
  );
  const resolved = await resolve(args);
  const blockhash = args.withTransaction
    ? (args.blockhash ??
      (await resolveBlockhash(
        createRpcClient(args.requirements.network, args.rpcUrl),
        args.requirements,
      )))
    : undefined;
  return buildRefundPayload({
    blockhash,
    channelConfig: args.channel.channelConfig,
    channelId: resolved.channelId,
    feePayer: resolved.feePayer,
    memo: resolved.memo,
    payer: args.signer,
    transactionVersion,
    voucher: await resolved.tracker.refundVoucher(),
  });
}
