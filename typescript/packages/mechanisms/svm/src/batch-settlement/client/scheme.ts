/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param-description, jsdoc/require-returns */
import { type Address } from "@solana/kit";
import { fetchMint } from "@solana-program/token-2022";
import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeClientHooks,
  SchemeNetworkClient,
} from "@x402/core/types";

import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "../../constants";
import { findDefaultAsset } from "../../defaultAssets";
import { buildTopUpPaymentChannelTransaction, parseU64 } from "../../payment-channels/open";
import type { ClientSvmConfig } from "../../signer";
import { createRpcClient, resolveBlockhash, resolveOpenSlot } from "../../utils";
import { BATCH_SETTLEMENT_SCHEME, isBatchPayload, type BatchPayload } from "../types";
import {
  type BatchClientSigner,
  BatchChannelTracker,
  buildDepositPayload,
  buildRefundPayload,
} from "./channel";

interface OpenChannel {
  tracker: BatchChannelTracker;
  deposit: bigint;
}

type PendingPayment = {
  payload: Extract<BatchPayload, { type: "deposit" | "voucher" }>;
  x402Version: number;
};
type PendingChannel = OpenChannel & {
  /** Confirmed allocation to restore if this pending request is rejected. */
  confirmed?: OpenChannel | undefined;
  key: string;
  amount: string;
  cumulative: bigint;
  payment: PendingPayment;
};
type PaymentResponseContext = Parameters<NonNullable<SchemeClientHooks["onPaymentResponse"]>>[0];

/** A serializable, confirmed client channel allocation. */
export interface BatchClientChannelRecord {
  channelConfig: OpenChannel["tracker"]["channelConfig"];
  channelId: string;
  chargedCumulativeAmount: string;
  deposit: string;
  /** Whether the top-level allocation is confirmed while `pending` is in flight. */
  hasConfirmedState?: boolean | undefined;
  pending?: {
    amount: string;
    chargedCumulativeAmount: string;
    deposit: string;
    payment: PendingPayment;
  };
}

/** Optional durable storage for confirmed client allocations. */
export interface BatchClientChannelStorage {
  get(key: string): Promise<BatchClientChannelRecord | undefined>;
  set(key: string, record: BatchClientChannelRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface BatchSvmClientConfig extends ClientSvmConfig {
  /** Deposit used for a new channel. Defaults to one request charge. */
  depositAmount?: bigint | string | undefined;
  /** Persists confirmed state and a replayable pending allocation. */
  channelStorage?: BatchClientChannelStorage | undefined;
}

export class BatchSvmScheme implements SchemeNetworkClient {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  findDefaultAsset = findDefaultAsset;
  readonly schemeHooks: SchemeClientHooks = {
    onPaymentResponse: async ctx => {
      await this.handlePaymentResponse(ctx);
    },
  };
  private readonly channels = new Map<string, OpenChannel>();
  private readonly pending = new Map<string, PendingChannel>();

  constructor(
    private readonly signer: BatchClientSigner,
    private readonly config: BatchSvmClientConfig = {},
  ) {}

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    const terms = await this.resolveTerms(requirements);
    const charge = parseU64(requirements.amount, "amount");
    if (charge === 0n) throw new Error("batch-settlement amount must be positive");
    const key = this.channelKey(requirements, terms.feePayer, terms.withdrawDelay);
    const existing = await this.loadChannel(key);
    const pending = this.pending.get(key);
    if (pending) {
      if (pending.amount !== requirements.amount) {
        throw new Error("batch-settlement channel has a pending allocation for a different amount");
      }
      return pending.payment;
    }
    if (existing) {
      const cumulative = existing.tracker.cumulative + charge;
      const voucher = await existing.tracker.previewVoucher(charge);
      if (cumulative <= existing.deposit) {
        const payment: PendingPayment = {
          x402Version,
          payload: { channelConfig: existing.tracker.channelConfig, type: "voucher", voucher },
        };
        const next = {
          ...existing,
          amount: requirements.amount,
          confirmed: existing,
          cumulative,
          key,
          payment,
        };
        this.pending.set(key, next);
        await this.persistPending(next);
        return payment;
      }
      const configured = this.config.depositAmount
        ? parseU64(this.config.depositAmount, "depositAmount")
        : charge;
      const topUpAmount =
        configured >= cumulative - existing.deposit ? configured : cumulative - existing.deposit;
      const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
      const blockhash = await resolveBlockhash(rpc, requirements);
      const topUp = await buildTopUpPaymentChannelTransaction({
        amount: topUpAmount,
        blockhash,
        channelId: existing.tracker.channelId,
        feePayer: terms.feePayer,
        memo: terms.memo,
        mint: requirements.asset,
        payer: this.signer,
        tokenProgram: terms.tokenProgram,
      });
      const payment: PendingPayment = {
        x402Version,
        payload: {
          channelConfig: existing.tracker.channelConfig,
          deposit: { amount: topUpAmount.toString(), transaction: topUp.transaction },
          type: "deposit",
          voucher,
        },
      };
      const next = {
        ...existing,
        amount: requirements.amount,
        confirmed: existing,
        cumulative,
        deposit: existing.deposit + topUpAmount,
        key,
        payment,
      };
      this.pending.set(key, next);
      await this.persistPending(next);
      return payment;
    }

    const deposit = this.config.depositAmount
      ? parseU64(this.config.depositAmount, "depositAmount")
      : charge;
    if (deposit < charge) throw new Error("depositAmount must cover the current request");
    const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
    const [blockhash, openSlot] = await Promise.all([
      resolveBlockhash(rpc, requirements),
      resolveOpenSlot(rpc, requirements),
    ]);
    const built = await buildDepositPayload({
      blockhash,
      depositAmount: deposit,
      feePayer: terms.feePayer,
      firstCharge: charge,
      memo: terms.memo,
      mint: requirements.asset,
      openSlot,
      payer: this.signer,
      receiver: requirements.payTo,
      receiverAuthorizer: terms.receiverAuthorizer,
      tokenProgram: terms.tokenProgram,
      withdrawDelay: terms.withdrawDelay,
    });
    const payment: PendingPayment = { payload: built.payload, x402Version };
    const next = {
      amount: requirements.amount,
      cumulative: charge,
      deposit,
      key,
      payment,
      tracker: built.tracker,
    };
    this.pending.set(key, next);
    await this.persistPending(next);
    return payment;
  }

  /**
   * Build the payer-signed portable refund operation for the cached channel.
   *
   * @param x402Version
   * @param requirements
   */
  async createRefundPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    const terms = await this.resolveTerms(requirements);
    const key = this.channelKey(requirements, terms.feePayer, terms.withdrawDelay);
    const existing = await this.loadChannel(key);
    if (!existing) throw new Error("no cached batch-settlement channel to refund");
    const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
    const blockhash = await resolveBlockhash(rpc, requirements);
    return {
      x402Version,
      payload: await buildRefundPayload({
        blockhash,
        channelConfig: existing.tracker.channelConfig,
        channelId: existing.tracker.channelId,
        feePayer: terms.feePayer,
        memo: terms.memo,
        payer: this.signer,
      }),
    };
  }

