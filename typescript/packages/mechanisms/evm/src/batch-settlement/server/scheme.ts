import {
  AssetAmount,
  Network,
  PaymentFlowConfig,
  PaymentPayload,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemeServerHooks,
  MoneyParser,
  SupportedKind,
} from "@x402/core/types";
import type { DeepReadonly } from "@x402/core/types";
import type {
  SettleContext,
  SettleResultContext,
  VerifiedPaymentCanceledContext,
} from "@x402/core/server";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import type { FacilitatorClient } from "@x402/core/server";
import { getAddress, isAddress } from "viem";
import { BatchSettlementChannelManager } from "./channelManager";
import { findDefaultAsset, getDefaultAsset } from "../../defaultAssets";
import type { AuthorizerSigner, BatchSettlementAssetTransferMethod } from "../types";
import {
  BATCH_SETTLEMENT_SCHEME,
  DEFAULT_SERVER_MIN_DEPOSIT_MULTIPLIER,
  MAX_WITHDRAW_DELAY,
  MIN_WITHDRAW_DELAY,
} from "../constants";
import {
  advertisedVoucherManagers,
  defaultOnchainStateTtlMs,
  voucherStoreMode,
  type VoucherStoreMode,
} from "../voucherStore";
import * as Errors from "../errors";
import type { BatchSettlementChannelStateExtra, BatchSettlementVoucherStateExtra } from "../types";
import {
  InMemoryChannelStorage,
  ChannelStorage,
  ChannelLockStorage,
  isChannelLockStorage,
  rethrowLockImplementationError,
  type Channel,
} from "./storage";
import {
  handleAfterVerify,
  handleBeforeVerify,
  handleEnrichPaymentRequiredResponse,
  handleVerifyFailure,
  handleVerifiedPaymentCanceled,
} from "./verify";
import {
  handleAfterSettle,
  handleBeforeSettle,
  handleEnrichSettlementPayload,
  handleEnrichSettlementResponse,
  handleSettleFailure,
} from "./settle";
import {
  handleManagedAfterSettle,
  handleManagedAfterVerify,
  handleManagedBeforeSettle,
  handleManagedBeforeVerify,
  handleManagedEnrichPaymentRequiredResponse,
  handleManagedEnrichSettlementPayload,
  handleManagedEnrichSettlementResponse,
  handleManagedSettleFailure,
  handleManagedSettleOnCancel,
  handleManagedVerifiedPaymentCanceled,
  handleManagedVerifyFailure,
} from "./managed";

export type { VoucherStoreMode };

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const REFUND_CONSENT_UNAVAILABLE =
  "Facilitator-managed mode needs a refund consent path: configure a refundAuthorizerSigner " +
  "or use a facilitator that advertises delegatedRefund: true";

type BatchSettlementEvmSchemeServerConfigBase = {
  storage?: ChannelStorage;
  onchainStateTtlMs?: number;
  enforceMinDeposit?: boolean;
};

/** Self-managed voucher store (default). `storage` is authoritative. */
export type BatchSettlementSelfManagedServerConfig = BatchSettlementEvmSchemeServerConfigBase & {
  voucherStoreMode?: "self";
  lockStorage?: ChannelLockStorage;
  receiverAuthorizerSigner?: AuthorizerSigner;
  withdrawDelay?: number;
};

/**
 * Facilitator-managed voucher store. `storage` is a replica written after
 * successful `/settle` and is never read on the hot path.
 */
export type BatchSettlementFacilitatorManagedServerConfig =
  BatchSettlementEvmSchemeServerConfigBase & {
    voucherStoreMode: "facilitator";
    /**
     * Server-owned refund authorizer announced as `extra.refundAuthorizer` and packed into the
     * channel salt. When omitted, the 402 omits `extra.refundAuthorizer` and refunds are
     * authorized by the authenticated `/settle` caller, which requires the facilitator to
     * advertise `extra.delegatedRefund: true`.
     */
    refundAuthorizerSigner?: AuthorizerSigner;
  };

export type BatchSettlementEvmSchemeServerConfig =
  | BatchSettlementSelfManagedServerConfig
  | BatchSettlementFacilitatorManagedServerConfig;

