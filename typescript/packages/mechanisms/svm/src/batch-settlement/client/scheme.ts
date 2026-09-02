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
import {
  buildTopUpPaymentChannelTransaction,
  findPaymentChannelPda,
  parseU64,
} from "../../payment-channels/open";
import { encodeVoucherMessageBytes, verifyVoucherSignature } from "../../payment-channels/voucher";
import type { ClientSvmConfig } from "../../signer";
import { createRpcClient, resolveBlockhash, resolveOpenSlot } from "../../utils";
import { BatchError } from "../errors";
import {
  BATCH_SETTLEMENT_SCHEME,
  isBatchPayload,
  type BatchChannelState,
  type BatchPayload,
  type BatchVoucherState,
} from "../types";
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
      const recovered = await this.handlePaymentResponse(ctx);
      return recovered ? { recovered: true } : undefined;
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

  /**
   * Reconcile local channel state with the server's answer.
   *
   * Returns whether the client resynchronized and the request should be
   * retried.
   */
  private async handlePaymentResponse(ctx: PaymentResponseContext): Promise<boolean> {
    const payload = ctx.paymentPayload.payload;
    if (!isBatchPayload(payload) || (payload.type !== "voucher" && payload.type !== "deposit")) {
      return false;
    }
    const pending = [...this.pending.values()].find(
      candidate => candidate.tracker.channelId === payload.voucher.channelId,
    );
    if (!pending) return false;
    this.pending.delete(pending.key);

    if (!ctx.settleResponse?.success) {
      await this.restoreConfirmedChannel(pending);
      // A corrective 402 carries the base the server is actually charging
      // from. Adopting it — against this client's own signature — turns a
      // dead channel back into a usable one.
      return ctx.paymentRequired
        ? this.adoptCorrectiveState(pending, ctx.paymentRequired)
        : false;
    }

    // The response is the server's report, not this client's accounting. The
    // charge is capped at the price this request advertised, the cumulative is
    // computed locally and only cross-checked against the server's, and the
    // escrow comes from the deposit this client itself signed.
    const extra = ctx.settleResponse.extra as
      | {
          commitmentId?: unknown;
          chargedAmount?: unknown;
          channelState?: { balance?: unknown; chargedCumulativeAmount?: unknown };
        }
      | undefined;
    const requestAmount = parseU64(ctx.requirements.amount, "requirements.amount");
    const charged =
      typeof extra?.chargedAmount === "string" && /^\d+$/.test(extra.chargedAmount)
        ? BigInt(extra.chargedAmount)
        : undefined;
    if (charged === undefined || charged > requestAmount) {
      throw new Error("batch-settlement PAYMENT-RESPONSE charged more than the advertised price");
    }
    const confirmedCumulative = (pending.confirmed?.tracker.cumulative ?? 0n) + charged;
    const reported = extra?.channelState?.chargedCumulativeAmount;
    if (
      extra?.commitmentId !== `${payload.voucher.channelId}:${pending.cumulative}` ||
      confirmedCumulative !== pending.cumulative ||
      (typeof reported === "string" && reported !== confirmedCumulative.toString())
    ) {
      // The server confirmed something this client did not submit. Leave local
      // state untouched rather than adopt an accounting it cannot derive; the
      // next request resynchronizes through a corrective 402.
      await this.restoreConfirmedChannel(pending);
      return false;
    }
    // A deposit's escrow is what this client signed for, not what the server
    // reports holding.
    const deposited =
      payload.type === "deposit" ? parseU64(payload.deposit.amount, "deposit.amount") : 0n;
    pending.tracker.commit(pending.cumulative);
    pending.deposit = (pending.confirmed?.deposit ?? 0n) + deposited;
    this.channels.set(pending.key, pending);
    await this.config.channelStorage?.set(pending.key, {
      channelConfig: pending.tracker.channelConfig,
      channelId: pending.tracker.channelId,
      chargedCumulativeAmount: pending.cumulative.toString(),
      deposit: pending.deposit.toString(),
    });
    return false;
  }

  /**
   * Adopt the cumulative base from a corrective 402.
   *
   * The snapshot is only the server's word for what it has charged, so it is
   * accepted only against `voucherState`: an Ed25519 signature over the
   * 50-byte voucher message, which only this client's own authorizer key could
   * have produced. Without that proof the server has no accepted voucher, and
   * the client resynchronizes from the onchain settled watermark instead.
   */
  private async adoptCorrectiveState(
    pending: PendingChannel,
    paymentRequired: { error?: string | undefined; accepts: PaymentRequirements[] },
  ): Promise<boolean> {
    if (paymentRequired.error !== BatchError.CUMULATIVE_AMOUNT_MISMATCH) return false;
    const accept = paymentRequired.accepts.find(
      candidate => candidate.scheme === BATCH_SETTLEMENT_SCHEME,
    );
    const channelState = accept?.extra?.channelState as BatchChannelState | undefined;
    if (!channelState?.chargedCumulativeAmount) return false;
    const charged = parseU64(channelState.chargedCumulativeAmount, "chargedCumulativeAmount");
    const claimed = parseU64(channelState.totalClaimed, "totalClaimed");
    // A server may never claim to have charged less than the chain has already
    // settled, nor more than the client signed for.
    if (charged < claimed) return false;

    const voucherState = accept?.extra?.voucherState as BatchVoucherState | undefined;
    if (voucherState) {
      const signed = parseU64(voucherState.signedMaxClaimable, "signedMaxClaimable");
      if (charged > signed) return false;
      const verified = await verifyVoucherSignature({
        message: encodeVoucherMessageBytes({
          channelId: pending.tracker.channelId,
          cumulativeAmount: signed,
          expiresAt: BigInt(voucherState.expiresAt),
        }),
        signatureBase58: voucherState.signature,
        signerBase58: pending.tracker.channelConfig.payerAuthorizer,
      });
      if (!verified) return false;
    } else if (charged !== claimed) {
      // No proof: the only base a client may adopt unproven is the one the
      // chain itself reports as settled.
      return false;
    }

    const adopted: OpenChannel = {
      deposit: parseU64(channelState.balance, "channelState.balance"),
      tracker: new BatchChannelTracker(
        pending.tracker.channelId,
        pending.tracker.channelConfig,
        this.signer,
        charged,
      ),
    };
    this.channels.set(pending.key, adopted);
    await this.config.channelStorage?.set(pending.key, {
      channelConfig: adopted.tracker.channelConfig,
      channelId: adopted.tracker.channelId,
      chargedCumulativeAmount: charged.toString(),
      deposit: adopted.deposit.toString(),
    });
    return true;
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