  private async loadChannel(key: string): Promise<OpenChannel | undefined> {
    const cached = this.channels.get(key);
    if (cached) return cached;
    const saved = await this.config.channelStorage?.get(key);
    if (!saved) return undefined;
    if (saved.pending) {
      const confirmed = saved.hasConfirmedState ? this.hydrateChannel(saved) : undefined;
      if (confirmed) this.channels.set(key, confirmed);
      const tracker =
        confirmed?.tracker ??
        new BatchChannelTracker(saved.channelId, saved.channelConfig, this.signer);
      this.pending.set(key, {
        confirmed,
        tracker,
        amount: saved.pending.amount,
        cumulative: parseU64(saved.pending.chargedCumulativeAmount, "stored pending cumulative"),
        deposit: parseU64(saved.pending.deposit, "stored pending deposit"),
        key,
        payment: saved.pending.payment,
      });
      return confirmed;
    }
    const channel = this.hydrateChannel(saved);
    this.channels.set(key, channel);
    return channel;
  }

  private persistPending(pending: PendingChannel): Promise<void> | undefined {
    return this.config.channelStorage?.set(pending.key, {
      channelConfig: pending.tracker.channelConfig,
      channelId: pending.tracker.channelId,
      chargedCumulativeAmount: (pending.confirmed?.tracker.cumulative ?? 0n).toString(),
      deposit: (pending.confirmed?.deposit ?? 0n).toString(),
      hasConfirmedState: pending.confirmed !== undefined,
      pending: {
        amount: pending.amount,
        chargedCumulativeAmount: pending.cumulative.toString(),
        deposit: pending.deposit.toString(),
        payment: pending.payment,
      },
    });
  }

