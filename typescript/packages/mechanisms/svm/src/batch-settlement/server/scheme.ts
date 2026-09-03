/* eslint-disable jsdoc/require-jsdoc */
import type {
  SettleContext,
  SettleFailureContext,
  SettleResultContext,
  SkipHandlerDirective,
  VerifiedPaymentCanceledContext,
  VerifyContext,
  VerifyResultContext,
} from "@x402/core/server";
import type {
  AssetAmount,
  MoneyParser,
  SchemePaymentRequiredContext,
  Network,
  PaymentFlowConfig,
  PaymentPayload,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemeServerHooks,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { DeepReadonly } from "@x402/core/types";

import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "../../constants";
import { encodeVoucherMessageBytes, verifyVoucherSignature } from "../../payment-channels/voucher";
import { findPaymentChannelPda, parseU64 } from "../../payment-channels/open";
import {
  convertToTokenAmount,
  getStablecoinAddress,
  getStablecoinTokenProgram,
  numberToDecimalString,
} from "../../utils";
import { BatchError } from "../errors";
import type { BatchChannelConfig, BatchPayload, BatchVoucher } from "../types";
import { BATCH_SETTLEMENT_SCHEME, isBatchPayload } from "../types";
import { type ChannelState, type ChannelStore, MemoryChannelStore } from "./storage";

type ParsedMoney = { amount: number; stablecoin?: SvmStablecoinSymbol };
type SvmStablecoinSymbol = "USDC" | "USDT" | "USDG" | "PYUSD" | "CASH";
type RequestContext = {
  channelId: string;
  pendingId?: string;
  replay?: boolean;
  /**
   * Set when this server held no record for the channel, so the cumulative
   * rule could not be applied before the facilitator confirmed onchain state.
   * `afterVerify` rebuilds the record from that snapshot and applies it there.
   */
  unknownChannel?: boolean;
};

const PRICE_STABLECOINS = new Set(["USDC", "USDT", "USDG", "PYUSD", "CASH"]);
const MIN_WITHDRAW_DELAY = 900;
const MAX_WITHDRAW_DELAY = 2_592_000;
const CHANNEL_BUSY = "duplicate_settlement";

export interface BatchSvmServerConfig {
  withdrawDelay?: number | undefined;
  receiverAuthorizer?: string | undefined;
  store?: ChannelStore | undefined;
  /** Resolve the application response cached under a replayed commitment. */
  getReplayResponse?:
    | ((commitment: {
        channelId: string;
        commitmentId: string;
      }) => Promise<SkipHandlerDirective | undefined>)
    | undefined;
}

/**
 * SVM resource-server implementation for `batch-settlement`.
 *
 * The server, not the facilitator, owns the offchain voucher watermark. Hooks
 * reserve a voucher during verification, leave the reservation unchanged while
 * the handler runs, and commit it only during the after-handler settle phase.
 */
export class BatchSvmScheme implements SchemeNetworkServer {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly defaultAssetTransferMethod = "channel";
  readonly paymentFlows = {
    channel: { default: "authorization", supported: ["authorization"] },
  } as const satisfies Record<string, PaymentFlowConfig>;
  readonly dynamicExtraFields = ["recentBlockhash", "recentSlot"];
  readonly schemeHooks: SchemeServerHooks;

  private readonly store: ChannelStore;
  private readonly requestContexts = new WeakMap<DeepReadonly<PaymentPayload>, RequestContext>();
  private moneyParsers: MoneyParser[] = [];
  private reservationSequence = 0;

  constructor(private readonly config: BatchSvmServerConfig = {}) {
    this.store = config.store ?? new MemoryChannelStore();
    this.schemeHooks = {
      onBeforeVerify: ctx => this.beforeVerify(ctx),
      onAfterVerify: ctx => this.afterVerify(ctx),
      onBeforeSettle: ctx => this.beforeSettle(ctx),
      onAfterSettle: ctx => this.afterSettle(ctx),
      onSettleFailure: ctx => this.onSettleFailure(ctx),
      onVerifiedPaymentCanceled: ctx => this.onCanceled(ctx),
    };
  }

  /**
   * Attach the corrective channel state a client needs to resynchronize after
   * a cumulative-amount mismatch.
   *
   * The snapshot alone would be the server's unproven word for how much it has
   * charged, so it travels with `voucherState`: the signature the client itself
   * produced at that cumulative amount. A server with no accepted voucher —
   * one that just rebuilt the record from onchain state — omits the proof, and
   * the client resynchronizes from the chain instead. See spec section 4.6.
   *
   * @param ctx - Payment-required context for the failed request
   * @returns The enriched requirements, or nothing when there is nothing to add
   */
  enrichPaymentRequiredResponse = async (
    ctx: SchemePaymentRequiredContext,
  ): Promise<PaymentRequirements[] | void> => {
    if (ctx.error !== BatchError.CUMULATIVE_AMOUNT_MISMATCH) return;
    const raw = ctx.paymentPayload?.payload;
    if (!raw || !isBatchPayload(raw)) return;
    // The mismatch is usually detected before any request context exists, so
    // the channel comes from the payload — and only from one that validates,
    // signature included. Otherwise naming a channel would be enough to read
    // its state.
    let channelId: string;
    try {
      channelId = await this.validatePayload(raw, ctx.paymentPayload!.accepted);
    } catch {
      return;
    }
    const state = await this.store.get(channelId);
    if (!state) return;
    const accept = ctx.requirements.find(
      requirement =>
        requirement.scheme === BATCH_SETTLEMENT_SCHEME &&
        requirement.network === ctx.paymentPayload!.accepted.network,
    );
    if (!accept) return;
    accept.extra = {
      ...accept.extra,
      channelState: {
        channelId: state.channelId,
        balance: state.deposit.toString(),
        totalClaimed: state.settled.toString(),
        withdrawRequestedAt: state.closeRequestedAt ?? 0,
        chargedCumulativeAmount: state.chargedCumulativeAmount.toString(),
      },
      ...(state.highestVoucherSignature !== undefined
        ? {
            voucherState: {
              signedMaxClaimable: state.signedMaxClaimable.toString(),
              expiresAt: state.highestVoucherExpiresAt ?? 0,
              signature: state.highestVoucherSignature,
            },
          }
        : {}),
    };
    return ctx.requirements;
  };

  getChannelStore(): ChannelStore {
    return this.store;
  }

  registerMoneyParser(parser: MoneyParser): BatchSvmScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      }
      return { amount: price.amount, asset: price.asset, extra: price.extra || {} };
    }
    const { amount, stablecoin } = this.parseMoney(price);
    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) return result;
    }
    return this.defaultMoneyConversion(amount, network, stablecoin);
  }

  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    void extensionKeys;
    const withdrawDelay =
      this.config.withdrawDelay ??
      Math.max(MIN_WITHDRAW_DELAY, paymentRequirements.maxTimeoutSeconds);
    if (withdrawDelay > MAX_WITHDRAW_DELAY) {
      throw new Error(BatchError.WITHDRAW_DELAY_OUT_OF_RANGE);
    }
    return Promise.resolve({
      ...paymentRequirements,
      extra: {
        ...paymentRequirements.extra,
        ...supportedKind.extra,
        tokenProgram: getStablecoinTokenProgram(
          paymentRequirements.asset,
          paymentRequirements.network,
        ),
        withdrawDelay,
        ...(this.config.receiverAuthorizer
          ? { receiverAuthorizer: this.config.receiverAuthorizer }
          : {}),
      },
    });
  }

  private async beforeVerify(
    ctx: VerifyContext,
  ): Promise<
    | void
    | { abort: true; reason: string; message?: string }
    | { skip: true; result: VerifyResponse }
  > {
    const raw = ctx.paymentPayload.payload;
    if (!isBatchPayload(raw)) return;
    try {
      const channelId = await this.validatePayload(raw, ctx.requirements);
      const state = await this.store.get(channelId);
      if (state) this.assertStoredConfig(state, raw.channelConfig);

      if (raw.type === "deposit" || raw.type === "voucher") {
        // A channel this server holds no record for is not a dead end: the
        // facilitator verifies the voucher against confirmed onchain state,
        // and `afterVerify` rebuilds the record from the snapshot it returns.
        // Refusing here instead would strand the payer's escrow behind a
        // forced close every time this server lost its store.
        if (!state && raw.type === "voucher") {
          this.requestContexts.set(ctx.paymentPayload, { channelId, unknownChannel: true });
          return;
        }
        const expected = (state?.chargedCumulativeAmount ?? 0n) + BigInt(ctx.requirements.amount);
        const submitted = BigInt(raw.voucher.maxClaimableAmount);
        const replay =
          state !== undefined &&
          submitted === state.chargedCumulativeAmount &&
          raw.voucher.signature === state.highestVoucherSignature;
        if (!replay && submitted !== expected) {
          throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
        }
        this.requestContexts.set(ctx.paymentPayload, { channelId, replay });
      } else {
        if (!state) throw new Error(BatchError.CHANNEL_STATE);
        this.requestContexts.set(ctx.paymentPayload, { channelId });
      }
      // Deposits and refunds must be verified by the facilitator: it statically
      // validates the client-signed transaction before the resource executes.
      // Voucher verification also binds the cumulative authorization to the
      // confirmed channel deposit. Keep the request context for afterVerify,
      // but do not bypass facilitator verification here.
      return;
    } catch (error) {
      return {
        abort: true,
        reason: classifyError(error),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async afterVerify(
    ctx: VerifyResultContext,
  ): Promise<
    | void
    | { abort: true; reason: string; message?: string }
    | { skipHandler: true; response?: SkipHandlerDirective }
  > {
    const raw = ctx.paymentPayload.payload;
    if (!ctx.result.isValid || !isBatchPayload(raw)) return;
    const request = this.requestContexts.get(ctx.paymentPayload);
    if (!request) return this.abort(BatchError.CHANNEL_STATE, "missing request state");
    if (request.replay) {
      const state = await this.store.get(request.channelId);
      if (!state) return this.abort(BatchError.CHANNEL_STATE, "missing replay state");
      const commitmentId = `${state.channelId}:${state.signedMaxClaimable}`;
      const response = await this.config.getReplayResponse?.({
        channelId: state.channelId,
        commitmentId,
      });
      if (!response) {
        return this.abort(
          CHANNEL_BUSY,
          `cached application response unavailable for ${commitmentId}`,
        );
      }
      return {
        skipHandler: true,
        response,
      };
    }

    // The facilitator has now confirmed this payload against onchain state and
    // returned the channel snapshot. Persisting it is what lets a server with
    // no record of a live channel serve it, and what keeps `deposit`, `settled`
    // and the close state from drifting behind the chain.
    const snapshot = readVerifiedChannelState(ctx.result);
    if (snapshot && !this.applySnapshot(request.channelId, snapshot)) {
      return this.abort(BatchError.CHANNEL_STATE, "verified channel snapshot is unusable");
    }
    if (snapshot) {
      await this.persistSnapshot(request.channelId, raw, ctx.requirements, snapshot);
    }

    // The cumulative rule could not be applied before the record existed.
    if (request.unknownChannel) {
      const state = await this.store.get(request.channelId);
      if (!state) return this.abort(BatchError.CHANNEL_STATE, "channel state unavailable");
      const submitted = BigInt(raw.type === "refund" ? "0" : raw.voucher.maxClaimableAmount);
      const expected = state.chargedCumulativeAmount + BigInt(ctx.requirements.amount);
      if (submitted !== expected) {
        // The corrective 402 that follows carries this rebuilt snapshot and no
        // voucher proof, so the client resynchronizes from onchain state.
        return this.abort(
          BatchError.CUMULATIVE_AMOUNT_MISMATCH,
          `voucher authorizes ${submitted}, expected ${expected}`,
        );
      }
    }

    const pendingId = `${Date.now()}:${(this.reservationSequence += 1)}`;
    try {
      await this.store.update(request.channelId, current => {
        const state = current ?? this.provisionalState(raw, ctx.requirements, request.channelId);
        if (state.pendingRequest && state.pendingRequest.expiresAt > Date.now()) {
          throw new Error(CHANNEL_BUSY);
        }
        if (state.status !== "open") throw new Error(BatchError.CLOSE_STATE);
        this.assertStoredConfig(state, raw.channelConfig);
        return {
          ...state,
          pendingRequest: {
            expiresAt: Date.now() + Math.max(5_000, ctx.requirements.maxTimeoutSeconds * 1_000),
            id: pendingId,
            maxClaimableAmount:
              raw.type === "refund"
                ? state.signedMaxClaimable
                : BigInt(raw.voucher.maxClaimableAmount),
          },
        };
      });
      this.requestContexts.set(ctx.paymentPayload, { ...request, pendingId });
      if (raw.type === "refund") {
        return {
          skipHandler: true,
          response: { body: { channelId: request.channelId, message: "Refund initiated" } },
        };
      }
    } catch (error) {
      this.requestContexts.delete(ctx.paymentPayload);
      return this.abort(
        classifyError(error),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async beforeSettle(
    ctx: SettleContext,
  ): Promise<
    | void
    | { abort: true; reason: string; message?: string }
    | { skip: true; result: SettleResponse }
  > {
    const raw = ctx.paymentPayload.payload;
    if (!isBatchPayload(raw) || raw.type === "refund") return;

    const request = this.requestContexts.get(ctx.paymentPayload);
    if (request?.replay) {
      const state = await this.store.get(request.channelId);
      this.requestContexts.delete(ctx.paymentPayload);
      if (!state) return this.abort(BatchError.CHANNEL_STATE, "missing replay state");
      return { skip: true, result: acceptedResponse(state, ctx.requirements) };
    }
    if (!request?.pendingId) return this.abort(CHANNEL_BUSY, "missing reservation");
    const state = await this.store.get(request.channelId);
    if (!state || state.pendingRequest?.id !== request.pendingId) {
      return this.abort(CHANNEL_BUSY, "reservation changed");
    }

    // Deposits go to the facilitator, which broadcasts the open/top_up
    // transaction in this post-handler settle; the voucher commits in
    // afterSettle once the deposit succeeds.
    if (raw.type === "deposit") return;

    try {
      const committed = await this.store.update(request.channelId, current => {
        if (!current || current.pendingRequest?.id !== request.pendingId) {
          throw new Error(CHANNEL_BUSY);
        }
        return {
          ...current,
          chargedCumulativeAmount: BigInt(raw.voucher.maxClaimableAmount),
          highestVoucherExpiresAt: raw.voucher.expiresAt,
          highestVoucherSignature: raw.voucher.signature,
          pendingRequest: undefined,
          signedMaxClaimable: BigInt(raw.voucher.maxClaimableAmount),
        };
      });
      this.requestContexts.delete(ctx.paymentPayload);
      return { skip: true, result: acceptedResponse(committed, ctx.requirements) };
    } catch (error) {
      return this.abort(
        classifyError(error),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async afterSettle(ctx: SettleResultContext): Promise<void> {
    const raw = ctx.paymentPayload.payload;
    if (!ctx.result.success || !isBatchPayload(raw)) return;
    const request = this.requestContexts.get(ctx.paymentPayload);
    if (!request?.pendingId) return;

    if (raw.type === "deposit") {
      await this.store.update(request.channelId, current => {
        if (!current || current.pendingRequest?.id !== request.pendingId) {
          throw new Error(CHANNEL_BUSY);
        }
        const confirmed = readChannelState(ctx.result);
        return {
          ...current,
          // A top-up raises the escrow ceiling; without this the stored deposit
          // would stay at the original open amount forever.
          deposit: confirmedDeposit(current.deposit, confirmed.balance),
          openSignature: ctx.result.transaction,
          settled: BigInt(confirmed.totalClaimed),
          chargedCumulativeAmount: BigInt(raw.voucher.maxClaimableAmount),
          highestVoucherExpiresAt: raw.voucher.expiresAt,
          highestVoucherSignature: raw.voucher.signature,
          signedMaxClaimable: BigInt(raw.voucher.maxClaimableAmount),
          pendingRequest: undefined,
        };
      });
      this.requestContexts.delete(ctx.paymentPayload);
      return;
    }

    if (raw.type === "refund") {
      await this.store.update(request.channelId, current => {
        if (!current || current.pendingRequest?.id !== request.pendingId) {
          throw new Error(CHANNEL_BUSY);
        }
        const snapshot = readChannelState(ctx.result);
        return {
          ...current,
          closeRequestedAt: snapshot.withdrawRequestedAt,
          closeSignature: ctx.result.transaction,
          pendingRequest: undefined,
          status: "closing",
        };
      });
      this.requestContexts.delete(ctx.paymentPayload);
    }
  }

  private async onSettleFailure(ctx: SettleFailureContext): Promise<void> {
    await this.clearReservation(ctx.paymentPayload);
  }

  private async onCanceled(ctx: VerifiedPaymentCanceledContext): Promise<void> {
    await this.clearReservation(ctx.paymentPayload);
  }

  private async clearReservation(payload: DeepReadonly<PaymentPayload>): Promise<void> {
    const request = this.requestContexts.get(payload);
    this.requestContexts.delete(payload);
    if (!request?.pendingId) return;
    await this.store.update(request.channelId, current => {
      if (!current) throw new Error(BatchError.CHANNEL_STATE);
      if (current.pendingRequest?.id !== request.pendingId) return current;
      return { ...current, pendingRequest: undefined };
    });
  }

  private async validatePayload(
    raw: BatchPayload,
    requirements: PaymentRequirements,
  ): Promise<string> {
    const extra = requirements.extra;
    if (!extra || (extra.paymentFlow !== undefined && extra.paymentFlow !== "authorization")) {
      throw new Error(BatchError.PAYMENT_FLOW);
    }
    if (typeof extra.feePayer !== "string") throw new Error(BatchError.FEE_PAYER_MISMATCH);
    if (
      raw.channelConfig.payer === extra.feePayer ||
      raw.channelConfig.payerAuthorizer === extra.feePayer
    ) {
      throw new Error(BatchError.FEE_PAYER_MISMATCH);
    }
    if (
      raw.channelConfig.receiver !== requirements.payTo ||
      raw.channelConfig.token !== requirements.asset
    ) {
      throw new Error(BatchError.CHANNEL_STATE);
    }
    if (raw.channelConfig.withdrawDelay !== extra.withdrawDelay) {
      throw new Error(BatchError.WITHDRAW_DELAY_MISMATCH);
    }
    if (
      (raw.channelConfig.receiverAuthorizer === undefined) !==
        (extra.receiverAuthorizer === undefined) ||
      (raw.channelConfig.receiverAuthorizer !== undefined &&
        raw.channelConfig.receiverAuthorizer !== extra.receiverAuthorizer)
    ) {
      throw new Error(BatchError.RECEIVER_AUTHORIZER_MISMATCH);
    }
    if (
      extra.tokenProgram !== TOKEN_PROGRAM_ADDRESS &&
      extra.tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS
    ) {
      throw new Error(BatchError.TOKEN_PROGRAM);
    }
    const channelId = await findPaymentChannelPda({
      authorizedSigner: raw.channelConfig.payerAuthorizer,
      mint: raw.channelConfig.token,
      openSlot: BigInt(raw.channelConfig.openSlot),
      payee: extra.feePayer,
      payer: raw.channelConfig.payer,
      salt: BigInt(raw.channelConfig.salt),
    });
    if (raw.type === "deposit" || raw.type === "voucher") {
      if (raw.voucher.channelId !== channelId) throw new Error(BatchError.CHANNEL_ID_MISMATCH);
      this.assertExpiry(raw.voucher);
      const valid = await verifyVoucherSignature({
        message: encodeVoucherMessageBytes({
          channelId,
          cumulativeAmount: BigInt(raw.voucher.maxClaimableAmount),
          expiresAt: BigInt(raw.voucher.expiresAt),
        }),
        signatureBase58: raw.voucher.signature,
        signerBase58: raw.channelConfig.payerAuthorizer,
      });
      if (!valid) throw new Error(BatchError.VOUCHER_SIGNATURE);
    }
    return channelId;
  }

  private assertExpiry(voucher: BatchVoucher): void {
    if (voucher.expiresAt !== 0) throw new Error(BatchError.VOUCHER_EXPIRY);
  }

  /**
   * Whether a verified snapshot can be applied to this channel at all.
   *
   * A snapshot that reports a settled watermark above the escrow, or a channel
   * already closing, is not something to build a serving record on.
   *
   * @param channelId - Channel the snapshot must describe
   * @param snapshot - Confirmed onchain snapshot from the facilitator
   * @returns Whether the snapshot may be persisted
   */
  private applySnapshot(channelId: string, snapshot: VerifiedChannelState): boolean {
    if (snapshot.channelId !== undefined && snapshot.channelId !== channelId) return false;
    if (snapshot.withdrawRequestedAt !== 0) return false;
    if (snapshot.balance !== undefined && snapshot.totalClaimed > snapshot.balance) return false;
    return true;
  }

  /**
   * Merge a confirmed onchain snapshot into the channel record, creating it
   * when this server has none.
   *
   * A rebuilt record starts charging from the onchain settled watermark. That
   * is the most this server can honestly claim to have charged: a voucher
   * above it is unclaimable without the signature that vanished with the
   * store, so starting there forfeits nothing that was not already lost — and
   * starting from zero would accept vouchers the program can never settle,
   * because `settle` requires a strictly increasing watermark.
   *
   * @param channelId - Channel to merge into
   * @param raw - The payload the facilitator validated against the chain
   * @param requirements - Requirements that payload answered
   * @param snapshot - Confirmed onchain snapshot
   */
  private async persistSnapshot(
    channelId: string,
    raw: BatchPayload,
    requirements: PaymentRequirements,
    snapshot: VerifiedChannelState,
  ): Promise<void> {
    await this.store.update(channelId, current => {
      const base = current ?? this.recoveredState(raw, requirements, channelId, snapshot);
      return {
        ...base,
        // An escrow ceiling only ever rises; never let a stale read lower a
        // deposit the chain has confirmed.
        deposit:
          snapshot.balance !== undefined && snapshot.balance > base.deposit
            ? snapshot.balance
            : base.deposit,
        settled: snapshot.totalClaimed > base.settled ? snapshot.totalClaimed : base.settled,
        chargedCumulativeAmount:
          snapshot.totalClaimed > base.chargedCumulativeAmount
            ? snapshot.totalClaimed
            : base.chargedCumulativeAmount,
        signedMaxClaimable:
          snapshot.totalClaimed > base.signedMaxClaimable
            ? snapshot.totalClaimed
            : base.signedMaxClaimable,
        ...(snapshot.withdrawRequestedAt !== 0
          ? { closeRequestedAt: snapshot.withdrawRequestedAt, status: "closing" as const }
          : {}),
      };
    });
  }

  /**
   * A channel record rebuilt from a confirmed onchain snapshot.
   *
   * Every immutable field comes from the payload the facilitator validated
   * against that snapshot, so a record can only be built for a channel whose
   * bindings the client itself authorized.
   *
   * @param raw - The payload the facilitator validated against the chain
   * @param requirements - Requirements that payload answered
   * @param channelId - Channel the record is for
   * @param snapshot - Confirmed onchain snapshot
   * @returns A channel record seeded from the chain
   */
  private recoveredState(
    raw: BatchPayload,
    requirements: PaymentRequirements,
    channelId: string,
    snapshot: VerifiedChannelState,
  ): ChannelState {
    const extra = requirements.extra!;
    return {
      channelConfig: raw.channelConfig,
      channelId,
      chargedCumulativeAmount: snapshot.totalClaimed,
      deposit: snapshot.balance ?? 0n,
      feePayer: String(extra.feePayer),
      mint: requirements.asset,
      openSlot: BigInt(raw.channelConfig.openSlot),
      payer: raw.channelConfig.payer,
      payerAuthorizer: raw.channelConfig.payerAuthorizer,
      payoutWatermark: 0n,
      receiver: requirements.payTo,
      receiverAuthorizer: raw.channelConfig.receiverAuthorizer,
      salt: BigInt(raw.channelConfig.salt),
      settled: snapshot.totalClaimed,
      signedMaxClaimable: snapshot.totalClaimed,
      status: "open",
      tokenProgram: String(extra.tokenProgram),
      withdrawDelay: raw.channelConfig.withdrawDelay,
    };
  }

  private provisionalState(
    raw: BatchPayload,
    requirements: PaymentRequirements,
    channelId: string,
  ): ChannelState {
    if (raw.type !== "deposit") throw new Error(BatchError.CHANNEL_STATE);
    const extra = requirements.extra!;
    return {
      channelConfig: raw.channelConfig,
      channelId,
      chargedCumulativeAmount: 0n,
      deposit: parseU64(raw.deposit.amount, "deposit.amount"),
      feePayer: String(extra.feePayer),
      mint: requirements.asset,
      openSlot: BigInt(raw.channelConfig.openSlot),
      payer: raw.channelConfig.payer,
      payerAuthorizer: raw.channelConfig.payerAuthorizer,
      payoutWatermark: 0n,
      receiver: requirements.payTo,
      receiverAuthorizer: raw.channelConfig.receiverAuthorizer,
      salt: BigInt(raw.channelConfig.salt),
      settled: 0n,
      signedMaxClaimable: 0n,
      status: "open",
      tokenProgram: String(extra.tokenProgram),
      withdrawDelay: raw.channelConfig.withdrawDelay,
    };
  }

  private assertStoredConfig(state: ChannelState, config: BatchChannelConfig): void {
    if (JSON.stringify(state.channelConfig) !== JSON.stringify(config)) {
      throw new Error(BatchError.CHANNEL_STATE);
    }
  }

  private abort(reason: string, message: string) {
    return { abort: true as const, message, reason };
  }

  private parseMoney(money: string | number): ParsedMoney {
    if (typeof money === "number") return { amount: money };
    const cleanMoney = money.replace(/^\$/, "").trim();
    const amount = parseFloat(cleanMoney);
    if (isNaN(amount)) throw new Error(`Invalid money format: ${money}`);
    const suffix = cleanMoney
      .match(/[A-Za-z][A-Za-z0-9]*\s*$/)?.[0]
      .trim()
      .toUpperCase();
    if (suffix === "USD") return { amount, stablecoin: "USDC" };
    if (suffix && PRICE_STABLECOINS.has(suffix)) {
      return { amount, stablecoin: suffix as SvmStablecoinSymbol };
    }
    return { amount };
  }

  private defaultMoneyConversion(
    amount: number,
    network: Network,
    stablecoin: SvmStablecoinSymbol = "USDC",
  ): AssetAmount {
    return {
      amount: convertToTokenAmount(numberToDecimalString(amount), 6),
      asset: getStablecoinAddress(stablecoin, network),
      extra: {},
    };
  }
}

function acceptedResponse(state: ChannelState, requirements: PaymentRequirements): SettleResponse {
  return {
    success: true,
    payer: state.payer,
    transaction: "",
    network: requirements.network,
    amount: "",
    extra: {
      channelState: snapshot(state),
      // The fixed per-request price, on a fresh acceptance and on a replay
      // alike: a replay answers an authorization that was already charged this
      // amount, so reporting zero would tell the client it paid nothing for a
      // request it did pay for.
      chargedAmount: requirements.amount,
      commitmentId: `${state.channelId}:${state.pendingRequest?.maxClaimableAmount ?? state.signedMaxClaimable}`,
    },
  };
}

function snapshot(state: ChannelState) {
  return {
    channelId: state.channelId,
    balance: state.deposit.toString(),
    totalClaimed: state.settled.toString(),
    withdrawRequestedAt: state.closeRequestedAt ?? 0,
    chargedCumulativeAmount: state.chargedCumulativeAmount.toString(),
  };
}

/** A channel snapshot a facilitator confirmed against the chain. */
type VerifiedChannelState = {
  channelId?: string | undefined;
  balance?: bigint | undefined;
  totalClaimed: bigint;
  withdrawRequestedAt: number;
};

/**
 * Read the channel snapshot from a facilitator verify response.
 *
 * Returns nothing when the response carries none — a `deposit` verify has no
 * channel to snapshot yet — or when a field is not the shape it claims: a
 * malformed snapshot must not become a serving record.
 *
 * @param result - The facilitator's verify response
 * @returns The snapshot, or nothing when the response carries none
 */
function readVerifiedChannelState(result: VerifyResponse): VerifiedChannelState | undefined {
  const raw = (result.extra as { channelState?: unknown } | undefined)?.channelState;
  if (typeof raw !== "object" || raw === null) return undefined;
  const state = raw as Record<string, unknown>;
  const digits = (value: unknown): bigint | undefined =>
    typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : undefined;
  const totalClaimed = digits(state.totalClaimed);
  if (totalClaimed === undefined) return undefined;
  const withdrawRequestedAt =
    typeof state.withdrawRequestedAt === "number" && Number.isInteger(state.withdrawRequestedAt)
      ? state.withdrawRequestedAt
      : 0;
  return {
    ...(typeof state.channelId === "string" ? { channelId: state.channelId } : {}),
    ...(digits(state.balance) !== undefined ? { balance: digits(state.balance) } : {}),
    totalClaimed,
    withdrawRequestedAt,
  };
}

function readChannelState(result: SettleResponse): {
  balance?: string;
  totalClaimed: string;
  withdrawRequestedAt: number;
} {
  const raw = result.extra?.channelState;
  if (typeof raw !== "object" || raw === null) {
    return { totalClaimed: "0", withdrawRequestedAt: 0 };
  }
  const state = raw as Record<string, unknown>;
  return {
    ...(typeof state.balance === "string" ? { balance: state.balance } : {}),
    totalClaimed: typeof state.totalClaimed === "string" ? state.totalClaimed : "0",
    withdrawRequestedAt:
      typeof state.withdrawRequestedAt === "number" ? state.withdrawRequestedAt : 0,
  };
}

/**
 * The channel deposit after a confirmed setup transaction.
 *
 * `deposit` is written once when the channel is provisioned, so without this a
 * top-up's escrow would never reach stored state: the balance reported to the
 * client would stay pinned at the original `open` amount, and the client —
 * which adopts that balance as its own ceiling — would top up again on the next
 * request that exceeded it, and on every request after that. The escrow would
 * grow on chain while the client believed it never had.
 *
 * The facilitator reports the freshly-fetched on-chain deposit, so it is the
 * authority. It is taken as a maximum rather than assigned, so a stale or
 * malformed read can never lower a ceiling the chain has already confirmed.
 *
 * @param current - Deposit currently in stored state
 * @param confirmed - `channelState.balance` from the settlement response
 * @returns The deposit to store
 */
function confirmedDeposit(current: bigint, confirmed: string | undefined): bigint {
  if (confirmed === undefined) return current;
  try {
    const balance = parseU64(confirmed, "channelState.balance");
    return balance > current ? balance : current;
  } catch {
    return current;
  }
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Object.values(BatchError).find(value => message.includes(value)) ?? "transaction_failed";
}
