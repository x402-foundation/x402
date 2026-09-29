import type {
  FacilitatorClient,
  SettleContext,
  SettleFailureContext,
  SettleResultContext,
  SkipHandlerDirective,
  VerifiedPaymentCanceledContext,
  VerifyContext,
  VerifyFailureContext,
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
  SupportedKind,
  VerifyResponse,
} from "@x402/core/types";
import type { DeepReadonly } from "@x402/core/types";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import type { MessagePartialSigner } from "@solana/kit";

import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "../../constants";
import { findDefaultAsset, getDefaultAsset } from "../../defaultAssets";
import {
  encodeVoucherMessageBytes,
  signVoucher,
  verifyVoucherSignature,
} from "../../payment-channels/voucher";
import {
  findPaymentChannelPda,
  parseU64,
  verifyOpenTransaction,
} from "../../payment-channels/open";
import { getStablecoinTokenProgram, validateSvmAddress } from "../../utils";
import {
  CLIENT_VOUCHER_EXPIRES_AT,
  FULL_SPLIT_BPS,
  MAX_WITHDRAW_DELAY,
  MIN_WITHDRAW_DELAY,
} from "../constants";
import { BatchError } from "../errors";
import { verifyBatchAuthorization } from "../authorization";
import { signCloseAuthorization } from "../closeAuthorization";
import { encodeReceiverBindingMemo } from "../receiverBinding";
import type {
  BatchAuthorization,
  BatchChannelConfig,
  BatchPayload,
  BatchProof,
  BatchVoucher,
  CloseAuthorization,
} from "../types";
import { BATCH_SETTLEMENT_SCHEME, isBatchPayload, proofOf } from "../types";
import { type BatchOperationStore, MemoryBatchOperationStore } from "./operationStore";
import { BatchChannelManager, type BatchChannelManagerConfig } from "./channelManager";
import { MemoryChannelStore } from "./storage";
import {
  CHANNEL_BUSY,
  DEFAULT_SERVER_MIN_DEPOSIT_MULTIPLIER,
  DEFAULT_SERVER_SIGNED_MIN_DEPOSIT_MULTIPLIER,
} from "./constants";
import type { ChannelState, ChannelStore, RequestContext, VerifiedChannelState } from "./types";

export interface BatchSvmServerConfig {
  withdrawDelay?: number | undefined;
  /**
   * Receiver-authorizer signer. Advertised as `extra.receiverAuthorizer`,
   * bound to each channel at open, and used to sign the `CloseAuthorization`s
   * that cooperative refunds and seals of closing channels require.
   * Omit it to delegate those closes to a facilitator that advertises its own
   * `receiverAuthorizer`.
   */
  receiverAuthorizer?: MessagePartialSigner | undefined;
  /** Called when the facilitator reports a paid request's channel as closing, so the host can run a redemption pass. */
  onChannelClosing?: ((channelId: string) => void) | undefined;
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

  /**
   * Construct the server-side batch-settlement scheme.
   *
   * @param config - Channel store, operator, receiver authorizer, and hook options
   */
  constructor(private readonly config: BatchSvmServerConfig) {
    this.store = config.store ?? new MemoryChannelStore();
    this.operationStore = config.operationStore ?? new MemoryBatchOperationStore();
    this.schemeHooks = {
      onBeforeVerify: ctx => this.beforeVerify(ctx),
      onAfterVerify: ctx => this.afterVerify(ctx),
      onBeforeSettle: ctx => this.beforeSettle(ctx),
      onAfterSettle: ctx => this.afterSettle(ctx),
      onVerifyFailure: ctx => this.onVerifyFailure(ctx),
      onSettleFailure: ctx => this.onSettleFailure(ctx),
      onVerifiedPaymentCanceled: ctx => this.onCanceled(ctx),
    };
  }

  /**
   * Attach the receiver authorizer's `CloseAuthorization` to a refund, so the
   * facilitator can close the channel cooperatively with the accepted voucher.
   *
   * @param ctx - Settle context for the refund
   * @returns The `closeAuthorization` field, or nothing for other payloads
   */
  enrichSettlementPayload = async (ctx: SettleContext): Promise<Record<string, unknown> | void> => {
    const raw = ctx.paymentPayload.payload;
    if (!isBatchPayload(raw) || raw.type !== "refund") return;
    const request = this.requestContexts.get(ctx.paymentPayload);
    if (!request?.pendingId) throw new Error(CHANNEL_BUSY);
    const feePayer = ctx.requirements.extra?.feePayer;
    if (typeof feePayer !== "string") throw new Error(BatchError.FEE_PAYER_MISMATCH);
    const serverMode = (raw.channelConfig.voucherSigner ?? "client") === "server";
    let closeAuthorization: CloseAuthorization | undefined;
    let injectedVoucher: BatchVoucher | undefined;
    await this.store.update(request.channelId, async current => {
      if (!current?.reservations?.[request.pendingId!]) throw new Error(CHANNEL_BUSY);
      const cumulative = current.chargedCumulativeAmount;
      let voucher: BatchVoucher;
      if (raw.voucher) {
        if (BigInt(raw.voucher.maxClaimableAmount) !== cumulative) {
          throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
        }
        voucher = raw.voucher;
      } else if (!serverMode) {
        throw new Error(BatchError.VOUCHER_SIGNATURE);
      } else if (current.highestVoucherSignature && cumulative > 0n) {
        voucher = {
          channelId: request.channelId,
          expiresAt: current.highestVoucherExpiresAt ?? 0,
          maxClaimableAmount: cumulative.toString(),
          signature: current.highestVoucherSignature,
        };
      } else if (cumulative === 0n) {
        voucher = await this.signOperatorVoucher(request.channelId, 0n);
      } else {
        throw new Error(BatchError.VOUCHER_SIGNATURE);
      }
      if (serverMode) injectedVoucher = voucher;
      if (this.config.receiverAuthorizer) {
        closeAuthorization = await signCloseAuthorization(this.config.receiverAuthorizer, {
          channelId: request.channelId,
          feePayer,
          maxClaimableAmount: cumulative,
          network: ctx.requirements.network,
          validBefore: Math.floor(Date.now() / 1000) + ctx.requirements.maxTimeoutSeconds,
          voucherExpiresAt: BigInt(voucher.expiresAt),
        });
      }
      return current;
    });
    return {
      ...(injectedVoucher ? { voucher: injectedVoucher } : {}),
      ...(closeAuthorization ? { closeAuthorization } : {}),
    };
  };

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