export interface BatchSettlementRequestContext {
  channelId?: string;
  pendingId?: string;
  channelSnapshot?: Channel;
  localVerify?: boolean;
  reservationCommitted?: boolean;
  correctiveChannelState?: BatchSettlementChannelStateExtra;
  correctiveVoucherState?: BatchSettlementVoucherStateExtra;
}

type VoucherStoreHandlers = {
  onBeforeVerify: typeof handleBeforeVerify;
  onAfterVerify: typeof handleAfterVerify;
  onBeforeSettle: typeof handleBeforeSettle;
  onAfterSettle: typeof handleAfterSettle;
  onVerifyFailure: typeof handleVerifyFailure;
  onSettleFailure: typeof handleSettleFailure;
  onVerifiedPaymentCanceled: typeof handleVerifiedPaymentCanceled;
  enrichPaymentRequiredResponse: typeof handleEnrichPaymentRequiredResponse;
  enrichSettlementPayload: typeof handleEnrichSettlementPayload;
  enrichSettlementResponse: typeof handleEnrichSettlementResponse;
};

const HANDLERS: Record<VoucherStoreMode, VoucherStoreHandlers> = {
  self: {
    onBeforeVerify: handleBeforeVerify,
    onAfterVerify: handleAfterVerify,
    onBeforeSettle: handleBeforeSettle,
    onAfterSettle: handleAfterSettle,
    onVerifyFailure: handleVerifyFailure,
    onSettleFailure: handleSettleFailure,
    onVerifiedPaymentCanceled: handleVerifiedPaymentCanceled,
    enrichPaymentRequiredResponse: handleEnrichPaymentRequiredResponse,
    enrichSettlementPayload: handleEnrichSettlementPayload,
    enrichSettlementResponse: handleEnrichSettlementResponse,
  },
  facilitator: {
    onBeforeVerify: handleManagedBeforeVerify,
    onAfterVerify: handleManagedAfterVerify,
    onBeforeSettle: handleManagedBeforeSettle,
    onAfterSettle: handleManagedAfterSettle,
    onVerifyFailure: handleManagedVerifyFailure,
    onSettleFailure: handleManagedSettleFailure,
    onVerifiedPaymentCanceled: handleManagedVerifiedPaymentCanceled,
    enrichPaymentRequiredResponse: handleManagedEnrichPaymentRequiredResponse,
    enrichSettlementPayload: handleManagedEnrichSettlementPayload,
    enrichSettlementResponse: handleManagedEnrichSettlementResponse,
  },
};

/**
 * Server-side implementation of the `batch-settlement` scheme for EVM networks.
 */
