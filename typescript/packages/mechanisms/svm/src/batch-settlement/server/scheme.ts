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
import type { MessagePartialSigner } from "@solana/kit";

import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "../../constants";
import { findDefaultAsset } from "../../defaultAssets";
import {
  encodeVoucherMessageBytes,
  signVoucher,
  verifyVoucherSignature,
} from "../../payment-channels/voucher";
import { findPaymentChannelPda, parseU64 } from "../../payment-channels/open";
import {
  convertToTokenAmount,
  getStablecoinAddress,
  getStablecoinTokenProgram,
  numberToDecimalString,
} from "../../utils";
import { BatchError } from "../errors";
import { verifyBatchAuthorization } from "../authorization";
import { signBatchSettlementReceipt } from "../receipt";
import type {
  BatchChannelConfig,
  BatchPayload,
  BatchSettlementReceipt,
  BatchVoucher,
} from "../types";
import { BATCH_SETTLEMENT_SCHEME, isBatchPayload } from "../types";
import {
  type BatchOperation,
  type BatchOperationStore,
  MemoryBatchOperationStore,
} from "./operationStore";
import { type ChannelState, type ChannelStore, MemoryChannelStore } from "./storage";

type ParsedMoney = { amount: number; stablecoin?: SvmStablecoinSymbol };
type SvmStablecoinSymbol = "USDC" | "USDT" | "USDG" | "PYUSD" | "CASH";
type RequestContext = {
  channelId: string;
  /** Client-signed cumulative amount, when the payer supplies the voucher. */
  cumulative?: bigint;
  /** Maximum charge advertised before the handler runs. */
  ceiling?: bigint;
  idempotencyKey?: string;
  pendingId?: string;
  replay?: Extract<BatchOperation, { status: "completed" }>;
  topUp?: boolean;
  /**
   * Set when local state is absent or stale, so the cumulative rule must be
   * applied after the facilitator refreshes the onchain snapshot.
   */
  requiresCumulativeCheck?: boolean;
};

const PRICE_STABLECOINS = new Set(["USDC", "USDT", "USDG", "PYUSD", "CASH"]);
const MIN_WITHDRAW_DELAY = 900;
const MAX_WITHDRAW_DELAY = 2_592_000;
const CHANNEL_BUSY = "duplicate_settlement";
const DEFAULT_SERVER_MIN_DEPOSIT_MULTIPLIER = 10n;

export interface BatchSvmServerConfig {
  withdrawDelay?: number | undefined;
  receiverAuthorizer?: string | undefined;
  store?: ChannelStore | undefined;
  /** Maximum age of onchain state used to verify vouchers locally. */
  onchainStateTtlMs?: number | undefined;
  /** Reject deposits below the announced `extra.minDeposit` hint. Defaults to false. */
  enforceMinDeposit?: boolean | undefined;
  operationStore?: BatchOperationStore | undefined;
  /** Operator key used to sign cumulative vouchers after successful requests. */
  operator?: MessagePartialSigner | undefined;
}