  /**
   * Expose the channel store for tests and redemption workers.
   *
   * @returns The configured or default in-memory channel store
   */
  getChannelStore(): ChannelStore {
    return this.store;
  }

  /**
   * Register a custom money parser in the parser chain (tried in order).
   *
   * @param parser - Custom function to convert an amount to an AssetAmount (or null to skip)
   * @returns This instance for chaining
   */
  registerMoneyParser(parser: MoneyParser): BatchSvmScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Parse a price into an asset amount. AssetAmount inputs pass through; Money
   * inputs are parsed to a decimal and run through the parser chain, falling
   * back to the default stablecoin conversion.
   *
   * @param price - The price to parse
   * @param network - The network to use
   * @returns The parsed asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      }
      return { amount: price.amount, asset: price.asset, extra: price.extra || {} };
    }
    const { amount, symbol } = parseMoney(price);
    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) return result;
    }
    return this.defaultMoneyConversion(amount, network, symbol);
  }

  /**
   * Fail server startup when the facilitator does not advertise a usable `feePayer`,
   * or when this server delegates and the facilitator does not advertise a
   * `receiverAuthorizer`.
   *
   * @param network - The network identifier being validated
   * @param supportedKind - The facilitator's advertised kind for this scheme/network
   * @param _ - Extensions advertised by the facilitator (unused)
   * @returns A problem message when misconfigured, or void when valid
   */
  validateFacilitatorSupport(
    network: Network,
    supportedKind: SupportedKind,
    _: string[],
  ): string | void {
    const feePayer = supportedKind.extra?.feePayer;
    if (typeof feePayer !== "string" || !validateSvmAddress(feePayer)) {
      return (
        `facilitator does not advertise a valid feePayer for batch-settlement on ${network}; ` +
        `a base58 Solana address is required`
      );
    }
    if (this.config.receiverAuthorizer) return;

    const advertised = supportedKind.extra?.receiverAuthorizer;
    if (typeof advertised !== "string" || !validateSvmAddress(advertised)) {
      return (
        `no receiverAuthorizer is configured and the facilitator does not advertise a ` +
        `receiverAuthorizer on ${network}. Configure a receiverAuthorizer or use a ` +
        `facilitator that advertises one.`
      );
    }
  }

  /**
   * Fold facilitator extras into the accept: `feePayer`, `tokenProgram`,
   * `withdrawDelay`, `minDeposit`, `receiverAuthorizer`, and optional
   * server-signed `operator` / `voucherSigner`.
   *
   * @param paymentRequirements - Route requirements before enrichment
   * @param supportedKind - Facilitator `/supported` kind for this network
   * @param supportedKind.x402Version - The x402 version
   * @param supportedKind.scheme - The payment scheme
   * @param supportedKind.network - The network identifier
   * @param supportedKind.extra - Facilitator extra (`feePayer`, optional `receiverAuthorizer`)
   * @param extensionKeys - Extension keys on the accept (unused)
   * @returns Enriched payment requirements for the 402 challenge
   */
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
    const serverSigned = this.isServerSigned(paymentRequirements);
    // A route may pin itself to client mode with `extra.voucherSigner:
    // "client"` even when an operator is configured, so one route can offer
    // both a server-signed accept (metered) and a client-signed accept (the
    // ceiling as a fixed price) and clients that do not trust the operator
    // still have a way to pay.
    const { operator: _routeOperator, ...routeExtra } = paymentRequirements.extra ?? {};
    void _routeOperator;
    const advertised = supportedKind.extra?.receiverAuthorizer;
    const receiverAuthorizer =
      this.config.receiverAuthorizer?.address ??
      (typeof advertised === "string" ? advertised : undefined);
    if (!receiverAuthorizer || !validateSvmAddress(receiverAuthorizer)) {
      throw new Error("Payment requirements must include a valid extra.receiverAuthorizer");
    }
    return Promise.resolve({
      ...paymentRequirements,
      extra: {
        ...routeExtra,
        ...supportedKind.extra,
        tokenProgram: getStablecoinTokenProgram(
          paymentRequirements.asset,
          paymentRequirements.network,
        ),
        withdrawDelay,
        minDeposit: this.resolveMinDepositHint(paymentRequirements),
        receiverAuthorizer,
        ...(serverSigned
          ? { operator: this.config.operator!.address, voucherSigner: "server" }
          : {}),
      },
    });
  }

  /**
   * Whether a route's accept is served in server-signed mode.
   *
   * Server mode needs a configured operator and is the default for every
   * batch route once one is configured; a route opts back out with
   * `extra.voucherSigner: "client"`.
   *
   * @param paymentRequirements - Route accept, before or after enrichment
   * @returns True when the operator signs vouchers for this accept
   */
  isServerSigned(paymentRequirements: PaymentRequirements): boolean {
    const routeMode = paymentRequirements.extra?.voucherSigner;
    if (routeMode !== undefined && routeMode !== "client" && routeMode !== "server") {
      throw new Error('extra.voucherSigner must be "client" or "server"');
    }
    if (routeMode === "server" && !this.config.operator) {
      throw new Error(
        'extra.voucherSigner: "server" requires an operator signer in BatchSvmServerConfig',
      );
    }
    return this.config.operator !== undefined && routeMode !== "client";
  }

  /**
   * Build the redemption worker over this scheme's channel store: it claims
   * accumulated vouchers and distributes what they settle, through the same
   * facilitator the server verifies with.
   *
   * `requirements` are the terms channels were opened against — network,
   * asset, `payTo` and `extra.feePayer` — normally the output of
   * {@link enhancePaymentRequirements} for the route's requirements and the
   * facilitator's `/supported` kind.
   *
   * @param facilitator - Facilitator client that submits redemption payloads
   * @param requirements - Enhanced requirements the channels were opened against
   * @param options - Worker tuning: batch size, watermark reader, error hook
   * @returns A worker the caller starts, or drives with `redeem()`
   */
  createChannelManager(
    facilitator: Pick<FacilitatorClient, "settle">,
    requirements: PaymentRequirements,
    options: Omit<
      BatchChannelManagerConfig,
      "store" | "settle" | "requirements" | "receiverAuthorizer"
    > = {},
  ): BatchChannelManager {
    if (typeof requirements.extra?.feePayer !== "string") {
      throw new Error(
        "createChannelManager requires requirements.extra.feePayer; pass the requirements " +
          "returned by enhancePaymentRequirements for the facilitator's /supported kind",
      );
    }
    return new BatchChannelManager({
      ...options,
      ...(this.config.receiverAuthorizer
        ? { receiverAuthorizer: this.config.receiverAuthorizer }
        : {}),
      requirements,
      settle: (payload, accepted) =>
        facilitator.settle(payload as unknown as PaymentPayload, accepted),
      store: this.store,
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
        const parsed = parseMoney(override);
        if (parsed.symbol !== undefined && parsed.symbol !== asset.symbol) {
          throw new Error(`extra.minDeposit currency must match ${asset.symbol}`);
        }
        configured = parsePositiveAmount(
          convertToTokenAmount(parsed.amount, asset.decimals),
          "minDeposit",
        );
      }
    }
    const minimum =
      configured ??
      amount *
        (this.isServerSigned(paymentRequirements)
          ? DEFAULT_SERVER_SIGNED_MIN_DEPOSIT_MULTIPLIER
          : DEFAULT_SERVER_MIN_DEPOSIT_MULTIPLIER);
    return (minimum > amount ? minimum : amount).toString();
  }

  /**
   * Reserve channel capacity and validate payloads before facilitator verify.
   *
   * @param ctx - Verify hook context
   * @returns Abort directive, local verify skip, or void to continue to the facilitator
   */
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
        this.assertStoredConfig(state, raw.channelConfig, ctx.requirements);
      }
      if (raw.type === "deposit" && !state) {
        const extra = ctx.requirements.extra!;
        const receiverAuthorizer = extra.receiverAuthorizer;
        if (typeof receiverAuthorizer !== "string") {
          throw new Error(BatchError.RECEIVER_AUTHORIZER_MISMATCH);
        }
        try {
          await verifyOpenTransaction(raw.deposit.transaction, {
            authorizedSigner: raw.channelConfig.payerAuthorizer,
            expectedBindingMemo: encodeReceiverBindingMemo(receiverAuthorizer),
            feePayer: String(extra.feePayer),
            from: raw.channelConfig.payer,
            maxCap: parseU64(raw.deposit.amount, "deposit.amount"),
            memo: typeof extra.memo === "string" ? extra.memo : undefined,
            mint: ctx.requirements.asset,
            openSlot: BigInt(raw.channelConfig.openSlot),
            payee: String(extra.feePayer),
            recipients: [{ bps: FULL_SPLIT_BPS, recipient: ctx.requirements.payTo }],
            tokenProgram: String(extra.tokenProgram),
            withdrawDelay: raw.channelConfig.withdrawDelay,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const reason = detail.includes("receiver binding")
            ? BatchError.RECEIVER_AUTHORIZER_MISMATCH
            : BatchError.SETUP_TRANSACTION;
          throw new Error(`${reason}: ${detail}`);
        }
      }

      if (raw.type === "deposit" || raw.type === "voucher" || raw.type === "authorization") {
        const proof = proofOf(raw);
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
            proof,
            requiresCumulativeCheck: true,
            ...(proof.signer === "server"
              ? {
                  ceiling: BigInt(ctx.requirements.amount),
                  requestId: proof.authorization.requestId,
                }
              : {}),
          });
          return;
        }
        const expected = (state?.chargedCumulativeAmount ?? 0n) + BigInt(ctx.requirements.amount);
        const topUp = raw.type === "deposit" && state ? { topUp: true as const } : {};
        switch (proof.signer) {
          case "client": {
            const submitted = BigInt(proof.voucher.maxClaimableAmount);
            const replay =
              state !== undefined &&
              submitted === state.chargedCumulativeAmount &&
              proof.voucher.signature === state.highestVoucherSignature;
            if (replay) throw new Error(CHANNEL_BUSY);
            if (!replay && submitted !== expected) {
              throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
            }
            this.requestContexts.set(ctx.paymentPayload, {
              channelId,
              proof,
              cumulative: submitted,
              ceiling: BigInt(ctx.requirements.amount),
              ...topUp,
            });
            break;
          }
          case "server":
            this.requestContexts.set(ctx.paymentPayload, {
              channelId,
              proof,
              ceiling: BigInt(ctx.requirements.amount),
              requestId: proof.authorization.requestId,
              ...topUp,
            });
            break;
          default: {
            const unexpected: never = proof;
            throw new Error(String(unexpected));
          }
        }
      } else if (raw.type === "refund") {
        if (!state) throw new Error(BatchError.CHANNEL_STATE);
        const serverMode = (raw.channelConfig.voucherSigner ?? "client") === "server";
        if (serverMode) {
          if (raw.voucher !== undefined) throw new Error(BatchError.VOUCHER_SIGNATURE);
          const authorization = raw.authorization;
          if (!authorization) throw new Error(BatchError.VOUCHER_SIGNATURE);
          this.requestContexts.set(ctx.paymentPayload, {
            channelId,
            ceiling: 0n,
            requestId: authorization.requestId,
          });
        } else {
          if (!raw.voucher) throw new Error(BatchError.VOUCHER_SIGNATURE);
          if (BigInt(raw.voucher.maxClaimableAmount) !== state.chargedCumulativeAmount) {
            throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
          }
          this.requestContexts.set(ctx.paymentPayload, { channelId });
        }
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

  /**
   * Merge facilitator snapshots, create reservations, and optionally skip the handler.
   *
   * @param ctx - Post-verify hook context
   * @returns Abort directive, skip-handler directive, or void to run the handler
   */
  private async afterVerify(
    ctx: VerifyResultContext,
  ): Promise<
    | void
    | { abort: true; reason: string; message?: string }
    | { skipHandler: true; response?: SkipHandlerDirective }
  > {
    const raw = ctx.paymentPayload.payload;
    if (!isBatchPayload(raw)) return;
    if (!ctx.result.isValid) {
      if (ctx.result.invalidReason === BatchError.CHANNEL_CLOSING) {
        await this.markChannelClosing(ctx.paymentPayload);
      }
      return;
    }
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
    if (request.requiresCumulativeCheck && request.proof?.signer === "client") {
      const state = await this.store.get(request.channelId);
      if (!state) return this.abort(BatchError.CHANNEL_STATE, "channel state unavailable");
      const submitted = BigInt(request.proof.voucher.maxClaimableAmount);
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
      if (request.requestId && request.ceiling !== undefined) {
        const reserved = await this.operationStore.reserve(
          request.channelId,
          request.requestId,
          request.ceiling,
        );
        if (!reserved.created) {
          throw new Error(CHANNEL_BUSY);
        }
        operationReserved = true;
      }
      await this.store.update(request.channelId, current => {
        const state = current ?? this.provisionalState(raw, ctx.requirements, request.channelId);
        if (state.status !== "open") throw new Error(BatchError.CLOSE_STATE);
        this.assertStoredConfig(state, raw.channelConfig, ctx.requirements);
        const reservations = liveReservations(state.reservations);
        const active = Object.values(reservations);
        const kind = raw.type === "refund" ? "close" : request.requestId ? "server" : "client";
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
              ...(request.requestId ? { requestId: request.requestId } : {}),
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
      if (operationReserved && request.requestId) {
        await this.operationStore.release(request.channelId, request.requestId);
      }
      this.requestContexts.delete(ctx.paymentPayload);
      return this.abort(
        classifyError(error),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Commit voucher charges for steady-state requests before facilitator settle.
   *
   * @param ctx - Pre-settle hook context
   * @returns Abort directive, local settle skip, or void to continue to the facilitator
   */
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
    const pendingId = request?.pendingId;
    if (!request || !pendingId) return this.abort(CHANNEL_BUSY, "missing reservation");
    const state = await this.store.get(request.channelId);
    if (!state?.reservations?.[pendingId]) {
      return this.abort(CHANNEL_BUSY, "reservation changed");
    }

    // Deposits go to the facilitator, which broadcasts the open/top_up
    // transaction in this post-handler settle; the voucher commits in
    // afterSettle once the deposit succeeds.
    if (raw.type === "deposit") return;

    try {
      const actual = BigInt(ctx.requirements.amount);
      const ceiling = request.ceiling ?? actual;
      const proof = request.proof ?? proofOf(raw);
      if (actual > ceiling || (proof.signer === "client" && actual !== ceiling)) {
        throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
      }
      const committed = await this.commitCharge({ ...request, pendingId }, proof, actual);
      this.requestContexts.delete(ctx.paymentPayload);
      return { skip: true, result: acceptedResponse(committed, ctx.requirements) };
    } catch (error) {
      return this.abort(
        classifyError(error),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Finalize deposits and refunds after a successful facilitator settlement.
   *
   * @param ctx - Post-settle hook context
   */
  private async afterSettle(ctx: SettleResultContext): Promise<void> {
    const raw = ctx.paymentPayload.payload;
    if (!ctx.result.success || !isBatchPayload(raw)) return;
    const request = this.requestContexts.get(ctx.paymentPayload);
    const pendingId = request?.pendingId;
    if (!request || !pendingId) return;

    if (raw.type === "deposit") {
      const reserved = await this.store.get(request.channelId);
      if (!reserved?.reservations?.[pendingId]) {
        throw new Error(CHANNEL_BUSY);
      }
      const actual = BigInt(ctx.requirements.amount);
      const ceiling = request.ceiling ?? actual;
      const proof = request.proof ?? proofOf(raw);
      if (actual > ceiling || (proof.signer === "client" && actual !== ceiling)) {
        throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
      }
      const committed = await this.commitCharge(
        { ...request, pendingId },
        proof,
        actual,
        current => {
          const confirmed = readChannelState(ctx.result);
          return {
            // A top-up raises the escrow ceiling; without this the stored deposit
            // would stay at the original open amount forever.
            deposit: confirmedDeposit(current.deposit, confirmed.balance),
            openSignature: ctx.result.transaction,
            settled: BigInt(confirmed.totalClaimed),
            onchainSyncedAt: Date.now(),
          };
        },
      );
      this.settlementExtras.set(
        ctx.paymentPayload,
        settlementExtra(committed, ctx.requirements.amount),
      );
      this.requestContexts.delete(ctx.paymentPayload);
      return;
    }

    if (raw.type === "refund") {
      await this.store.update(request.channelId, current => {
        if (!current?.reservations?.[pendingId]) {
          throw new Error(CHANNEL_BUSY);
        }
        const snapshot = readChannelState(ctx.result);
        const reservations = withoutReservation(current.reservations, pendingId);
        // A cooperative close seals and distributes in one step; only a
        // payer-signed request_close leaves a grace period running.
        if (snapshot.withdrawRequestedAt === 0) {
          const confirmed = BigInt(snapshot.totalClaimed);
          const settled = confirmed > current.settled ? confirmed : current.settled;
          return {
            ...current,
            closeSignature: ctx.result.transaction,
            onchainSyncedAt: Date.now(),
            payoutWatermark: settled,
            reservations,
            settled,
            status: "distributed",
          };
        }
        return {
          ...current,
          closeRequestedAt: snapshot.withdrawRequestedAt,
          closeSignature: ctx.result.transaction,
          onchainSyncedAt: Date.now(),
          reservations,
          status: "closing",
        };
      });
      this.requestContexts.delete(ctx.paymentPayload);
    }
  }

  /**
   * React to verify failures that indicate the payer is closing the channel.
   *
   * @param ctx - Verify failure hook context
   */
  private async onVerifyFailure(ctx: VerifyFailureContext): Promise<void> {
    if (ctx.error.message.includes(BatchError.CHANNEL_CLOSING)) {
      await this.markChannelClosing(ctx.paymentPayload);
    }
  }

  /**
   * Stop serving a paid request's channel once the facilitator reports the
   * payer is closing it, and let the host start a redemption pass.
   *
   * @param payload - The payment whose verification failed
   */
  private async markChannelClosing(payload: DeepReadonly<PaymentPayload>): Promise<void> {
    const raw = payload.payload;
    if (!isBatchPayload(raw) || raw.type === "refund") return;
    const channelId = this.requestContexts.get(payload)?.channelId;
    if (channelId === undefined) return;
    const state = await this.store.get(channelId);
    if (state?.status !== "open") return;
    await this.store.update(channelId, current => {
      const base = current ?? state;
      return base.status === "open" ? { ...base, status: "closing" } : base;
    });
    this.config.onChannelClosing?.(channelId);
  }

  /**
   * Drop reservations when settlement fails after verify.
   *
   * @param ctx - Settle failure hook context
   */
  private async onSettleFailure(ctx: SettleFailureContext): Promise<void> {
    await this.clearReservation(ctx.paymentPayload);
  }

  /**
   * Drop reservations when a verified payment is canceled before settle.
   *
   * @param ctx - Cancellation hook context
   */
  private async onCanceled(ctx: VerifiedPaymentCanceledContext): Promise<void> {
    await this.clearReservation(ctx.paymentPayload);
  }

  /**
   * Remove the pending reservation and release any server-signed operation lock.
   *
   * @param payload - Payment whose reservation should be cleared
   */
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
    if (request.requestId) {
      await this.operationStore.release(request.channelId, request.requestId);
    }
  }

  /**
   * Validate payload bindings against requirements and derive the channel PDA.
   *
   * @param raw - Batch-settlement payload from the client
   * @param requirements - Accepted payment requirements
   * @returns Channel id for the payload
   */
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
      typeof extra.receiverAuthorizer !== "string" ||
      raw.channelConfig.receiverAuthorizer !== extra.receiverAuthorizer ||
      (this.config.receiverAuthorizer !== undefined &&
        extra.receiverAuthorizer !== this.config.receiverAuthorizer.address)
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
    const proofAmount =
      raw.type === "refund" && voucherSigner === "server" ? "0" : requirements.amount;
    await this.validateRequestProof(raw, channelId, voucherSigner, proofAmount);
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

  /**
   * Validate the voucher or payer authorization carried by a request payload.
   *
   * @param raw - Batch-settlement payload
   * @param channelId - Derived channel id
   * @param voucherSigner - Expected signer mode from requirements
   * @param authorizedAmount - Amount the proof must authorize
   */
  private async validateRequestProof(
    raw: BatchPayload,
    channelId: string,
    voucherSigner: "client" | "server",
    authorizedAmount: string,
  ): Promise<void> {
    if (raw.type === "refund") {
      if (voucherSigner === "server") {
        if (raw.voucher !== undefined || !raw.authorization) {
          throw new Error(BatchError.VOUCHER_SIGNATURE);
        }
        await this.assertPayerAuthorization(raw.authorization, raw, channelId, authorizedAmount);
        return;
      }
      if (raw.authorization !== undefined || !raw.voucher) {
        throw new Error(BatchError.VOUCHER_SIGNATURE);
      }
      await this.assertSignedVoucher(raw.voucher, channelId, raw.channelConfig.payerAuthorizer);
      return;
    }
    const proof = proofOf(raw);
    if (proof.signer !== voucherSigner) throw new Error(BatchError.VOUCHER_SIGNATURE);
    switch (proof.signer) {
      case "client":
        await this.assertSignedVoucher(proof.voucher, channelId, raw.channelConfig.payerAuthorizer);
        return;
      case "server":
        await this.assertPayerAuthorization(proof.authorization, raw, channelId, authorizedAmount);
        return;
      default: {
        const unexpected: never = proof;
        throw new Error(String(unexpected));
      }
    }
  }

  /**
   * Verify a client-signed cumulative voucher for the channel.
   *
   * @param voucher - Voucher presented on the payload
   * @param channelId - Expected channel id
   * @param signer - Payer authorizer that must have signed the voucher
   */
  private async assertSignedVoucher(
    voucher: BatchVoucher,
    channelId: string,
    signer: string,
  ): Promise<void> {
    if (voucher.channelId !== channelId) throw new Error(BatchError.CHANNEL_ID_MISMATCH);
    this.assertExpiry(voucher);
    const valid = await verifyVoucherSignature({
      message: encodeVoucherMessageBytes({
        channelId,
        cumulativeAmount: BigInt(voucher.maxClaimableAmount),
        expiresAt: BigInt(voucher.expiresAt),
      }),
      signatureBase58: voucher.signature,
      signerBase58: signer,
    });
    if (!valid) throw new Error(BatchError.VOUCHER_SIGNATURE);
  }

  /**
   * Verify a server-signed payer authorization for the request.
   *
   * @param authorization - Authorization presented on the payload
   * @param raw - Parent batch payload
   * @param channelId - Expected channel id
   * @param authorizedAmount - Amount the authorization must cover
   */
  private async assertPayerAuthorization(
    authorization: BatchAuthorization,
    raw: BatchPayload,
    channelId: string,
    authorizedAmount: string,
  ): Promise<void> {
    if (
      authorization.channelId !== channelId ||
      authorization.payer !== raw.channelConfig.payer ||
      authorization.authorizedAmount !== authorizedAmount ||
      typeof authorization.requestId !== "string" ||
      authorization.requestId.length === 0 ||
      !(await verifyBatchAuthorization(authorization, raw.channelConfig.payerAuthorizer))
    ) {
      throw new Error(BatchError.VOUCHER_SIGNATURE);
    }
  }

  /**
   * Commit a reserved charge, persist the new voucher watermark, and complete server ops.
   *
   * @param request - Request context including the reservation id
   * @param proof - Client voucher or server authorization proof
   * @param actual - Measured charge for this request
   * @param patch - Optional extra fields to merge after a deposit settle
   * @returns Updated channel state after the commit
   */
  private async commitCharge(
    request: RequestContext & { pendingId: string },
    proof: BatchProof,
    actual: bigint,
    patch?: (current: ChannelState) => Partial<ChannelState>,
  ): Promise<ChannelState> {
    return this.store.update(request.channelId, async current => {
      const reservation = current?.reservations?.[request.pendingId];
      if (!current || !reservation) throw new Error(CHANNEL_BUSY);
      if (actual > reservation.ceiling) throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
      const cumulative = current.chargedCumulativeAmount + actual;
      const voucher = await this.voucherForCharge(proof, request.channelId, cumulative);
      if (request.requestId) {
        await this.operationStore.complete({
          actual,
          ceiling: reservation.ceiling,
          channelId: request.channelId,
          cumulative,
          requestId: request.requestId,
          status: "completed",
        });
      }
      return {
        ...current,
        ...patch?.(current),
        chargedCumulativeAmount: BigInt(voucher.maxClaimableAmount),
        highestVoucherExpiresAt: voucher.expiresAt,
        highestVoucherSignature: voucher.signature,
        reservations: withoutReservation(current.reservations, request.pendingId),
        signedMaxClaimable: BigInt(voucher.maxClaimableAmount),
      };
    });
  }

  /**
   * Resolve the voucher that records the new cumulative charge.
   *
   * @param proof - Proof from the verified payload
   * @param channelId - Channel being charged
   * @param cumulative - New cumulative claimable amount
   * @returns Voucher to persist as the watermark
   */
  private async voucherForCharge(
    proof: BatchProof,
    channelId: string,
    cumulative: bigint,
  ): Promise<BatchVoucher> {
    switch (proof.signer) {
      case "client":
        return proof.voucher;
      case "server":
        return this.signOperatorVoucher(channelId, cumulative);
      default: {
        const unexpected: never = proof;
        throw new Error(String(unexpected));
      }
    }
  }

  /**
   * Batch client vouchers must use the fixed zero expiry sentinel.
   *
   * @param voucher - Voucher whose expiry is checked
   */
  private assertExpiry(voucher: BatchVoucher): void {
    if (voucher.expiresAt !== 0) throw new Error(BatchError.VOUCHER_EXPIRY);
  }

  /**
   * Sign an operator voucher for server-signed channels.
   *
   * @param channelId - Channel the voucher is for
   * @param cumulativeAmount - Cumulative claimable amount
   * @returns Operator-signed voucher
   */
  private async signOperatorVoucher(
    channelId: string,
    cumulativeAmount: bigint,
  ): Promise<BatchVoucher> {
    if (!this.config.operator) throw new Error(BatchError.VOUCHER_SIGNATURE);
    return {
      channelId,
      expiresAt: CLIENT_VOUCHER_EXPIRES_AT,
      maxClaimableAmount: cumulativeAmount.toString(),
      signature: await signVoucher(this.config.operator, {
        channelId,
        cumulativeAmount,
        expiresAt: BigInt(CLIENT_VOUCHER_EXPIRES_AT),
      }),
    };
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

  /**
   * Seed channel state for a first deposit before the facilitator confirms open.
   *
   * @param raw - Deposit payload
   * @param requirements - Accepted requirements
   * @param channelId - Derived channel id
   * @returns Provisional open channel record
   */
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

  /**
   * Ensure stored channel bindings still match the challenged payload and authorizer.
   *
   * @param state - Stored channel record
   * @param config - Channel config from the payload
   * @param requirements - Requirements the payload answers
   */
  private assertStoredConfig(
    state: ChannelState,
    config: BatchChannelConfig,
    requirements: PaymentRequirements,
  ): void {
    if (JSON.stringify(state.channelConfig) !== JSON.stringify(config)) {
      throw new Error(BatchError.CHANNEL_STATE);
    }
    const challenged = requirements.extra?.receiverAuthorizer;
    if (
      state.channelConfig.receiverAuthorizer !== challenged ||
      (this.config.receiverAuthorizer !== undefined &&
        challenged !== this.config.receiverAuthorizer.address)
    ) {
      throw new Error(BatchError.RECEIVER_AUTHORIZER_MISMATCH);
    }
  }

  /**
   * Build a hook abort result with a machine reason and human message.
   *
   * @param reason - Machine-readable failure reason
   * @param message - Human-readable detail
   * @returns Abort directive for scheme hooks
   */
  private abort(reason: string, message: string) {
    return { abort: true as const, message, reason };
  }

  /**
   * Convert a parsed money amount to the default stablecoin for the network.
   *
   * @param amount - Decimal amount string
   * @param network - Network identifier
   * @param symbol - Optional stablecoin symbol
   * @returns Asset amount in atomic units
   */
  private defaultMoneyConversion(amount: string, network: Network, symbol?: string): AssetAmount {
    const assetInfo = getDefaultAsset(network, symbol);
    return {
      amount: convertToTokenAmount(amount, assetInfo.decimals),
      asset: assetInfo.asset,
      extra: {},
    };
  }
}

/**
 * Build a successful local settle response after committing a charge.
 *
 * @param state - Channel state after the commit
 * @param requirements - Requirements that were settled
 * @returns Settle response with channel extras for the client
 */
function acceptedResponse(state: ChannelState, requirements: PaymentRequirements): SettleResponse {
  return {
    success: true,
    payer: state.payer,
    transaction: "",
    network: requirements.network,
    amount: "",
    extra: settlementExtra(state, requirements.amount),
  };
}

/**
 * Settlement extras returned to the client after a committed charge.
 *
 * @param state - Channel state after the commit
 * @param chargedAmount - Amount charged on this request
 * @returns Extra fields for the settle response
 */
function settlementExtra(state: ChannelState, chargedAmount: string): Record<string, unknown> {
  const serverSigned = state.channelConfig.voucherSigner === "server";
  return {
    channelState: snapshot(state),
    commitmentId: `${state.channelId}:${state.signedMaxClaimable}`,
    chargedAmount,
    ...(serverSigned ? { voucher: serverVoucher(state) } : {}),
  };
}

/**
 * Operator voucher to echo back on server-signed channels when available.
 *
 * @param state - Channel state after the commit
 * @returns Stored operator voucher, if any
 */
function serverVoucher(state: ChannelState): BatchVoucher | undefined {
  if (state.highestVoucherSignature === undefined) return undefined;
  return {
    channelId: state.channelId,
    expiresAt: state.highestVoucherExpiresAt ?? 0,
    maxClaimableAmount: state.signedMaxClaimable.toString(),
    signature: state.highestVoucherSignature,
  };
}

/**
 * Serialize channel state for settlement and 402 enrichment responses.
 *
 * @param state - Channel record to snapshot
 * @returns Wire-shaped channel state object
 */
function snapshot(state: ChannelState) {
  return {
    channelId: state.channelId,
    balance: state.deposit.toString(),
    totalClaimed: state.settled.toString(),
    withdrawRequestedAt: state.closeRequestedAt ?? 0,
    chargedCumulativeAmount: state.chargedCumulativeAmount.toString(),
  };
}

/**
 * Drop expired reservations before enforcing capacity limits.
 *
 * @param reservations - Reservation map from channel state
 * @returns Reservations that have not yet expired
 */
function liveReservations(
  reservations: ChannelState["reservations"],
): NonNullable<ChannelState["reservations"]> {
  return Object.fromEntries(
    Object.entries(reservations ?? {}).filter(
      ([, reservation]) => reservation.expiresAt > Date.now(),
    ),
  );
}

/**
 * Remove one reservation id from the map.
 *
 * @param reservations - Reservation map from channel state
 * @param reservationId - Id to remove
 * @returns Updated reservation map
 */
function withoutReservation(
  reservations: ChannelState["reservations"],
  reservationId: string,
): ChannelState["reservations"] {
  return Object.fromEntries(
    Object.entries(reservations ?? {}).filter(([id]) => id !== reservationId),
  );
}

/**
 * Merge settlement extras without overwriting keys already on the response.
 *
 * @param extra - New extra fields to attach
 * @param existing - Extra fields already on the settle response
 * @returns Filtered extras safe to merge
 */
function withoutExistingFields(
  extra: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(extra).filter(([key]) => !(key in (existing ?? {}))));
}

/**
 * Read the channel snapshot from a facilitator verify response.
 *
 * Returns nothing when the response carries no `totalClaimed` — a `deposit`
 * verify has no channel to snapshot yet — or when a field is not the shape it
 * claims: a malformed snapshot must not become a serving record.
 *
 * @param result - The facilitator's verify response
 * @returns The snapshot, or nothing when the response carries none
 */
function readVerifiedChannelState(result: VerifyResponse): VerifiedChannelState | undefined {
  // Spec 4.5: the verify `extra` carries `channelId`, `balance`, `totalClaimed`
  // and `withdrawRequestedAt` as flat siblings. A deposit verify has no
  // channel yet and reports only `channelId`, which is not a snapshot.
  const raw = result.extra;
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

/**
 * Read `channelState` from a facilitator settle response.
 *
 * @param result - Facilitator settle response
 * @returns Parsed channel snapshot fields with safe defaults
 */
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

/**
 * Whether locally cached onchain fields are still within the configured TTL.
 *
 * @param state - Channel record with optional `onchainSyncedAt`
 * @param configuredTtlMs - Override TTL in milliseconds
 * @returns True when local snapshot may be trusted for verify fast-path
 */
function isOnchainStateFresh(state: ChannelState, configuredTtlMs: number | undefined): boolean {
  if (state.onchainSyncedAt === undefined) return false;
  const ttlMs = configuredTtlMs ?? defaultOnchainStateTtlMs(state.withdrawDelay);
  return Date.now() - state.onchainSyncedAt <= ttlMs;
}

/**
 * Default onchain snapshot TTL derived from the channel withdraw delay.
 *
 * @param withdrawDelaySeconds - Channel withdraw delay in seconds
 * @returns TTL in milliseconds, clamped between 30s and 5m
 */
function defaultOnchainStateTtlMs(withdrawDelaySeconds: number): number {
  const withdrawDelayMs = Math.max(0, withdrawDelaySeconds) * 1_000;
  return Math.min(5 * 60_000, Math.max(30_000, Math.floor(withdrawDelayMs / 3)));
}

/**
 * Parse a non-zero unsigned integer field from requirements or extras.
 *
 * @param value - Decimal string amount
 * @param field - Field name used in error messages
 * @returns Parsed positive amount
 */
function parsePositiveAmount(value: string, field: string): bigint {
  const amount = parseU64(value, field);
  if (amount === 0n) throw new Error(`${field} must resolve to a positive integer`);
  return amount;
}

/**
 * Map thrown errors to batch-settlement machine reasons for hook responses.
 *
 * @param error - Caught error from hook logic
 * @returns Machine-readable reason string
 */
function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(CHANNEL_BUSY)) return CHANNEL_BUSY;
  return Object.values(BatchError).find(value => message.includes(value)) ?? "transaction_failed";
}