export class BatchSettlementEvmScheme implements SchemeNetworkServer {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly defaultAssetTransferMethod: BatchSettlementAssetTransferMethod = "eip3009";
  readonly paymentFlows = {
    eip3009: { supported: ["authorization"], default: "authorization" },
    permit2: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<BatchSettlementAssetTransferMethod, PaymentFlowConfig>;
  readonly schemeHooks: SchemeServerHooks;

  private readonly requestContexts = new WeakMap<
    DeepReadonly<PaymentPayload>,
    BatchSettlementRequestContext
  >();
  private moneyParsers: MoneyParser[] = [];
  private readonly storage: ChannelStorage;
  private readonly lockStorage: ChannelLockStorage | undefined;
  private readonly receiverAuthorizerSigner: AuthorizerSigner | undefined;
  private readonly refundAuthorizerSigner: AuthorizerSigner | undefined;
  private readonly receiverAddress: `0x${string}`;
  private readonly withdrawDelay: number;
  private readonly onchainStateTtlMs: number;
  private readonly enforceMinDeposit: boolean;
  private readonly configuredMode: VoucherStoreMode;

  /**
   * Constructs a batched server scheme.
   *
   * @param receiverAddress - The server's receiver address (payTo).
   * @param config - Discriminated voucher-store config. Omit `voucherStoreMode`
   *   (or pass `"self"`) for self-managed; pass `"facilitator"` for a replica store.
   */
  constructor(receiverAddress: `0x${string}`, config: BatchSettlementEvmSchemeServerConfig = {}) {
    this.receiverAddress = receiverAddress;
    this.storage = config.storage ?? new InMemoryChannelStorage();
    this.enforceMinDeposit = config.enforceMinDeposit ?? false;

    if (config.voucherStoreMode === "facilitator") {
      this.configuredMode = "facilitator";
      this.receiverAuthorizerSigner = undefined;
      this.refundAuthorizerSigner = config.refundAuthorizerSigner;
      this.lockStorage = undefined;
      this.withdrawDelay = MIN_WITHDRAW_DELAY;
      this.onchainStateTtlMs =
        config.onchainStateTtlMs ?? defaultOnchainStateTtlMs(this.withdrawDelay);
    } else {
      this.configuredMode = "self";
      this.receiverAuthorizerSigner = config.receiverAuthorizerSigner;
      this.refundAuthorizerSigner = undefined;
      this.lockStorage =
        config.lockStorage ??
        (isChannelLockStorage(this.storage) ? this.storage : new InMemoryChannelStorage());
      this.withdrawDelay = config.withdrawDelay ?? MIN_WITHDRAW_DELAY;
      this.onchainStateTtlMs =
        config.onchainStateTtlMs ?? defaultOnchainStateTtlMs(this.withdrawDelay);
    }

    const mismatch = {
      abort: true as const,
      reason: Errors.ErrVoucherStoreModeMismatch,
      message: "Payment requirements voucherManager does not match the server voucherStoreMode",
    };
    this.schemeHooks = {
      onBeforeVerify: ctx =>
        this.runHook(ctx.requirements, h => h.onBeforeVerify(this, ctx), mismatch),
      onAfterVerify: ctx =>
        this.runHook(ctx.requirements, h => h.onAfterVerify(this, ctx), mismatch),
      onBeforeSettle: ctx =>
        this.runHook(ctx.requirements, h => h.onBeforeSettle(this, ctx), mismatch),
      onAfterSettle: ctx =>
        this.runHook(ctx.requirements, h => h.onAfterSettle(this, ctx), undefined),
      onVerifyFailure: ctx =>
        this.runHook(ctx.requirements, h => h.onVerifyFailure(this, ctx), undefined),
      onSettleFailure: ctx =>
        this.runHook(ctx.requirements, h => h.onSettleFailure(this, ctx), undefined),
      onVerifiedPaymentCanceled: ctx =>
        this.runHook(ctx.requirements, h => h.onVerifiedPaymentCanceled(this, ctx), undefined),
    };
  }

  /**
   * Adds server-owned settlement fields before facilitator settlement.
   *
   * @param ctx - Settlement context for the current payment.
   * @returns Additive payload fields, or nothing when no enrichment is needed.
   */
  enrichSettlementPayload = (ctx: SettleContext): Promise<Record<string, unknown> | void> =>
    this.requireHandlers(ctx.requirements).enrichSettlementPayload(this, ctx);

  /**
   * Managed cancel: settle so the facilitator can drop the admission lock.
   * Enrichment stamps `cancel: true`; the facilitator must not charge, deposit,
   * or refund. Self-managed cleanup stays on `onVerifiedPaymentCanceled`.
   *
   * @param ctx - Cancellation context from the resource server.
   * @returns Zero-amount requirements for managed cancels; void otherwise.
   */
  settleOnCancel(ctx: VerifiedPaymentCanceledContext): PaymentRequirements | void {
    switch (this.configuredMode) {
      case "facilitator":
        return handleManagedSettleOnCancel(ctx);
      case "self":
        return;
      default: {
        const _exhaustive: never = this.configuredMode;
        return _exhaustive;
      }
    }
  }

  /**
   * Adds corrective channel state to payment-required responses when available.
   *
   * @param ctx - Payment-required response context for the current request.
   * @returns Updated payment requirements, or nothing when no enrichment is needed.
   */
  enrichPaymentRequiredResponse = (
    ctx: Parameters<typeof handleEnrichPaymentRequiredResponse>[1],
  ): Promise<PaymentRequirements[] | void> => {
    if (ctx.paymentPayload) {
      const accepted = ctx.paymentPayload.accepted;
      if (!this.handlersFor(accepted)) {
        return Promise.resolve();
      }
    }
    return HANDLERS[this.configuredMode].enrichPaymentRequiredResponse(this, ctx);
  };

  /**
   * Adds server-owned extra fields after facilitator settlement.
   *
   * @param ctx - Settlement result context for the current payment.
   * @returns Additive response extra fields, or nothing when no enrichment is needed.
   */
  enrichSettlementResponse = (ctx: SettleResultContext): Promise<Record<string, unknown> | void> =>
    this.runHook(ctx.requirements, h => h.enrichSettlementResponse(this, ctx), undefined);

  /**
   * Merges batch-settlement state into the current request context.
   *
   * @param payload - Request-scoped payment payload object.
   * @param context - Partial context fields to merge.
   */
  mergeRequestContext(
    payload: DeepReadonly<PaymentPayload>,
    context: BatchSettlementRequestContext,
  ): void {
    this.requestContexts.set(payload, {
      ...this.requestContexts.get(payload),
      ...context,
    });
  }

  /**
   * Reads batch-settlement state for the current request without clearing it.
   *
   * @param payload - Request-scoped payment payload object.
   * @returns Request context, if one was recorded.
   */
  readRequestContext(
    payload: DeepReadonly<PaymentPayload>,
  ): BatchSettlementRequestContext | undefined {
    return this.requestContexts.get(payload);
  }

  /**
   * Reads and clears batch-settlement state for the current request.
   *
   * @param payload - Request-scoped payment payload object.
   * @returns Request context, if one was recorded.
   */
  takeRequestContext(
    payload: DeepReadonly<PaymentPayload>,
  ): BatchSettlementRequestContext | undefined {
    const context = this.requestContexts.get(payload);
    this.requestContexts.delete(payload);
    return context;
  }

  /**
   * Stores a channel snapshot for the current settlement request.
   *
   * @param payload - Request-scoped payment payload object.
   * @param channel - Channel state to use during response enrichment.
   */
  rememberChannelSnapshot(payload: DeepReadonly<PaymentPayload>, channel: Channel): void {
    this.mergeRequestContext(payload, {
      channelId: channel.channelId,
      channelSnapshot: channel,
    });
  }

  /**
   * Reads and clears a channel snapshot for the current settlement request.
   *
   * @param payload - Request-scoped payment payload object.
   * @returns Stored channel state, if one was recorded.
   */
  takeChannelSnapshot(payload: DeepReadonly<PaymentPayload>): Channel | undefined {
    return this.takeRequestContext(payload)?.channelSnapshot;
  }

  /**
   * Releases this request's admission lock without touching a newer holder or
   * deleting the request-context entry.
   *
   * @param payload - Request-scoped payment payload object.
   */
  async releasePendingRequest(payload: DeepReadonly<PaymentPayload>): Promise<void> {
    const context = this.readRequestContext(payload);
    if (!context?.reservationCommitted || !context.channelId || !context.pendingId) {
      return;
    }

    if (this.lockStorage) {
      try {
        await this.lockStorage.release(context.channelId, context.pendingId);
      } catch (err) {
        rethrowLockImplementationError(err);
        // Lock-store I/O loss is optimistic: the charge CAS still serializes commits.
      }
    }
    this.mergeRequestContext(payload, { reservationCommitted: false });
  }

  /**
   * Releases this request's admission lock, then deletes the request-context entry.
   * Use on terminal paths that no longer need the snapshot.
   *
   * @param payload - Request-scoped payment payload object.
   */
  async clearPendingRequest(payload: DeepReadonly<PaymentPayload>): Promise<void> {
    await this.releasePendingRequest(payload);
    this.takeRequestContext(payload);
  }

  /**
   * Registers a custom money parser for converting price strings to token amounts.
   *
   * @param parser - A parser function to try before the default USD→token conversion.
   * @returns `this` for chaining.
   */
  registerMoneyParser(parser: MoneyParser): this {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Resolves a human-readable price (e.g. `"$0.01"`) into an onchain token amount.
   *
   * @param price - A price string, number, or explicit {@link AssetAmount}.
   * @param network - CAIP-2 network identifier for looking up the default asset.
   * @returns Token amount with asset address and metadata.
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      }
      return {
        amount: price.amount,
        asset: price.asset,
        extra: price.extra || {},
      };
    }