/**
 * SVM resource-server implementation for `batch-settlement`.
 *
 * The server, not the facilitator, owns the offchain voucher watermark. Hooks
 * reserve channel capacity during verification, leave the reservation
 * unchanged while the handler runs, and commit the measured charge only during
 * the after-handler settle phase.
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
  private readonly operationStore: BatchOperationStore;
  private readonly requestContexts = new WeakMap<DeepReadonly<PaymentPayload>, RequestContext>();
  private readonly settlementExtras = new WeakMap<
    DeepReadonly<PaymentPayload>,
    Record<string, unknown>
  >();
  private moneyParsers: MoneyParser[] = [];
  private reservationSequence = 0;

  constructor(private readonly config: BatchSvmServerConfig = {}) {
    this.store = config.store ?? new MemoryChannelStore();
    this.operationStore = config.operationStore ?? new MemoryBatchOperationStore();
    this.schemeHooks = {
      onBeforeVerify: ctx => this.beforeVerify(ctx),
      onAfterVerify: ctx => this.afterVerify(ctx),
      onBeforeSettle: ctx => this.beforeSettle(ctx),
      onAfterSettle: ctx => this.afterSettle(ctx),
      onSettleFailure: ctx => this.onSettleFailure(ctx),
      onVerifiedPaymentCanceled: ctx => this.onCanceled(ctx),
    };
  }

  enrichSettlementResponse = async (
    ctx: SettleResultContext,
  ): Promise<Record<string, unknown> | void> => {
    const extra = this.settlementExtras.get(ctx.paymentPayload);
    this.settlementExtras.delete(ctx.paymentPayload);
    return extra ? withoutExistingFields(extra, ctx.result.extra) : undefined;
  };

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
        minDeposit: this.resolveMinDepositHint(paymentRequirements),
        ...(this.config.receiverAuthorizer
          ? { receiverAuthorizer: this.config.receiverAuthorizer }
          : {}),
        ...(this.config.operator
          ? { operator: this.config.operator.address, voucherSigner: "server" }
          : {}),
      },
    });
  }

  /**
   * Resolve the deposit target advertised for one request.
   *
   * @param paymentRequirements - Route requirements, optionally with a target override
   * @returns The normalized deposit target in atomic units
   */
  resolveMinDepositHint(paymentRequirements: PaymentRequirements): string {
    const amount = BigInt(paymentRequirements.amount);
    const override = paymentRequirements.extra?.minDeposit;
    let configured: bigint | undefined;
    if (typeof override === "string") {
      if (/^\d+$/.test(override)) {
        configured = parsePositiveAmount(override, "minDeposit");
      } else {
        const asset = findDefaultAsset(paymentRequirements.asset, paymentRequirements.network);
        if (!asset) {
          throw new Error(
            `extra.minDeposit money values are only supported for default assets; ` +
              `use an integer atomic string for ${paymentRequirements.asset} on ${paymentRequirements.network}.`,
          );
        }
        const parsed = this.parseMoney(override);
        if (parsed.stablecoin !== undefined && parsed.stablecoin !== asset.symbol) {
          throw new Error(`extra.minDeposit currency must match ${asset.symbol}`);
        }
        configured = parsePositiveAmount(
          convertToTokenAmount(numberToDecimalString(parsed.amount), asset.decimals),
          "minDeposit",
        );
      }
    }
    const minimum = configured ?? amount * DEFAULT_SERVER_MIN_DEPOSIT_MULTIPLIER;
    return (minimum > amount ? minimum : amount).toString();
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
      if (state) {
        this.assertStoredConfig(state, raw.channelConfig);
        const authorization =
          raw.type === "authorization"
            ? raw.authorization
            : raw.type === "deposit"
              ? raw.authorization
              : undefined;
        if (
          authorization &&
          state.authorizationSignature !== undefined &&
          state.authorizationSignature !== authorization.signature
        ) {
          throw new Error(BatchError.VOUCHER_SIGNATURE);
        }
      }

      if (raw.type === "deposit" || raw.type === "voucher" || raw.type === "authorization") {
        // A channel this server holds no record for is not a dead end: the
        // facilitator verifies the voucher against confirmed onchain state,
        // and `afterVerify` rebuilds the record from the snapshot it returns.
        // Refusing here instead would strand the payer's escrow behind a
        // forced close every time this server lost its store.
        if (
          (raw.type === "voucher" || raw.type === "authorization") &&
          (!state || !isOnchainStateFresh(state, this.config.onchainStateTtlMs))
        ) {
          this.requestContexts.set(ctx.paymentPayload, {
            channelId,
            requiresCumulativeCheck: true,
            ...(raw.type === "authorization"
              ? {
                  ceiling: BigInt(ctx.requirements.amount),
                  idempotencyKey: raw.idempotencyKey,
                }
              : {}),
          });
          return;
        }
        const expected = (state?.chargedCumulativeAmount ?? 0n) + BigInt(ctx.requirements.amount);
        const voucher =
          raw.type === "voucher" ? raw.voucher : raw.type === "deposit" ? raw.voucher : undefined;
        if (voucher) {
          const submitted = BigInt(voucher.maxClaimableAmount);
          const replay =
            state !== undefined &&
            submitted === state.chargedCumulativeAmount &&
            voucher.signature === state.highestVoucherSignature;
          if (replay) throw new Error(CHANNEL_BUSY);
          if (!replay && submitted !== expected) {
            throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
          }
          this.requestContexts.set(ctx.paymentPayload, {
            channelId,
            cumulative: submitted,
            ceiling: BigInt(ctx.requirements.amount),
            ...(raw.type === "deposit" && state ? { topUp: true } : {}),
          });
        } else {
          if (raw.type === "voucher") throw new Error(BatchError.PAYLOAD_TYPE);
          const idempotencyKey = raw.idempotencyKey!;
          this.requestContexts.set(ctx.paymentPayload, {
            channelId,
            ceiling: BigInt(ctx.requirements.amount),
            idempotencyKey,
            ...(raw.type === "deposit" && state ? { topUp: true } : {}),
          });
        }
      } else {
        if (!state) throw new Error(BatchError.CHANNEL_STATE);
        this.requestContexts.set(ctx.paymentPayload, { channelId });
      }
      // Deposits and refunds carry transactions whose complete instruction and
      // onchain-state checks belong to the facilitator. Only a steady-state
      // proof backed by a fresh local snapshot can use the local fast path.
      if (raw.type !== "voucher" && raw.type !== "authorization") return;
      return {
        skip: true,
        result: { isValid: true, payer: raw.channelConfig.payer, extra: { channelId } },
      };
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
    // The facilitator has now confirmed this payload against onchain state and
    // returned the channel snapshot. Persisting it is what lets a server with
    // no record of a live channel serve it, and what keeps `deposit`, `settled`
    // and the close state from drifting behind the chain.
    const snapshot = readVerifiedChannelState(ctx.result);
    if (request.requiresCumulativeCheck && !snapshot) {
      return this.abort(BatchError.CHANNEL_STATE, "facilitator did not return channel state");
    }
    if (snapshot && !this.applySnapshot(request.channelId, snapshot)) {
      return this.abort(BatchError.CHANNEL_STATE, "verified channel snapshot is unusable");
    }
    if (snapshot) {
      await this.persistSnapshot(request.channelId, raw, ctx.requirements, snapshot);
    }

    // A client-signed voucher must be checked against the refreshed baseline.
    if (request.requiresCumulativeCheck && raw.type === "voucher") {
      const state = await this.store.get(request.channelId);
      if (!state) return this.abort(BatchError.CHANNEL_STATE, "channel state unavailable");
      const submitted = BigInt(raw.voucher.maxClaimableAmount);
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
    const expiresAt = Date.now() + Math.max(5_000, ctx.requirements.maxTimeoutSeconds * 1_000);
    let operationReserved = false;
    try {
      if (request.idempotencyKey && request.ceiling !== undefined) {
        const reserved = await this.operationStore.reserve(
          request.channelId,
          request.idempotencyKey,
          request.ceiling,
          expiresAt,
        );
        if (!reserved.created) {
          if (reserved.operation.status === "completed") {
            this.requestContexts.set(ctx.paymentPayload, {
              ...request,
              replay: reserved.operation,
            });
            return {
              skipHandler: true,
              response: { body: { receipt: reserved.operation.receipt, replayed: true } },
            };
          }
          throw new Error(CHANNEL_BUSY);
        }
        operationReserved = true;
      }
      await this.store.update(request.channelId, current => {
        const state = current ?? this.provisionalState(raw, ctx.requirements, request.channelId);
        if (state.status !== "open") throw new Error(BatchError.CLOSE_STATE);
        this.assertStoredConfig(state, raw.channelConfig);
        const reservations = liveReservations(state.reservations);
        const active = Object.values(reservations);
        const kind = raw.type === "refund" ? "close" : request.idempotencyKey ? "server" : "client";
        if (kind !== "server" && active.length > 0) throw new Error(CHANNEL_BUSY);
        if (kind === "server" && active.some(reservation => reservation.kind !== "server")) {
          throw new Error(CHANNEL_BUSY);
        }
        const maxClaimableAmount =
          raw.type === "refund"
            ? state.signedMaxClaimable
            : (request.cumulative ??
              state.chargedCumulativeAmount + BigInt(ctx.requirements.amount));
        const reservedCeilings = active.reduce((sum, reservation) => sum + reservation.ceiling, 0n);
        const ceiling = raw.type === "refund" ? 0n : BigInt(ctx.requirements.amount);
        const deposit =
          raw.type === "deposit" && request.topUp
            ? state.deposit + BigInt(raw.deposit.amount)
            : state.deposit;
        if (
          maxClaimableAmount > deposit ||
          state.chargedCumulativeAmount + reservedCeilings + ceiling > deposit
        ) {
          throw new Error(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT);
        }
        return {
          ...state,
          reservations: {
            ...reservations,
            [pendingId]: {
              ceiling,
              expiresAt,
              ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
              kind,
            },
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
      if (operationReserved && request.idempotencyKey) {
        await this.operationStore.release(request.channelId, request.idempotencyKey);
      }
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
      this.requestContexts.delete(ctx.paymentPayload);
      return { skip: true, result: request.replay.response };
    }
    if (!request?.pendingId) return this.abort(CHANNEL_BUSY, "missing reservation");
    const state = await this.store.get(request.channelId);
    if (!state?.reservations?.[request.pendingId]) {
      return this.abort(CHANNEL_BUSY, "reservation changed");
    }

    // Deposits go to the facilitator, which broadcasts the open/top_up
    // transaction in this post-handler settle; the voucher commits in
    // afterSettle once the deposit succeeds.
    if (raw.type === "deposit") return;

    try {
      const actual = BigInt(ctx.requirements.amount);
      const ceiling = request.ceiling ?? actual;
      if (actual > ceiling) {
        throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
      }
      if (raw.type !== "authorization" && actual !== ceiling) {
        throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
      }
      let response: SettleResponse | undefined;
      const committed = await this.store.update(request.channelId, async current => {
        const reservation = current?.reservations?.[request.pendingId!];
        if (!current || !reservation) {
          throw new Error(CHANNEL_BUSY);
        }
        if (actual > reservation.ceiling) throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
        const prior = current.chargedCumulativeAmount;
        const cumulative = prior + actual;
        const voucher =
          raw.type === "authorization"
            ? await this.signOperatorVoucher(request.channelId, cumulative)
            : raw.voucher;
        const next: ChannelState = {
          ...current,
          chargedCumulativeAmount: BigInt(voucher.maxClaimableAmount),
          highestVoucherExpiresAt: voucher.expiresAt,
          highestVoucherSignature: voucher.signature,
          reservations: withoutReservation(current.reservations, request.pendingId!),
          signedMaxClaimable: BigInt(voucher.maxClaimableAmount),
        };
        if (request.idempotencyKey) {
          const receipt = await this.signReceipt(
            request.channelId,
            request.idempotencyKey,
            reservation.ceiling,
            actual,
            prior,
            cumulative,
            voucher,
          );
          response = acceptedResponse(next, ctx.requirements, receipt);
          await this.operationStore.complete({
            status: "completed",
            channelId: request.channelId,
            idempotencyKey: request.idempotencyKey,
            ceiling: reservation.ceiling,
            actual,
            cumulative,
            receipt,
            response,
          });
        } else {
          response = acceptedResponse(next, ctx.requirements);
        }
        return next;
      });
      this.requestContexts.delete(ctx.paymentPayload);
      return { skip: true, result: response ?? acceptedResponse(committed, ctx.requirements) };
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
      const reserved = await this.store.get(request.channelId);
      if (!reserved?.reservations?.[request.pendingId]) {
        throw new Error(CHANNEL_BUSY);
      }
      const actual = BigInt(ctx.requirements.amount);
      const ceiling = request.ceiling ?? actual;
      if (actual > ceiling) throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
      if (raw.voucher && actual !== ceiling) {
        throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
      }
      let receipt: BatchSettlementReceipt | undefined;
      const committed = await this.store.update(request.channelId, async current => {
        const reservation = current?.reservations?.[request.pendingId!];
        if (!current || !reservation) {
          throw new Error(CHANNEL_BUSY);
        }
        if (actual > reservation.ceiling) throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
        const prior = current.chargedCumulativeAmount;
        const cumulative = prior + actual;
        const voucher =
          raw.voucher ?? (await this.signOperatorVoucher(request.channelId, cumulative));
        const confirmed = readChannelState(ctx.result);
        const next: ChannelState = {
          ...current,
          // A top-up raises the escrow ceiling; without this the stored deposit
          // would stay at the original open amount forever.
          deposit: confirmedDeposit(current.deposit, confirmed.balance),
          openSignature: ctx.result.transaction,
          settled: BigInt(confirmed.totalClaimed),
          chargedCumulativeAmount: BigInt(voucher.maxClaimableAmount),
          highestVoucherExpiresAt: voucher.expiresAt,
          highestVoucherSignature: voucher.signature,
          signedMaxClaimable: BigInt(voucher.maxClaimableAmount),
          onchainSyncedAt: Date.now(),
          reservations: withoutReservation(current.reservations, request.pendingId!),
        };
        if (request.idempotencyKey) {
          receipt = await this.signReceipt(
            request.channelId,
            request.idempotencyKey,
            reservation.ceiling,
            actual,
            prior,
            cumulative,
            voucher,
          );
          const extra = settlementExtra(next, ctx.requirements.amount, receipt);
          const response = {
            ...ctx.result,
            extra: {
              ...ctx.result.extra,
              ...withoutExistingFields(extra, ctx.result.extra),
            },
          };
          await this.operationStore.complete({
            status: "completed",
            channelId: request.channelId,
            idempotencyKey: request.idempotencyKey,
            ceiling: reservation.ceiling,
            actual,
            cumulative,
            receipt,
            response,
          });
        }
        return next;
      });
      this.settlementExtras.set(
        ctx.paymentPayload,
        settlementExtra(committed, ctx.requirements.amount, receipt),
      );
      this.requestContexts.delete(ctx.paymentPayload);
      return;
    }

    if (raw.type === "refund") {
      await this.store.update(request.channelId, current => {
        if (!current?.reservations?.[request.pendingId!]) {
          throw new Error(CHANNEL_BUSY);
        }
        const snapshot = readChannelState(ctx.result);
        return {
          ...current,
          closeRequestedAt: snapshot.withdrawRequestedAt,
          closeSignature: ctx.result.transaction,
          onchainSyncedAt: Date.now(),
          reservations: withoutReservation(current.reservations, request.pendingId!),
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
      if (!current.reservations?.[request.pendingId!]) return current;
      return {
        ...current,
        reservations: withoutReservation(current.reservations, request.pendingId!),
      };
    });
    if (request.idempotencyKey) {
      await this.operationStore.release(request.channelId, request.idempotencyKey);
    }
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
    const voucherSigner = extra.voucherSigner ?? "client";
    if (voucherSigner !== "client" && voucherSigner !== "server") {
      throw new Error(BatchError.CHANNEL_STATE);
    }
    if ((raw.channelConfig.voucherSigner ?? "client") !== voucherSigner) {
      throw new Error(BatchError.CHANNEL_STATE);
    }
    const operator = extra.operator;
    if (
      (voucherSigner === "server" &&
        (typeof operator !== "string" ||
          raw.channelConfig.payerAuthorizer !== operator ||
          this.config.operator?.address !== operator)) ||
      (voucherSigner === "client" && operator !== undefined)
    ) {
      throw new Error(BatchError.CHANNEL_STATE);
    }
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
    await this.validateRequestProof(raw, channelId, voucherSigner);
    if (
      raw.type === "deposit" &&
      this.config.enforceMinDeposit === true &&
      parseU64(raw.deposit.amount, "deposit.amount") <
        parseU64(this.resolveMinDepositHint(requirements), "minDeposit")
    ) {
      throw new Error(BatchError.DEPOSIT_BELOW_MIN_DEPOSIT);
    }
    return channelId;
  }

  private async validateRequestProof(
    raw: BatchPayload,
    channelId: string,
    voucherSigner: "client" | "server",
  ): Promise<void> {
    if (raw.type === "deposit" || raw.type === "voucher" || raw.type === "authorization") {
      const voucher =
        raw.type === "voucher" ? raw.voucher : raw.type === "deposit" ? raw.voucher : undefined;
      const authorization =
        raw.type === "authorization"
          ? raw.authorization
          : raw.type === "deposit"
            ? raw.authorization
            : undefined;
      if (voucherSigner === "client" && !voucher) throw new Error(BatchError.VOUCHER_SIGNATURE);
      if (voucherSigner === "server" && !authorization) {
        throw new Error(BatchError.VOUCHER_SIGNATURE);
      }
      if (voucher) {
        if (voucher.channelId !== channelId) throw new Error(BatchError.CHANNEL_ID_MISMATCH);
        this.assertExpiry(voucher);
        const valid = await verifyVoucherSignature({
          message: encodeVoucherMessageBytes({
            channelId,
            cumulativeAmount: BigInt(voucher.maxClaimableAmount),
            expiresAt: BigInt(voucher.expiresAt),
          }),
          signatureBase58: voucher.signature,
          signerBase58: raw.channelConfig.payerAuthorizer,
        });
        if (!valid) throw new Error(BatchError.VOUCHER_SIGNATURE);
      }
      if (authorization) {
        const idempotencyKey =
          raw.type === "authorization"
            ? raw.idempotencyKey
            : raw.type === "deposit"
              ? raw.idempotencyKey
              : undefined;
        if (
          authorization.channelId !== channelId ||
          authorization.payer !== raw.channelConfig.payer ||
          typeof idempotencyKey !== "string" ||
          idempotencyKey.length === 0 ||
          !(await verifyBatchAuthorization(authorization, raw.channelConfig.payerAuthorizer))
        ) {
          throw new Error(BatchError.VOUCHER_SIGNATURE);
        }
      }
    }
  }

  private assertExpiry(voucher: BatchVoucher): void {
    if (voucher.expiresAt !== 0) throw new Error(BatchError.VOUCHER_EXPIRY);
  }

  private async signOperatorVoucher(
    channelId: string,
    cumulativeAmount: bigint,
  ): Promise<BatchVoucher> {
    if (!this.config.operator) throw new Error(BatchError.VOUCHER_SIGNATURE);
    return {
      channelId,
      expiresAt: 0,
      maxClaimableAmount: cumulativeAmount.toString(),
      signature: await signVoucher(this.config.operator, {
        channelId,
        cumulativeAmount,
        expiresAt: 0n,
      }),
    };
  }

  private async signReceipt(
    channelId: string,
    idempotencyKey: string,
    authorizedAmount: bigint,
    chargedAmount: bigint,
    priorCumulativeAmount: bigint,
    cumulativeAmount: bigint,
    voucher: BatchVoucher,
  ): Promise<BatchSettlementReceipt> {
    if (!this.config.operator) throw new Error(BatchError.VOUCHER_SIGNATURE);
    return signBatchSettlementReceipt(this.config.operator, {
      channelId,
      idempotencyKey,
      authorizedAmount,
      chargedAmount,
      priorCumulativeAmount,
      cumulativeAmount,
      voucher,
    });
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
        onchainSyncedAt: Date.now(),
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
      ...(raw.type === "authorization" || (raw.type === "deposit" && raw.authorization)
        ? { authorizationSignature: raw.authorization!.signature }
        : {}),
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
      ...(raw.authorization ? { authorizationSignature: raw.authorization.signature } : {}),
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

function acceptedResponse(
  state: ChannelState,
  requirements: PaymentRequirements,
  receipt?: BatchSettlementReceipt,
): SettleResponse {
  return {
    success: true,
    payer: state.payer,
    transaction: "",
    network: requirements.network,
    amount: "",
    extra: settlementExtra(state, requirements.amount, receipt),
  };
}

function settlementExtra(
  state: ChannelState,
  chargedAmount: string,
  receipt?: BatchSettlementReceipt,
): Record<string, unknown> {
  return {
    channelState: snapshot(state),
    chargedAmount,
    commitmentId: `${state.channelId}:${state.signedMaxClaimable}`,
    voucher: receiptVoucher(state),
    ...(receipt ? { receipt } : {}),
  };
}

function receiptVoucher(state: ChannelState): BatchVoucher | undefined {
  if (state.highestVoucherSignature === undefined) return undefined;
  return {
    channelId: state.channelId,
    expiresAt: state.highestVoucherExpiresAt ?? 0,
    maxClaimableAmount: state.signedMaxClaimable.toString(),
    signature: state.highestVoucherSignature,
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

function liveReservations(
  reservations: ChannelState["reservations"],
): NonNullable<ChannelState["reservations"]> {
  return Object.fromEntries(
    Object.entries(reservations ?? {}).filter(
      ([, reservation]) => reservation.expiresAt > Date.now(),
    ),
  );
}

function withoutReservation(
  reservations: ChannelState["reservations"],
  reservationId: string,
): ChannelState["reservations"] {
  return Object.fromEntries(
    Object.entries(reservations ?? {}).filter(([id]) => id !== reservationId),
  );
}

function withoutExistingFields(
  extra: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(extra).filter(([key]) => !(key in (existing ?? {}))));
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

function isOnchainStateFresh(state: ChannelState, configuredTtlMs: number | undefined): boolean {
  if (state.onchainSyncedAt === undefined) return false;
  const ttlMs = configuredTtlMs ?? defaultOnchainStateTtlMs(state.withdrawDelay);
  return Date.now() - state.onchainSyncedAt <= ttlMs;
}

function defaultOnchainStateTtlMs(withdrawDelaySeconds: number): number {
  const withdrawDelayMs = Math.max(0, withdrawDelaySeconds) * 1_000;
  return Math.min(5 * 60_000, Math.max(30_000, Math.floor(withdrawDelayMs / 3)));
}

function parsePositiveAmount(value: string, field: string): bigint {
  const amount = parseU64(value, field);
  if (amount === 0n) throw new Error(`${field} must resolve to a positive integer`);
  return amount;
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(CHANNEL_BUSY)) return CHANNEL_BUSY;
  return Object.values(BatchError).find(value => message.includes(value)) ?? "transaction_failed";
}