  private async handlePaymentResponse(ctx: PaymentResponseContext): Promise<void> {
    const payload = ctx.paymentPayload.payload;
    if (!isBatchPayload(payload) || (payload.type !== "voucher" && payload.type !== "deposit")) {
      return;
    }
    const pending = [...this.pending.values()].find(
      candidate => candidate.tracker.channelId === payload.voucher.channelId,
    );
    if (!pending) return;
    this.pending.delete(pending.key);

    if (!ctx.settleResponse?.success) {
      await this.restoreConfirmedChannel(pending);
      return;
    }
    const extra = ctx.settleResponse.extra as
      | {
          commitmentId?: unknown;
          chargedAmount?: unknown;
          channelState?: { balance?: unknown; chargedCumulativeAmount?: unknown };
        }
      | undefined;
    const charged = extra?.channelState?.chargedCumulativeAmount;
    const balance = extra?.channelState?.balance;
    if (
      extra?.commitmentId !== `${payload.voucher.channelId}:${pending.cumulative}` ||
      extra.chargedAmount !== ctx.requirements.amount ||
      charged !== pending.cumulative.toString() ||
      typeof balance !== "string"
    ) {
      throw new Error("batch-settlement PAYMENT-RESPONSE did not confirm the submitted allocation");
    }
    pending.tracker.commit(pending.cumulative);
    pending.deposit = parseU64(balance, "channelState.balance");
    this.channels.set(pending.key, pending);
    await this.config.channelStorage?.set(pending.key, {
      channelConfig: pending.tracker.channelConfig,
      channelId: pending.tracker.channelId,
      chargedCumulativeAmount: pending.cumulative.toString(),
      deposit: pending.deposit.toString(),
    });
  }

  private hydrateChannel(record: BatchClientChannelRecord): OpenChannel {
    return {
      deposit: parseU64(record.deposit, "stored deposit"),
      tracker: new BatchChannelTracker(
        record.channelId,
        record.channelConfig,
        this.signer,
        parseU64(record.chargedCumulativeAmount, "stored chargedCumulativeAmount"),
      ),
    };
  }

  private async restoreConfirmedChannel(pending: PendingChannel): Promise<void> {
    if (!pending.confirmed) {
      await this.config.channelStorage?.delete(pending.key);
      return;
    }
    this.channels.set(pending.key, pending.confirmed);
    await this.config.channelStorage?.set(pending.key, {
      channelConfig: pending.confirmed.tracker.channelConfig,
      channelId: pending.confirmed.tracker.channelId,
      chargedCumulativeAmount: pending.confirmed.tracker.cumulative.toString(),
      deposit: pending.confirmed.deposit.toString(),
    });
  }

  private channelKey(
    requirements: PaymentRequirements,
    feePayer: string,
    withdrawDelay: number,
  ): string {
    return [
      requirements.network,
      requirements.asset,
      requirements.payTo,
      feePayer,
      withdrawDelay,
      requirements.extra?.receiverAuthorizer ?? "",
    ].join(":");
  }

  private async resolveTerms(requirements: PaymentRequirements): Promise<{
    feePayer: string;
    receiverAuthorizer?: string | undefined;
    tokenProgram: string;
    withdrawDelay: number;
    memo?: string | undefined;
  }> {
    const extra = requirements.extra;
    if (!extra) throw new Error("requirements.extra is required");
    if (extra.paymentFlow !== undefined && extra.paymentFlow !== "authorization") {
      throw new Error('extra.paymentFlow must be "authorization" when present');
    }
    const feePayer = extra.feePayer;
    if (typeof feePayer !== "string" || feePayer.length === 0) {
      throw new Error("extra.feePayer must be a non-empty string");
    }
    const withdrawDelay = extra.withdrawDelay;
    if (
      typeof withdrawDelay !== "number" ||
      !Number.isInteger(withdrawDelay) ||
      withdrawDelay < 900 ||
      withdrawDelay > 2_592_000 ||
      withdrawDelay < requirements.maxTimeoutSeconds
    ) {
      throw new Error("extra.withdrawDelay is outside the allowed range");
    }
    const tokenProgram = extra.tokenProgram;
    if (tokenProgram !== TOKEN_PROGRAM_ADDRESS && tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS) {
      throw new Error("extra.tokenProgram is not a supported SPL token program");
    }
    const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
    const mint = await fetchMint(rpc, requirements.asset as Address);
    if (mint.programAddress.toString() !== tokenProgram) {
      throw new Error("extra.tokenProgram does not own requirements.asset");
    }
    const receiverAuthorizer = extra.receiverAuthorizer;
    if (receiverAuthorizer !== undefined && typeof receiverAuthorizer !== "string") {
      throw new Error("extra.receiverAuthorizer must be a string when present");
    }
    const memo = extra.memo;
    if (memo !== undefined && typeof memo !== "string") {
      throw new Error("extra.memo must be a string when present");
    }
    return {
      feePayer,
      ...(memo !== undefined ? { memo } : {}),
      ...(receiverAuthorizer !== undefined ? { receiverAuthorizer } : {}),
      tokenProgram,
      withdrawDelay,
    };
  }
}