    const { amount, symbol } = parseMoney(price);

    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    return this.defaultMoneyConversion(amount, network, symbol);
  }

  /**
   * Decimals for a known default asset, or undefined.
   *
   * @param asset - Asset address or symbol
   * @param network - Target network
   * @returns Decimals when the asset is a known default; otherwise undefined
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    return findDefaultAsset(asset, network)?.decimals;
  }

  /**
   * Injects batched-specific fields into the payment requirements returned to
   * the client (receiverAuthorizer, withdrawDelay). Asset metadata (name,
   * version, assetTransferMethod) is left untouched — it is already set by
   * `parsePrice` or supplied explicitly by the caller, and is not re-derived
   * from the default-asset registry here so unlisted networks keep working.
   *
   * @param paymentRequirements - Base payment requirements from the middleware.
   * @param supportedKind - Matched scheme/network kind (extra may contain overrides).
   * @param supportedKind.x402Version - Protocol version from the matched kind.
   * @param supportedKind.scheme - Scheme name from the matched kind.
   * @param supportedKind.network - Network identifier from the matched kind.
   * @param supportedKind.extra - Optional extra fields on the matched kind.
   * @param _extensionKeys - Extension keys (unused).
   * @returns Enhanced payment requirements with batched fields in `extra`.
   */
  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    _extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    void _extensionKeys;

    switch (this.configuredMode) {
      case "facilitator": {
        if (!advertisedVoucherManagers(supportedKind.extra).includes("facilitator")) {
          throw new Error(
            'Facilitator-managed mode requires advertised extra.voucherManager to include "facilitator"',
          );
        }
        const advertisedAuthorizer = supportedKind.extra?.receiverAuthorizer;
        if (
          typeof advertisedAuthorizer !== "string" ||
          getAddress(advertisedAuthorizer) === ZERO_ADDRESS
        ) {
          throw new Error("Payment requirements must include a non-zero extra.receiverAuthorizer");
        }
        const advertisedDelay = supportedKind.extra?.withdrawDelay;
        if (typeof advertisedDelay !== "number") {
          throw new Error("Facilitator-managed mode requires advertised extra.withdrawDelay");
        }
        // extra.refundAuthorizer is set only for a server-owned refund key. Otherwise the 402
        // omits it and refunds rely on the facilitator's delegatedRefund.
        if (!this.refundAuthorizerSigner && supportedKind.extra?.delegatedRefund !== true) {
          throw new Error(REFUND_CONSENT_UNAVAILABLE);
        }
        const { refundAuthorizer: _ignoredRefundAuthorizer, ...baseExtra } =
          paymentRequirements.extra ?? {};
        void _ignoredRefundAuthorizer;

        return {
          ...paymentRequirements,
          extra: {
            ...baseExtra,
            receiverAuthorizer: getAddress(advertisedAuthorizer),
            withdrawDelay: advertisedDelay,
            voucherManager: "facilitator",
            ...(this.refundAuthorizerSigner
              ? { refundAuthorizer: getAddress(this.refundAuthorizerSigner.address) }
              : {}),
            minDeposit: await this.resolveMinDepositHint(paymentRequirements),
          },
        };
      }
      case "self": {
        if (!advertisedVoucherManagers(supportedKind.extra).includes("server")) {
          throw new Error(
            'Self-managed mode requires advertised extra.voucherManager to include "server"',
          );
        }
        const receiverAuthorizer =
          this.receiverAuthorizerSigner?.address ??
          (typeof supportedKind.extra?.receiverAuthorizer === "string"
            ? supportedKind.extra.receiverAuthorizer
            : undefined);

        if (!receiverAuthorizer || getAddress(receiverAuthorizer) === ZERO_ADDRESS) {
          throw new Error("Payment requirements must include a non-zero extra.receiverAuthorizer");
        }

        return {
          ...paymentRequirements,
          extra: {
            ...paymentRequirements.extra,
            receiverAuthorizer: getAddress(receiverAuthorizer),
            withdrawDelay: this.withdrawDelay,
            minDeposit: await this.resolveMinDepositHint(paymentRequirements),
          },
        };
      }
      default: {
        const _exhaustive: never = this.configuredMode;
        throw new Error(`unhandled voucher store mode: ${_exhaustive}`);
      }
    }
  }

  /**
   * Fails server startup when this scheme delegates the receiver-authorizer role
   * but the facilitator does not advertise a usable `receiverAuthorizer`.
   *
   * @param network - The network identifier being validated.
   * @param supportedKind - The facilitator's advertised kind for this scheme/network.
   * @param _ - Extensions advertised by the facilitator (unused).
   * @returns A problem message when delegation is impossible, or void when valid.
   */
  validateFacilitatorSupport(
    network: Network,
    supportedKind: SupportedKind,
    _: string[],
  ): string | void {
    const advertised = supportedKind.extra?.receiverAuthorizer;
    const hasValidAuthorizer =
      typeof advertised === "string" &&
      isAddress(advertised) &&
      getAddress(advertised) !== ZERO_ADDRESS;
    const managers = advertisedVoucherManagers(supportedKind.extra);

    switch (this.configuredMode) {
      case "facilitator": {
        if (!managers.includes("facilitator")) {
          return (
            `voucherStoreMode "facilitator" is configured but the facilitator does not ` +
            `advertise voucherManager "facilitator" on ${network}.`
          );
        }
        if (!hasValidAuthorizer) {
          return `voucherStore mode requires a non-zero advertised receiverAuthorizer on ${network}.`;
        }
        const delay = supportedKind.extra?.withdrawDelay;
        if (typeof delay !== "number" || delay < MIN_WITHDRAW_DELAY || delay > MAX_WITHDRAW_DELAY) {
          return `voucherStore mode requires an in-range advertised withdrawDelay on ${network}.`;
        }
        if (!this.refundAuthorizerSigner && supportedKind.extra?.delegatedRefund !== true) {
          return (
            `no refundAuthorizerSigner is configured and the facilitator does not advertise ` +
            `delegatedRefund: true on ${network}. Configure a refundAuthorizerSigner or use a ` +
            `facilitator that advertises delegatedRefund: true.`
          );
        }
        return;
      }
      case "self": {
        if (!managers.includes("server")) {
          return (
            `the facilitator advertises voucherManager without "server" on ${network}, ` +
            `so a self-managed server cannot use it.`
          );
        }
        if (this.receiverAuthorizerSigner) return;

        if (!hasValidAuthorizer) {
          return (
            `no receiverAuthorizerSigner is configured and the facilitator does not advertise a ` +
            `receiverAuthorizer on ${network}. Configure a receiverAuthorizerSigner or use a ` +
            `facilitator that advertises one.`
          );
        }
        // Delegated receiverAuthorizer: refunds rely on the facilitator honoring unsigned
        // caller-identity refunds. An absent field is a legacy facilitator and passes.
        if (supportedKind.extra?.delegatedRefund === false) {
          return (
            `the facilitator explicitly advertises delegatedRefund: false on ${network}, so ` +
            `refunds on channels with a delegated receiverAuthorizer cannot work. Configure a ` +
            `receiverAuthorizerSigner or use a facilitator that supports delegated refunds.`
          );
        }
        return;
      }
      default: {
        const _exhaustive: never = this.configuredMode;
        return `unhandled voucher store mode: ${_exhaustive}`;
      }
    }
  }

  /**
   * Returns the underlying channel storage instance.
   *
   * @returns The configured {@link ChannelStorage} backend.
   */
  getStorage(): ChannelStorage {
    return this.storage;
  }

  /**
   * Returns the admission lock store.
   *
   * Present in self-managed mode. Facilitator-managed schemes have no local
   * lock — the facilitator owns the hold — and return `undefined`.
   *
   * @returns The configured {@link ChannelLockStorage} backend, if any.
   */
  getLockStorage(): ChannelLockStorage | undefined {
    return this.lockStorage;
  }

  /**
   * Returns the server's receiver address.
   *
   * @returns Receiver wallet address for the payment channel.
   */
  getReceiverAddress(): `0x${string}` {
    return this.receiverAddress;
  }

  /**
   * Returns the configured withdraw delay (seconds).
   *
   * @returns Withdraw delay in seconds before uncooperative withdrawal is allowed.
   */
  getWithdrawDelay(): number {
    return this.withdrawDelay;
  }

  /**
   * Returns how long mirrored onchain channel state is trusted for local voucher verification.
   *
   * @returns Freshness window in milliseconds.
   */
  getOnchainStateTtlMs(): number {
    return this.onchainStateTtlMs;
  }

  /**
   * Returns whether deposits below the announced `extra.minDeposit` hint are rejected.
   *
   * @returns `true` when `enforceMinDeposit` is enabled.
   */
  getEnforceMinDeposit(): boolean {
    return this.enforceMinDeposit;
  }

  /**
   * Returns the receiver-authorizer signer, if configured.
   *
   * @returns Receiver-authorizer signer, or `undefined` when not set.
   */
  getReceiverAuthorizerSigner(): AuthorizerSigner | undefined {
    return this.receiverAuthorizerSigner;
  }

  /**
   * Returns the signer used for managed refund consent.
   * Self-managed uses `receiverAuthorizerSigner`; managed uses `refundAuthorizerSigner`.
   *
   * @returns Refund-authorizer signer, or `undefined` when not set.
   */
  getRefundAuthorizerSigner(): AuthorizerSigner | undefined {
    switch (this.configuredMode) {
      case "self":
        return this.receiverAuthorizerSigner;
      case "facilitator":
        return this.refundAuthorizerSigner;
      default: {
        const _exhaustive: never = this.configuredMode;
        return _exhaustive;
      }
    }
  }

  /**
   * Returns whether this scheme is constructed for a facilitator voucher store.
   *
   * @param network - CAIP-2 network identifier (unused; mode is instance-wide).
   * @returns True when constructed with `voucherStoreMode: "facilitator"`.
   */
  isFacilitatorManagedVoucherStore(network: Network): boolean {
    void network;
    return this.configuredMode === "facilitator";
  }

  /**
   * Creates a {@link BatchSettlementChannelManager} pre-configured with this scheme's
   * receiver, a token for the given network, and the provided facilitator.
   *
   * @param facilitator - Facilitator client for submitting onchain claims/settlements.
   * @param network - CAIP-2 network identifier (e.g. `"eip155:84532"`).
   * @param token - Explicit token address to use. Falls back to the network's
   *   default asset (from the registry) when omitted.
   * @returns A ready-to-use channel manager.
   */
  createChannelManager(
    facilitator: FacilitatorClient,
    network: Network,
    token?: `0x${string}`,
  ): BatchSettlementChannelManager {
    const resolvedToken = token ?? (getDefaultAsset(network).asset as `0x${string}`);
    return new BatchSettlementChannelManager({
      scheme: this,
      facilitator,
      receiver: this.receiverAddress,
      token: resolvedToken,
      network,
    });
  }

  /**
   * Resolves the `extra.minDeposit` hint written on every 402.
   *
   * @param paymentRequirements - Base payment requirements for the current request.
   * @returns Atomic minimum deposit hint string.
   */
  async resolveMinDepositHint(paymentRequirements: PaymentRequirements): Promise<string> {
    const amount = BigInt(paymentRequirements.amount);
    const routeOverride = paymentRequirements.extra?.minDeposit;

    let configuredMin: bigint | undefined;
    if (typeof routeOverride === "string") {
      if (/^\d+$/.test(routeOverride)) {
        configuredMin = this.parseAtomicMinDeposit(routeOverride);
      } else {
        configuredMin = this.resolveRouteMoneyMinDeposit(routeOverride, paymentRequirements);
      }
    }

    if (configuredMin === undefined) {
      return (amount * BigInt(DEFAULT_SERVER_MIN_DEPOSIT_MULTIPLIER)).toString();
    }

    return (amount > configuredMin ? amount : configuredMin).toString();
  }

  /**
   * Converts a route-level Money `extra.minDeposit` override to atomic units.
   *
   * @param money - Money string from route `accepts.extra.minDeposit`.
   * @param requirement - Payment requirement supplying asset and network.
   * @returns Positive integer atomic min deposit.
   */
  private resolveRouteMoneyMinDeposit(money: string, requirement: PaymentRequirements): bigint {
    const defaultAsset = findDefaultAsset(requirement.asset, requirement.network);
    if (!defaultAsset) {
      throw new Error(
        `extra.minDeposit money values are only supported for default assets; ` +
          `use an integer atomic string for ${requirement.asset} on ${requirement.network}.`,
      );
    }

    const { amount } = parseMoney(money);
    return this.parseAtomicMinDeposit(convertToTokenAmount(amount, defaultAsset.decimals));
  }

  /**
   * Validates and normalizes an atomic min deposit amount.
   *
   * @param amount - Integer atomic amount string.
   * @returns Parsed positive bigint.
   */
  private parseAtomicMinDeposit(amount: string): bigint {
    if (!/^\d+$/.test(amount)) {
      throw new Error("minDeposit must resolve to a positive integer");
    }
    const value = BigInt(amount);
    if (value <= 0n) {
      throw new Error("minDeposit must resolve to a positive integer");
    }
    return value;
  }

  /**
   * Converts a decimal dollar amount to the network's default token amount.
   *
   * @param amount - Decimal amount in display units.
   * @param network - Target chain/network for default asset resolution.
   * @param symbol - Optional ticker from a suffixed price
   * @returns {@link AssetAmount} with integer token amount, contract address, and metadata.
   */
  private defaultMoneyConversion(amount: string, network: Network, symbol?: string): AssetAmount {
    const assetInfo = getDefaultAsset(network, symbol);
    const tokenAmount = convertToTokenAmount(amount, assetInfo.decimals);

    // EIP-3009 tokens always need name/version for their transferWithAuthorization domain.
    // Permit2 tokens only need them if the token supports EIP-2612 (for gasless permit signing).
    // Omitting name/version for permit2 tokens signals the client to skip EIP-2612 and use
    // ERC-20 approval gas sponsoring instead.
    const includeEip712Domain = !assetInfo.assetTransferMethod || assetInfo.supportsEip2612;

    return {
      amount: tokenAmount,
      asset: assetInfo.asset,
      extra: {
        ...(includeEip712Domain && {
          name: assetInfo.name,
          version: assetInfo.version,
        }),
        ...(assetInfo.assetTransferMethod && {
          assetTransferMethod: assetInfo.assetTransferMethod,
        }),
      },
    };
  }

  /**
   * Returns handlers when the payment requirements match this scheme's mode.
   *
   * @param requirements - Payment requirements to inspect.
   * @returns Matching handlers or undefined.
   */
  private handlersFor(requirements: PaymentRequirements): VoucherStoreHandlers | undefined {
    if (voucherStoreMode(requirements) !== this.configuredMode) {
      return undefined;
    }
    return HANDLERS[this.configuredMode];
  }

  /**
   * Runs a hook or returns the mode-mismatch fallback.
   *
   * @param requirements - Payment requirements to inspect.
   * @param run - Hook to run for matching requirements.
   * @param onMismatch - Fallback for a mode mismatch.
   * @returns The hook result.
   */
  private runHook<T>(
    requirements: PaymentRequirements,
    run: (handlers: VoucherStoreHandlers) => T | Promise<T>,
    onMismatch: T,
  ): Promise<T> {
    const handlers = this.handlersFor(requirements);
    return Promise.resolve(handlers ? run(handlers) : onMismatch);
  }

  /**
   * Returns handlers or throws when the payment requirements mode mismatches.
   *
   * @param requirements - Payment requirements to inspect.
   * @returns Matching handlers.
   */
  private requireHandlers(requirements: PaymentRequirements): VoucherStoreHandlers {
    const handlers = this.handlersFor(requirements);
    if (!handlers) {
      throw new Error(Errors.ErrVoucherStoreModeMismatch);
    }
    return handlers;
  }
}
