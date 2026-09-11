/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param-description, jsdoc/require-returns */
import { type Address } from "@solana/kit";
import { fetchMint } from "@solana-program/token-2022";
import type {
  PaymentPayloadContext,
  PaymentPayload,
  PaymentRequirements,
  SchemeClientHooks,
  SchemeNetworkClient,
} from "@x402/core/types";

import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "../../constants";
import { findDefaultAsset } from "../../defaultAssets";
import { buildTopUpPaymentChannelTransaction, parseU64 } from "../../payment-channels/open";
import { encodeVoucherMessageBytes, verifyVoucherSignature } from "../../payment-channels/voucher";
import { discoverChannelsByPayer, type ProgramAccountScan } from "../../payment-channels/discovery";
import { ChannelStatus } from "../../payment-channels/generated/types/channelStatus";
import type { ClientSvmConfig } from "../../signer";
import { createRpcClient, resolveBlockhash, resolveOpenSlot } from "../../utils";
import { BatchError } from "../errors";
import { verifyBatchSettlementReceipt } from "../receipt";
import {
  BATCH_SETTLEMENT_SCHEME,
  isBatchPayload,
  isBatchSettlementReceipt,
  isBatchVoucher,
  type BatchChannelState,
  type BatchPayload,
  type BatchSettlementReceipt,
  type BatchVoucher,
  type BatchVoucherState,
} from "../types";
import {
  type BatchClientSigner,
  BatchChannelTracker,
  buildDepositPayload,
  buildRefundPayload,
} from "./channel";
import { type BatchRefundOptions, refundBatchChannel } from "./refund";

interface OpenChannel {
  tracker: BatchChannelTracker;
  deposit: bigint;
}

type PendingPayment = {
  payload: Extract<BatchPayload, { type: "authorization" | "deposit" | "voucher" }>;
  x402Version: number;
};
type PendingChannel = OpenChannel & {
  /** Confirmed allocation to restore if this pending request is rejected. */
  confirmed?: OpenChannel | undefined;
  key: string;
  operationKey: string;
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
  pending?:
    | {
        amount: string;
        chargedCumulativeAmount: string;
        deposit: string;
        operationKey?: string | undefined;
        payment: PendingPayment;
      }
    | Array<{
        amount: string;
        chargedCumulativeAmount: string;
        deposit: string;
        operationKey: string;
        payment: PendingPayment;
      }>;
}

