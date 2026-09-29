/**
 * Server-authored cooperative close of a `Closing` channel (`type: "seal"`).
 *
 * Once a payer calls `request_close`, program `settle` is unavailable and only
 * the channel `payee` (the facilitator) can apply a final voucher through
 * `settle_and_seal` during the grace period. Without this path a server that
 * was serving requests a minute ago has no way to collect vouchers above the
 * onchain watermark once the payer walks. The server proves it authored the
 * request with a `CloseAuthorization` signed by the receiver authorizer bound
 * to the channel by its open's binding memo, so a payer holding a stale
 * voucher cannot freeze the watermark low. A cooperative refund runs the same
 * close on an `Open` channel.
 */

import type {
  FacilitatorContext,
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";

import { verifyRequestCloseTransaction } from "../../payment-channels/close";
import type { Channel } from "../../payment-channels/generated/accounts/channel";
import {
  buildSettleAndSealInstructions,
  ChannelStatus,
  type ServerInstruction,
} from "../../payment-channels/onchain";
import { parseU64 } from "../../payment-channels/open";
import type { PaymentChannelRecord } from "../../payment-channels/storage";
import { encodeVoucherMessageBytes, verifyVoucherSignature } from "../../payment-channels/voucher";
import type { SettlementCache } from "../../settlement-cache";
import { verifyCloseAuthorization } from "../closeAuthorization";
import { CLIENT_VOUCHER_EXPIRES_AT } from "../constants";
import { BatchError } from "../errors";
import {
  isBatchVoucher,
  type BatchChannelConfig,
  type BatchRefundPayload,
  type BatchSealPayload,
  type BatchVoucher,
} from "../types";
import type { BatchDelegatedSettleContext } from "./delegatedAuthStore";
import { requireReceiverAuthorizer } from "./receiverAuthorizerStore";
import type { BatchPendingSettlementStore } from "./recovery";
import {
  CHANNEL_BUSY,
  refundResponse,
  sealResponse,
  settleFailure,
  settlementPending,
} from "./responses";
import type { BatchTerms } from "./types";

/** Terms `seal` needs: everything {@link BatchTerms} carries except who signs vouchers. */
export type SealTerms = Omit<BatchTerms, "voucherSigner">;

/** A server-authored close: `seal` of a `Closing` channel or cooperative `refund` of an `Open` one. */
export type CloseIntent = "seal" | "refund";

/** Operator ceilings a sponsored `request_close` must respect. */
export interface RefundLimits {
  maxComputeUnits?: number | undefined;
  maxPriorityFeeMicroLamports?: number | undefined;
}

/** A validated refund; `requestClose` is set only on the sponsored fallback path. */
export interface PreparedRefund {
  channelId: string;
  terms: SealTerms;
  requestClose?: string | undefined;
}

/** Scheme internals the seal path borrows, so it can live outside the scheme file. */
export interface SealDependencies {
  pendingStore: BatchPendingSettlementStore;
  settlementCache: SettlementCache;
  resolveTerms(
    config: BatchChannelConfig,
    requirements: PaymentRequirements,
    binding?: "requirements" | "payload",
  ): Promise<SealTerms>;
  resolveReceiverAuthorizer(network: Network, channelId: string): Promise<string | undefined>;
  /** True when `bound` is this facilitator's delegated receiver authorizer. */
  isDelegatedAuthorizer(bound: string): boolean;
  /** Caller identity for this settle, or undefined when the caller is unauthenticated. */
  resolveDelegatedIdentity(ctx: BatchDelegatedSettleContext): Promise<string | undefined>;
  /** Identity bound at open, or undefined when this facilitator has no row. */
  getDelegatedCallerIdentity(network: Network, channelId: string): Promise<string | undefined>;
  deriveChannelId(config: BatchChannelConfig, feePayer: string): Promise<string>;
  fetchChannel(network: string, channelId: string): Promise<Channel>;
  readChannel(network: string, channelId: string): Promise<Channel | undefined>;
  assertClaimChannel(
    channel: Channel,
    config: BatchChannelConfig,
    terms: SealTerms,
    requirements: PaymentRequirements,
    allowedStatuses: readonly ChannelStatus[],
  ): void;
  distributeInstruction(
    channelId: string,
    channel: Channel,
    terms: SealTerms,
    requirements: PaymentRequirements,
  ): Promise<ServerInstruction>;
  submitRedemption(
    feePayer: string,
    network: Network,
    instructions: readonly ServerInstruction[],
    key: string,
    payer: string,
  ): Promise<
    { ok: true; replayed: boolean; signature: string } | { ok: false; response: SettleResponse }
  >;
  completeOrPending(
    key: string,
    signature: string,
    network: Network,
    payer: string,
  ): Promise<SettleResponse | undefined>;
  trackChannel(record: Omit<PaymentChannelRecord, "firstSeenAt" | "lastActivityAt">): Promise<void>;
  nowSeconds(): number;
}

/**
 * Reject a `Closing` channel with the dedicated code, so a server can tell
 * "the payer started a forced close, retry with `seal`" from every other
 * channel-state mismatch (spec 4.5).
 *
 * @param channel - Decoded channel account
 * @param channelId - Channel PDA, for the message
 */
export function assertNotClosing(channel: Channel, channelId: string): void {
  if (channel.status === ChannelStatus.Closing) {
    throw new Error(
      `${BatchError.CHANNEL_CLOSING}: ${channelId} is closing; apply the final voucher with a seal payload`,
    );
  }
}

/**
 * Apply the server's latest voucher with `settle_and_seal` and pay out with a
 * sealed `distribute`, in one transaction: to a `Closing` channel before the
 * payer's grace period ends (`seal`), or to an `Open` one (`refund`).
 *
 * @param deps - Scheme internals
 * @param payment - The settle request envelope
 * @param payload - The close to apply
 * @param requirements - The server's requirements for the channel
 * @param intent - Which close this is; decides the required channel status
 * @param context - Facilitator extensions (used by delegated caller identity)
 * @returns The settle response
 */
export async function settleSeal(
  deps: SealDependencies,
  payment: PaymentPayload,
  payload: BatchSealPayload,
  requirements: PaymentRequirements,
  intent: CloseIntent,
  context?: FacilitatorContext,
): Promise<SettleResponse> {
  const network = requirements.network;
  const payer = payload.channelConfig.payer;
  const terms = await deps.resolveTerms(
    payload.channelConfig,
    requirements,
    intent === "seal" ? "payload" : "requirements",
  );
  const channelId = await deps.deriveChannelId(payload.channelConfig, terms.feePayer);
  if (channelId !== payload.channelId) throw new Error(BatchError.CHANNEL_ID_MISMATCH);
  const cumulative = await verifyCloseVoucher(payload.voucher, payload.channelConfig, channelId);

  await authenticateServer(
    deps,
    payload,
    requirements,
    terms,
    channelId,
    cumulative,
    intent,
    context,
  );

  // Namespace from spec Phase 5: ("close", channelId, maxClaimableAmount).
  const key = `batch:${intent}:${network}:${channelId}:${cumulative}`;
  const previous = await deps.pendingStore.get(`${key}:result`);
  if (previous) return JSON.parse(previous) as SettleResponse;

  const channel = await deps.fetchChannel(network, channelId);
  const requiredStatus = intent === "seal" ? ChannelStatus.Closing : ChannelStatus.Open;
  if (channel.status !== requiredStatus) {
    throw new Error(
      `${BatchError.CLOSE_STATE}: ${intent} applies only to a ${ChannelStatus[requiredStatus]} channel; observed status ${channel.status}`,
    );
  }
  deps.assertClaimChannel(channel, payload.channelConfig, terms, requirements, [requiredStatus]);
  const deadline = channel.closureStartedAt + BigInt(channel.gracePeriod);
  if (intent === "seal" && BigInt(deps.nowSeconds()) >= deadline) {
    throw new Error(
      `${BatchError.CLOSE_STATE}: grace period elapsed; the permissionless seal path applies`,
    );
  }
  const settled = channel.settlement.settled;
  if (cumulative < settled || cumulative > channel.deposit) {
    throw new Error(
      `${BatchError.CLOSE_STATE}: voucher ${cumulative} must lie within settled ${settled} and deposit ${channel.deposit}`,
    );
  }
  // An equal voucher would fail the program's strict monotonicity check, so
  // the channel is sealed at its current watermark instead (spec 4.5).
  const instructions: ServerInstruction[] = [
    ...buildSettleAndSealInstructions({
      channelId,
      payeeSigner: terms.feePayerSigner,
      ...(cumulative > settled
        ? {
            voucher: {
              authorizedSigner: payload.channelConfig.payerAuthorizer,
              cumulativeAmount: cumulative,
              expiresAt: BigInt(CLIENT_VOUCHER_EXPIRES_AT),
              signatureBase58: payload.voucher.signature,
            },
          }
        : {}),
    }),
    await deps.distributeInstruction(channelId, channel, terms, requirements),
  ];
  if (deps.settlementCache.isDuplicate(key)) {
    return settleFailure(payment.accepted.network, CHANNEL_BUSY, payer);
  }
  const submitted = await deps.submitRedemption(terms.feePayer, network, instructions, key, payer);
  if (!submitted.ok) return submitted.response;

  // The sealed distribute may deallocate the PDA outright; a read still in
  // the pre-close status means the confirmed state is not visible yet.
  const observed = await deps.readChannel(network, channelId);
  if (observed && observed.status === requiredStatus) {
    return settlementPending(
      network,
      payer,
      submitted.signature,
      `${intent} confirmed but the sealed state is not visible yet`,
    );
  }
  const incomplete = await deps.completeOrPending(key, submitted.signature, network, payer);
  if (incomplete) return incomplete;

  const sealed = sealResponse({
    channelId,
    deposit: channel.deposit,
    finalSettled: cumulative,
    network,
    paidToReceiver: cumulative - channel.settlement.payoutWatermark,
    payer,
    transaction: submitted.signature,
  });
  const response =
    intent === "refund" ? { ...sealed, amount: (channel.deposit - cumulative).toString() } : sealed;
  await deps.pendingStore.set(`${key}:result`, JSON.stringify(response));
  // A confirmed seal is facilitator-visible activity; cleanup will find the
  // PDA gone or Distributed and reclaim rent from there.
  await deps.trackChannel({
    channelId,
    expiresAt: CLIENT_VOUCHER_EXPIRES_AT,
    network,
    payTo: requirements.payTo,
    tokenProgram: terms.tokenProgram,
  });
  return response;
}

/**
 * Validate a refund and pick its path: a cooperative close when the
 * channel's receiver binding resolves, otherwise the payer-signed
 * `request_close`, returned as `requestClose` once verified.
 *
 * @param deps - Scheme internals
 * @param payload - The refund payload
 * @param requirements - The server's requirements for the channel
 * @param limits - Operator ceilings the `request_close` must respect
 * @param context - Facilitator extensions (used by delegated caller identity)
 * @returns Channel, terms, and the verified `request_close` for the fallback path
 */
export async function prepareRefund(
  deps: SealDependencies,
  payload: BatchRefundPayload,
  requirements: PaymentRequirements,
  limits: RefundLimits,
  context?: FacilitatorContext,
): Promise<PreparedRefund> {
  if ("amount" in payload) {
    // The program returns all unused escrow; a partial close is not a thing
    // this scheme can honor (spec 4.3).
    throw new Error(
      `${BatchError.CLOSE_AMOUNT_UNSUPPORTED}: refund returns the full unused escrow`,
    );
  }
  const terms = await deps.resolveTerms(payload.channelConfig, requirements);
  const channelId = await deps.deriveChannelId(payload.channelConfig, terms.feePayer);
  const voucher = payload.voucher;
  if (!isBatchVoucher(voucher)) {
    const serverMode = (payload.channelConfig.voucherSigner ?? "client") === "server";
    throw new Error(
      serverMode
        ? `${BatchError.VOUCHER_SIGNATURE}: refund missing operator voucher`
        : `${BatchError.VOUCHER_SIGNATURE}: refund missing voucher`,
    );
  }
  const cumulative = await verifyCloseVoucher(voucher, payload.channelConfig, channelId);
  const channel = await deps.readChannel(requirements.network, channelId);
  if (channel && (cumulative < channel.settlement.settled || cumulative > channel.deposit)) {
    throw new Error(
      `${BatchError.CUMULATIVE_AMOUNT_MISMATCH}: refund voucher must lie within settled and deposit`,
    );
  }

  void context;
  const bound = await deps.resolveReceiverAuthorizer(requirements.network, channelId);
  if (bound !== undefined) {
    requireReceiverAuthorizer(bound, terms.receiverAuthorizer, channelId);
    return { channelId, terms };
  }
  if (payload.transaction === undefined) {
    throw new Error(
      `${BatchError.RECEIVER_BINDING_UNAVAILABLE}: resend the refund with a payer-signed request_close transaction`,
    );
  }
  try {
    await verifyRequestCloseTransaction(payload.transaction, {
      channelId,
      feePayer: terms.feePayer,
      maxComputeUnits: limits.maxComputeUnits,
      maxPriorityFeeMicroLamports: limits.maxPriorityFeeMicroLamports,
      memo: terms.memo,
      payer: payload.channelConfig.payer,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${BatchError.REFUND_TRANSACTION}: ${detail}`);
  }
  return { channelId, requestClose: payload.transaction, terms };
}

/**
 * Verify a refund against the channel's current onchain state.
 *
 * @param deps - Scheme internals
 * @param payload - The refund payload
 * @param requirements - The server's requirements for the channel
 * @param limits - Operator ceilings the `request_close` must respect
 * @param context - Facilitator extensions (used by delegated caller identity)
 * @returns The channel, its id, and the resolved terms
 */
export async function validateRefund(
  deps: SealDependencies,
  payload: BatchRefundPayload,
  requirements: PaymentRequirements,
  limits: RefundLimits,
  context?: FacilitatorContext,
): Promise<{ channel: Channel; channelId: string; terms: SealTerms }> {
  const { channelId, terms } = await prepareRefund(deps, payload, requirements, limits, context);
  const channel = await deps.fetchChannel(requirements.network, channelId);
  deps.assertClaimChannel(channel, payload.channelConfig, terms, requirements, [
    ChannelStatus.Open,
    ChannelStatus.Closing,
  ]);
  return { channel, channelId, terms };
}

/**
 * Close an `Open` channel cooperatively for a refund. A channel whose payer
 * already started a sponsored close reports that close instead.
 *
 * @param deps - Scheme internals
 * @param payment - The settle request envelope
 * @param payload - The refund payload
 * @param requirements - The server's requirements for the channel
 * @param prepared - The validated refund
 * @param context - Facilitator extensions (used by delegated caller identity)
 * @returns The settle response
 */
export async function settleCooperativeRefund(
  deps: SealDependencies,
  payment: PaymentPayload,
  payload: BatchRefundPayload,
  requirements: PaymentRequirements,
  prepared: PreparedRefund,
  context?: FacilitatorContext,
): Promise<SettleResponse> {
  const { channelId, terms } = prepared;
  const current = await deps.readChannel(requirements.network, channelId);
  if (current?.status === ChannelStatus.Closing) {
    deps.assertClaimChannel(current, payload.channelConfig, terms, requirements, [
      ChannelStatus.Closing,
    ]);
    return refundResponse(channelId, current, requirements.network, "");
  }
  const seal: BatchSealPayload = {
    channelConfig: payload.channelConfig,
    channelId,
    type: "seal",
    voucher: payload.voucher,
    ...(payload.closeAuthorization ? { closeAuthorization: payload.closeAuthorization } : {}),
  };
  return settleSeal(deps, payment, seal, requirements, "refund", context);
}

/**
 * Check a close voucher: this channel, no expiry, signed by the payer authorizer.
 *
 * @param voucher - The voucher to apply
 * @param config - Channel configuration naming the payer authorizer
 * @param channelId - Channel PDA
 * @returns The voucher's cumulative amount
 */
async function verifyCloseVoucher(
  voucher: BatchVoucher,
  config: BatchChannelConfig,
  channelId: string,
): Promise<bigint> {
  if (voucher.channelId !== channelId) throw new Error(BatchError.CHANNEL_ID_MISMATCH);
  if (voucher.expiresAt !== CLIENT_VOUCHER_EXPIRES_AT) throw new Error(BatchError.VOUCHER_EXPIRY);
  const cumulative = parseU64(voucher.maxClaimableAmount, "maxClaimableAmount");
  const valid = await verifyVoucherSignature({
    message: encodeVoucherMessageBytes({
      channelId,
      cumulativeAmount: cumulative,
      expiresAt: BigInt(CLIENT_VOUCHER_EXPIRES_AT),
    }),
    signatureBase58: voucher.signature,
    signerBase58: config.payerAuthorizer,
  });
  if (!valid) throw new Error(BatchError.VOUCHER_SIGNATURE);
  return cumulative;
}

/**
 * Bind the request to the server through its `CloseAuthorization`.
 *
 * The key it must verify against is the receiver authorizer bound to the
 * channel by its open's binding memo. A key that merely appears in the
 * request is never trusted on its own (spec §3).
 *
 * @param deps - Scheme internals
 * @param payload - The close payload
 * @param requirements - The server's requirements
 * @param terms - Resolved terms
 * @param channelId - Channel PDA
 * @param cumulative - Final voucher amount the authorization must bind
 * @param intent - Which close this is; selects the delegated identity step
 * @param context - Facilitator extensions (used by delegated caller identity)
 */
async function authenticateServer(
  deps: SealDependencies,
  payload: BatchSealPayload,
  requirements: PaymentRequirements,
  terms: SealTerms,
  channelId: string,
  cumulative: bigint,
  intent: CloseIntent,
  context?: FacilitatorContext,
): Promise<void> {
  const bound = requireReceiverAuthorizer(
    await deps.resolveReceiverAuthorizer(requirements.network, channelId),
    terms.receiverAuthorizer,
    channelId,
  );
  if (deps.isDelegatedAuthorizer(bound)) {
    const identity = await deps.resolveDelegatedIdentity({
      channelId,
      facilitatorContext: context,
      network: requirements.network,
      payer: payload.channelConfig.payer,
      step: intent === "refund" ? "refund" : "seal",
    });
    const stored = await deps.getDelegatedCallerIdentity(requirements.network, channelId);
    if (!identity || identity !== stored) {
      throw new Error(
        `${BatchError.DELEGATED_UNAUTHENTICATED}: caller identity does not match the channel binding`,
      );
    }
    return;
  }
  if (!payload.closeAuthorization) {
    throw new Error(`${BatchError.CLOSE_AUTHORIZATION}: a closeAuthorization is required`);
  }
  const binding = {
    channelId,
    feePayer: terms.feePayer,
    maxClaimableAmount: cumulative,
    network: requirements.network,
    voucherExpiresAt: 0n,
  };
  const valid = await verifyCloseAuthorization(
    payload.closeAuthorization,
    binding,
    bound,
    requirements.maxTimeoutSeconds,
    deps.nowSeconds(),
  );
  if (valid) return;
  throw new Error(
    `${BatchError.CLOSE_AUTHORIZATION}: signature does not bind this close or is outside its validity window`,
  );
}