/** Optional durable storage for confirmed client allocations. */
export interface BatchClientChannelStorage {
  get(key: string): Promise<BatchClientChannelRecord | undefined>;
  set(key: string, record: BatchClientChannelRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface BatchSvmClientConfig extends ClientSvmConfig {
  /** Fixed deposit target. Overrides server hints and `depositPolicy`. */
  depositAmount?: bigint | string | undefined;
  /** Policy used to size deposits when `depositAmount` is not set. */
  depositPolicy?: { depositMultiplier?: number | undefined } | undefined;
  /** Persists confirmed state and a replayable pending allocation. */
  channelStorage?: BatchClientChannelStorage | undefined;
  /**
   * Channel-derivation salt. Defaults to `0`.
   *
   * A random salt would open a fresh channel on every start, stranding the
   * escrow in the last one behind a forced close. Change it only to run
   * several channels against the same server on purpose.
   */
  salt?: bigint | string | undefined;
  /**
   * Scan the chain for a channel this wallet already opened when no local
   * record exists. On by default; a client that keeps durable storage and
   * wants to avoid the scan can turn it off.
   */
  discoverChannels?: boolean | undefined;
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
  ) {
    const multiplier = config.depositPolicy?.depositMultiplier;
    if (multiplier !== undefined && (!Number.isInteger(multiplier) || multiplier < 3)) {
      throw new Error("depositMultiplier must be an integer >= 3");
    }
  }

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    const terms = await this.resolveTerms(requirements);
    const charge = parseU64(requirements.amount, "amount");
    if (charge === 0n) throw new Error("batch-settlement amount must be positive");
    const key = this.channelKey(requirements, terms.feePayer, terms.withdrawDelay);
    const existing = await this.loadChannel(key);
    const channelPending = [...this.pending.values()].filter(candidate => candidate.key === key);
    const blocking = channelPending.find(
      candidate =>
        candidate.payment.payload.type !== "authorization" || terms.voucherSigner !== "server",
    );
    if (blocking) {
      if (blocking.amount !== requirements.amount) {
        throw new Error("batch-settlement channel has a pending allocation for a different amount");
      }
      return blocking.payment;
    }
    if (existing) {
      const reserved = channelPending.reduce(
        (sum, candidate) => sum + BigInt(candidate.amount),
        0n,
      );
      const cumulative = existing.tracker.cumulative + reserved + charge;
      if (cumulative <= existing.deposit) {
        const idempotencyKey = terms.voucherSigner === "server" ? crypto.randomUUID() : undefined;
        const payload: Extract<BatchPayload, { type: "authorization" | "voucher" }> =
          terms.voucherSigner === "server"
            ? {
                authorization: await existing.tracker.authorization(),
                channelConfig: existing.tracker.channelConfig,
                idempotencyKey: idempotencyKey!,
                type: "authorization",
              }
            : {
                channelConfig: existing.tracker.channelConfig,
                type: "voucher",
                voucher: await existing.tracker.previewVoucher(charge),
              };
        const payment: PendingPayment = {
          x402Version,
          payload,
        };
        const next = {
          ...existing,
          amount: requirements.amount,
          confirmed: existing,
          cumulative,
          key,
          operationKey: idempotencyKey ? `${key}\u0000${idempotencyKey}` : key,
          payment,
        };
        this.pending.set(next.operationKey, next);
        await this.persistPending(next);
        return payment;
      }
      if (channelPending.length > 0) {
        throw new Error("batch-settlement channel has insufficient unreserved capacity");
      }
      const topUpAmount = this.resolveDepositAmount(
        requirements,
        charge,
        cumulative - existing.deposit,
        context,
      );
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
          ...(terms.voucherSigner === "server"
            ? {
                authorization: await existing.tracker.authorization(),
                idempotencyKey: crypto.randomUUID(),
              }
            : { voucher: await existing.tracker.previewVoucher(charge) }),
        },
      };
      const next = {
        ...existing,
        amount: requirements.amount,
        confirmed: existing,
        cumulative,
        deposit: existing.deposit + topUpAmount,
        key,
        operationKey: key,
        payment,
      };
      this.pending.set(next.operationKey, next);
      await this.persistPending(next);
      return payment;
    }

    // Before funding a second channel, look for one this wallet already opened.
    const discovered = await this.discoverChannel(requirements, terms);
    if (discovered) {
      this.channels.set(key, discovered);
      await this.config.channelStorage?.set(key, {
        channelConfig: discovered.tracker.channelConfig,
        channelId: discovered.tracker.channelId,
        chargedCumulativeAmount: discovered.tracker.cumulative.toString(),
        deposit: discovered.deposit.toString(),
      });
      return this.createPaymentPayload(x402Version, requirements, context);
    }

    if (
      this.config.depositAmount !== undefined &&
      parseU64(this.config.depositAmount, "depositAmount") < charge
    ) {
      throw new Error("depositAmount must cover the current request");
    }
    const deposit = this.resolveDepositAmount(requirements, charge, charge, context);
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
      salt: this.salt(),
      tokenProgram: terms.tokenProgram,
      withdrawDelay: terms.withdrawDelay,
      voucherSigner: terms.voucherSigner,
      ...(terms.operator ? { operator: terms.operator } : {}),
    });
    const payment: PendingPayment = { payload: built.payload, x402Version };
    const next = {
      amount: requirements.amount,
      cumulative: charge,
      deposit,
      key,
      operationKey:
        built.payload.authorization && built.payload.idempotencyKey
          ? `${key}\u0000${built.payload.idempotencyKey}`
          : key,
      payment,
      tracker: built.tracker,
    };
    this.pending.set(next.operationKey, next);
    await this.persistPending(next);
    return payment;
  }

  /**
   * Close the channel backing `url` and start its refund.
   *
   * Probes the route for the requirements the channel was opened against,
   * sends the payer-signed `request_close`, and returns what the server
   * reported. The escrow itself comes back after the forced-close grace
   * period, so a successful response means the close started, not that funds
   * have moved.
   *
   * @param url - Any protected route on the channel to close
   * @param options - Fetch override, or requirements to skip the probe
   * @returns The settlement response describing the initiated close
   */
  async refund(url: string, options?: BatchRefundOptions) {
    return refundBatchChannel(
      (x402Version, requirements) => this.createRefundPayload(x402Version, requirements),
      url,
      options,
    );
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
    // A client with no local record is exactly the one that needs to close a
    // channel it can no longer pay from, so fall back to the chain.
    const existing =
      (await this.loadChannel(key)) ?? (await this.discoverChannel(requirements, terms));
    if (!existing) throw new Error("no batch-settlement channel to refund");
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

  private salt(): bigint {
    return this.config.salt === undefined ? 0n : parseU64(this.config.salt, "salt");
  }

  private resolveDepositAmount(
    requirements: PaymentRequirements,
    requestAmount: bigint,
    needed: bigint,
    context: PaymentPayloadContext | undefined,
  ): bigint {
    const multiplier = this.config.depositPolicy?.depositMultiplier ?? 5;
    const configured =
      this.config.depositAmount === undefined
        ? undefined
        : parseU64(this.config.depositAmount, "depositAmount");
    const announced = parseAnnouncedMinDeposit(requirements.extra?.minDeposit, requestAmount);
    const target = configured ?? announced ?? requestAmount * BigInt(multiplier);
    const proposed = target > needed ? target : needed;
    const maxDeposit = maxDepositFromSpendCap(context?.maxAmountPerPayment, multiplier);
    if (maxDeposit !== undefined && needed > maxDeposit) {
      throw new Error(
        `Required deposit ${needed} exceeds depositMultiplier × spendControls.maxAmountPerPayment (${maxDeposit}). ` +
          "Raise maxAmountPerPayment or depositMultiplier.",
      );
    }
    return maxDeposit !== undefined && proposed > maxDeposit ? maxDeposit : proposed;
  }

  /**
   * Find a channel this wallet already opened against these terms.
   *
   * A client with no local record would otherwise open a second channel and
   * leave the first one's escrow to a forced close. The scan is filtered on
   * `payer`, and every row's PDA is rederived from its own fields before it is
   * trusted, so a crafted account cannot pass itself off as a channel.
   *
   * The adopted cumulative base is the onchain settled watermark: the charges
   * above it exist only in vouchers this client no longer has, and the server
   * rebuilds from the same watermark, so both sides agree.
   *
   * @param requirements
   * @param terms
   * @param terms.feePayer
   * @param terms.withdrawDelay
   * @param terms.tokenProgram
   * @param terms.receiverAuthorizer
   * @param terms.voucherSigner
   * @param terms.operator
   */
  private async discoverChannel(
    requirements: PaymentRequirements,
    terms: {
      feePayer: string;
      withdrawDelay: number;
      tokenProgram: string;
      receiverAuthorizer?: string | undefined;
      voucherSigner: "client" | "server";
      operator?: string | undefined;
    },
  ): Promise<OpenChannel | undefined> {
    if (this.config.discoverChannels === false) return undefined;
    const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
    const scan: ProgramAccountScan = async (programId, filters) =>
      (await rpc
        .getProgramAccounts(programId as Address, {
          commitment: "confirmed",
          encoding: "base64",
          filters: filters as never,
        })
        .send()) as never;
    let found;
    try {
      found = await discoverChannelsByPayer(scan, this.signer.address);
    } catch {
      // Discovery is an optimization over opening a new channel, never a
      // precondition for paying.
      return undefined;
    }
    const salt = this.salt();
    const usable = found.filter(
      candidate =>
        candidate.channel.status === ChannelStatus.Open &&
        candidate.channel.closureStartedAt === 0n &&
        candidate.channel.payee === terms.feePayer &&
        candidate.channel.mint === requirements.asset &&
        candidate.channel.authorizedSigner === (terms.operator ?? this.signer.address) &&
        candidate.channel.gracePeriod === terms.withdrawDelay &&
        candidate.channel.salt === salt,
    );
    // Prefer the newest, so a channel opened after an earlier one was drained
    // wins.
    usable.sort((left, right) => (left.channel.openSlot < right.channel.openSlot ? 1 : -1));
    const channel = usable[0];
    if (!channel) return undefined;
    return {
      deposit: channel.channel.deposit,
      tracker: new BatchChannelTracker(
        channel.channelId,
        {
          openSlot: Number(channel.channel.openSlot),
          payer: channel.channel.payer,
          payerAuthorizer: channel.channel.authorizedSigner,
          receiver: requirements.payTo,
          ...(terms.receiverAuthorizer ? { receiverAuthorizer: terms.receiverAuthorizer } : {}),
          salt: channel.channel.salt.toString(),
          token: channel.channel.mint,
          withdrawDelay: channel.channel.gracePeriod,
          ...(terms.voucherSigner === "server" ? { voucherSigner: "server" as const } : {}),
        },
        this.signer,
        channel.channel.settlement.settled,
      ),
    };
  }

  private async loadChannel(key: string): Promise<OpenChannel | undefined> {
    const cached = this.channels.get(key);
    if (cached) return cached;
    const saved = await this.config.channelStorage?.get(key);
    if (!saved) return undefined;
    if (saved.pending) {
      const savedPending = Array.isArray(saved.pending) ? saved.pending : [saved.pending];
      if (savedPending.length === 0) return this.hydrateAndCache(key, saved);
      const confirmed = saved.hasConfirmedState ? this.hydrateChannel(saved) : undefined;
      if (confirmed) this.channels.set(key, confirmed);
      const tracker =
        confirmed?.tracker ??
        new BatchChannelTracker(saved.channelId, saved.channelConfig, this.signer);
      for (const pending of savedPending) {
        const operationKey = pending.operationKey ?? key;
        this.pending.set(operationKey, {
          confirmed,
          tracker,
          amount: pending.amount,
          cumulative: parseU64(pending.chargedCumulativeAmount, "stored pending cumulative"),
          deposit: parseU64(pending.deposit, "stored pending deposit"),
          key,
          operationKey,
          payment: pending.payment,
        });
      }
      return confirmed;
    }
    return this.hydrateAndCache(key, saved);
  }

  private hydrateAndCache(key: string, record: BatchClientChannelRecord): OpenChannel {
    const channel = this.hydrateChannel(record);
    this.channels.set(key, channel);
    return channel;
  }

  private persistPending(pending: PendingChannel): Promise<void> | undefined {
    const allPending = [...this.pending.values()].filter(
      candidate => candidate.key === pending.key,
    );
    const confirmed = this.channels.get(pending.key) ?? pending.confirmed;
    return this.config.channelStorage?.set(pending.key, {
      channelConfig: pending.tracker.channelConfig,
      channelId: pending.tracker.channelId,
      chargedCumulativeAmount: (confirmed?.tracker.cumulative ?? 0n).toString(),
      deposit: (confirmed?.deposit ?? 0n).toString(),
      hasConfirmedState: confirmed !== undefined,
      pending: allPending.map(item => ({
        amount: item.amount,
        chargedCumulativeAmount: item.cumulative.toString(),
        deposit: item.deposit.toString(),
        operationKey: item.operationKey,
        payment: item.payment,
      })),
    });
  }

  /**
   * Reconcile local channel state with the server's answer.
   *
   * Returns whether the client resynchronized and the request should be
   * retried.
   *
   * @param ctx
   */
  // eslint-disable-next-line complexity
  private async handlePaymentResponse(ctx: PaymentResponseContext): Promise<boolean> {
    const payload = ctx.paymentPayload.payload;
    if (
      !isBatchPayload(payload) ||
      (payload.type !== "authorization" && payload.type !== "voucher" && payload.type !== "deposit")
    ) {
      return false;
    }
    const idempotencyKey =
      payload.type === "authorization"
        ? payload.idempotencyKey
        : payload.type === "deposit"
          ? payload.idempotencyKey
          : undefined;
    const voucherChannelId =
      payload.type === "voucher"
        ? payload.voucher.channelId
        : payload.type === "deposit"
          ? payload.voucher?.channelId
          : undefined;
    const pending = [...this.pending.values()].find(candidate =>
      idempotencyKey
        ? candidate.payment.payload.type !== "voucher" &&
          candidate.payment.payload.idempotencyKey === idempotencyKey
        : candidate.tracker.channelId === voucherChannelId,
    );
    if (!pending) return false;
    this.pending.delete(pending.operationKey);

    if (!ctx.settleResponse?.success) {
      await this.restoreConfirmedChannel(pending);
      // A corrective 402 carries the base the server is actually charging
      // from. Adopting it — against this client's own signature — turns a
      // dead channel back into a usable one.
      return ctx.paymentRequired ? this.adoptCorrectiveState(pending, ctx.paymentRequired) : false;
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
          receipt?: BatchSettlementReceipt;
          voucher?: BatchVoucher;
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
    let confirmedCumulative = (pending.confirmed?.tracker.cumulative ?? 0n) + charged;
    if (pending.tracker.channelConfig.voucherSigner === "server") {
      const receipt = extra?.receipt;
      const voucher = extra?.voucher;
      const receiptAmounts =
        isBatchSettlementReceipt(receipt) &&
        /^\d+$/.test(receipt.authorizedAmount) &&
        /^\d+$/.test(receipt.chargedAmount) &&
        /^\d+$/.test(receipt.priorCumulativeAmount) &&
        /^\d+$/.test(receipt.cumulativeAmount)
          ? {
              authorized: BigInt(receipt.authorizedAmount),
              charged: BigInt(receipt.chargedAmount),
              cumulative: BigInt(receipt.cumulativeAmount),
              prior: BigInt(receipt.priorCumulativeAmount),
            }
          : undefined;
      if (
        !isBatchSettlementReceipt(receipt) ||
        !isBatchVoucher(voucher) ||
        !receiptAmounts ||
        receipt.channelId !== pending.tracker.channelId ||
        receipt.idempotencyKey !== idempotencyKey ||
        receiptAmounts.authorized !== requestAmount ||
        receiptAmounts.charged !== charged ||
        receiptAmounts.prior + charged !== receiptAmounts.cumulative ||
        receipt.voucher.channelId !== voucher.channelId ||
        receipt.voucher.maxClaimableAmount !== voucher.maxClaimableAmount ||
        receipt.voucher.expiresAt !== voucher.expiresAt ||
        receipt.voucher.signature !== voucher.signature ||
        voucher.channelId !== pending.tracker.channelId ||
        voucher.expiresAt !== 0 ||
        voucher.maxClaimableAmount !== receipt.cumulativeAmount ||
        !(await verifyBatchSettlementReceipt(
          receipt,
          pending.tracker.channelConfig.payerAuthorizer,
        )) ||
        !(await verifyVoucherSignature({
          message: encodeVoucherMessageBytes({
            channelId: pending.tracker.channelId,
            cumulativeAmount: receiptAmounts.cumulative,
            expiresAt: BigInt(voucher.expiresAt),
          }),
          signatureBase58: voucher.signature,
          signerBase58: pending.tracker.channelConfig.payerAuthorizer,
        }))
      ) {
        await this.restoreConfirmedChannel(pending);
        throw new Error("batch-settlement PAYMENT-RESPONSE has an invalid server voucher");
      }
      confirmedCumulative = receiptAmounts.cumulative;
    }
    const reported = extra?.channelState?.chargedCumulativeAmount;
    if (
      extra?.commitmentId !== `${pending.tracker.channelId}:${confirmedCumulative}` ||
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
    if (confirmedCumulative > pending.tracker.cumulative) {
      pending.tracker.commit(confirmedCumulative);
    }
    pending.deposit = (pending.confirmed?.deposit ?? 0n) + deposited;
    const confirmed = { deposit: pending.deposit, tracker: pending.tracker };
    this.channels.set(pending.key, confirmed);
    const remaining = [...this.pending.values()].find(candidate => candidate.key === pending.key);
    if (remaining) await this.persistPending(remaining);
    else
      await this.config.channelStorage?.set(pending.key, {
        channelConfig: confirmed.tracker.channelConfig,
        channelId: confirmed.tracker.channelId,
        chargedCumulativeAmount: confirmed.tracker.cumulative.toString(),
        deposit: confirmed.deposit.toString(),
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
   *
   * @param pending
   * @param paymentRequired
   * @param paymentRequired.error
   * @param paymentRequired.accepts
   */
  private async adoptCorrectiveState(
    pending: PendingChannel,
    paymentRequired: { error?: string | undefined; accepts: PaymentRequirements[] },
  ): Promise<boolean> {
    if (paymentRequired.error !== BatchError.CUMULATIVE_AMOUNT_MISMATCH) return false;
    const accept = paymentRequired.accepts.find(
      candidate =>
        candidate.scheme === BATCH_SETTLEMENT_SCHEME &&
        (candidate.extra?.channelState as BatchChannelState | undefined)?.channelId ===
          pending.tracker.channelId,
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
    const remaining = [...this.pending.values()].find(candidate => candidate.key === pending.key);
    if (remaining) {
      await this.persistPending(remaining);
      return;
    }
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
      requirements.extra?.voucherSigner ?? "client",
      requirements.extra?.operator ?? "",
    ].join(":");
  }

  private async resolveTerms(requirements: PaymentRequirements): Promise<{
    feePayer: string;
    receiverAuthorizer?: string | undefined;
    tokenProgram: string;
    withdrawDelay: number;
    memo?: string | undefined;
    voucherSigner: "client" | "server";
    operator?: string | undefined;
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
    const voucherSigner = extra.voucherSigner ?? "client";
    if (voucherSigner !== "client" && voucherSigner !== "server") {
      throw new Error('extra.voucherSigner must be "client" or "server"');
    }
    const operator = extra.operator;
    if (voucherSigner === "server" && (typeof operator !== "string" || operator.length === 0)) {
      throw new Error("extra.operator is required for operator voucher signing");
    }
    if (voucherSigner === "client" && operator !== undefined) {
      throw new Error("extra.operator is only valid for operator voucher signing");
    }
    return {
      feePayer,
      ...(memo !== undefined ? { memo } : {}),
      ...(receiverAuthorizer !== undefined ? { receiverAuthorizer } : {}),
      tokenProgram,
      withdrawDelay,
      voucherSigner,
      ...(typeof operator === "string" ? { operator } : {}),
    };
  }
}

function parseAnnouncedMinDeposit(value: unknown, requestAmount: bigint): bigint | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = BigInt(value);
  return parsed >= requestAmount && parsed > 0n ? parsed : undefined;
}

function maxDepositFromSpendCap(
  maxAmountPerPayment: string | undefined,
  depositMultiplier: number,
): bigint | undefined {
  if (
    maxAmountPerPayment === undefined ||
    !/^\d+$/.test(maxAmountPerPayment) ||
    BigInt(maxAmountPerPayment) <= 0n
  ) {
    return undefined;
  }
  return BigInt(maxAmountPerPayment) * BigInt(depositMultiplier);
}
