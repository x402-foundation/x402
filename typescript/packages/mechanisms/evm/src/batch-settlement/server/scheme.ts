import {
  AssetAmount,
  Network,
  PaymentPayload,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemeServerHooks,
  MoneyParser,
} from "@x402/core/types";
import type { DeepReadonly } from "@x402/core/types";
import type { SettleContext, SettleResultContext } from "@x402/core/server";
import { convertToTokenAmount, numberToDecimalString } from "@x402/core/utils";
import type { FacilitatorClient } from "@x402/core/server";
import { getAddress } from "viem";
import { BatchSettlementChannelManager } from "./channelManager";
import { getDefaultAsset } from "../../shared/defaultAssets";
import type { AuthorizerSigner } from "../types";
import { BATCH_SETTLEMENT_SCHEME, MIN_WITHDRAW_DELAY } from "../constants";
import { InMemoryChannelStorage, ChannelStorage, type Channel } from "./storage";
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

export interface BatchSettlementEvmSchemeServerConfig {
  storage?: ChannelStorage;
  receiverAuthorizerSigner?: AuthorizerSigner;
  withdrawDelay?: number;
  onchainStateTtlMs?: number;
}

export interface BatchSettlementRequestContext {
  channelId?: string;
  pendingId?: string;
  channelSnapshot?: Channel;
  localVerify?: boolean;
}

/**
 * Server-side implementation of the `batch-settlement` scheme for EVM networks.
 */
export class BatchSettlementEvmScheme implements SchemeNetworkServer {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly schemeHooks: SchemeServerHooks;

  private readonly requestContexts = new WeakMap<
    DeepReadonly<PaymentPayload>,
    BatchSettlementRequestContext
  >();
  private moneyParsers: MoneyParser[] = [];
  private readonly storage: ChannelStorage;
  private readonly receiverAuthorizerSigner: AuthorizerSigner | undefined;
  private readonly receiverAddress: `0x${string}`;
  private readonly withdrawDelay: number;
  private readonly onchainStateTtlMs: number;

  /**
   * Constructs a batched server scheme.
   *
   * @param receiverAddress - The server's receiver address (payTo).
   * @param config - Optional configuration for storage, receiver-authorizer signer, and withdraw delay.
   */
  constructor(receiverAddress: `0x${string}`, config?: BatchSettlementEvmSchemeServerConfig) {
    this.receiverAddress = receiverAddress;
    this.storage = config?.storage ?? new InMemoryChannelStorage();
    this.receiverAuthorizerSigner = config?.receiverAuthorizerSigner;
    this.withdrawDelay = config?.withdrawDelay ?? MIN_WITHDRAW_DELAY;
    this.onchainStateTtlMs =
      config?.onchainStateTtlMs ?? defaultOnchainStateTtlMs(this.withdrawDelay);
    this.schemeHooks = {
      onBeforeVerify: ctx => handleBeforeVerify(this, ctx),
      onAfterVerify: ctx => handleAfterVerify(this, ctx),
      onBeforeSettle: ctx => handleBeforeSettle(this, ctx),
      onAfterSettle: ctx => handleAfterSettle(this, ctx),
      onVerifyFailure: ctx => handleVerifyFailure(this, ctx),
      onSettleFailure: ctx => handleSettleFailure(this, ctx),
      onVerifiedPaymentCanceled: ctx => handleVerifiedPaymentCanceled(this, ctx),
    };
  }

  /**
   * Adds server-owned settlement fields before facilitator settlement.
   *
   * @param ctx - Settlement context for the current payment.
   * @returns Additive payload fields, or nothing when no enrichment is needed.
   */
  enrichSettlementPayload = (ctx: SettleContext): Promise<Record<string, unknown> | void> =>
    handleEnrichSettlementPayload(this, ctx);

  /**
   * Adds corrective channel state to payment-required responses when available.
   *
   * @param ctx - Payment-required response context for the current request.
   * @returns Updated payment requirements, or nothing when no enrichment is needed.
   */
  enrichPaymentRequiredResponse = (
    ctx: Parameters<typeof handleEnrichPaymentRequiredResponse>[1],
  ): Promise<PaymentRequirements[] | void> => handleEnrichPaymentRequiredResponse(this, ctx);

  /**
   * Adds server-owned extra fields after facilitator settlement.
   *
   * @param ctx - Settlement result context for the current payment.
   * @returns Additive response extra fields, or nothing when no enrichment is needed.
   */
  enrichSettlementResponse = (ctx: SettleResultContext): Promise<Record<string, unknown> | void> =>
    handleEnrichSettlementResponse(this, ctx);

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
   * Clears this request's pending reservation without touching newer reservations.
   *
   * @param payload - Request-scoped payment payload object.
   */
  async clearPendingRequest(payload: DeepReadonly<PaymentPayload>): Promise<void> {
    const context = this.takeRequestContext(payload);
    if (!context?.channelId || !context.pendingId) {
      return;
    }

    await this.storage.updateChannel(context.channelId, current => {
      if (!current || current.pendingRequest?.pendingId !== context.pendingId) {
        return current;
      }

      if (!context.channelSnapshot) {
        return undefined;
      }

      return {
        ...current,
        pendingRequest: undefined,
      };
    });
  }

  /**
   * Registers a custom money parser for converting price strings to token amounts.
   *
   * @param parser - A parser function to try before the default USD→token conversion.
   * @returns `this` for chaining.
   */
  registerMoneyParser(parser: MoneyParser): BatchSettlementEvmScheme {
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

    const amount = this.parseMoneyToDecimal(price);

    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    return this.defaultMoneyConversion(amount, network);
  }

  /**
   * Injects batched-specific fields into the payment requirements returned to
   * the client (receiverAuthorizer, withdrawDelay, EIP-712 domain info).
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

    const assetInfo = getDefaultAsset(paymentRequirements.network as Network);

    const receiverAuthorizer =
      this.receiverAuthorizerSigner?.address ??
      (typeof supportedKind.extra?.receiverAuthorizer === "string"
        ? supportedKind.extra.receiverAuthorizer
        : undefined);

    if (
      !receiverAuthorizer ||
      getAddress(receiverAuthorizer) === "0x0000000000000000000000000000000000000000"
    ) {
      throw new Error("Payment requirements must include a non-zero extra.receiverAuthorizer");
    }

    return {
      ...paymentRequirements,
      extra: {
        ...paymentRequirements.extra,
        receiverAuthorizer: getAddress(receiverAuthorizer),
        withdrawDelay: this.withdrawDelay,
        name: assetInfo.name,
        version: assetInfo.version,
        assetTransferMethod:
          paymentRequirements.extra?.assetTransferMethod ?? assetInfo.assetTransferMethod,
      },
    };
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
   * Returns the receiver-authorizer signer, if configured.
   *
   * @returns Receiver-authorizer signer, or `undefined` when not set.
   */
  getReceiverAuthorizerSigner(): AuthorizerSigner | undefined {
    return this.receiverAuthorizerSigner;
  }

  /**
   * Creates a {@link BatchSettlementChannelManager} pre-configured with this scheme's
   * receiver, default token for the given network, and the provided facilitator.
   *
   * @param facilitator - Facilitator client for submitting onchain claims/settlements.
   * @param network - CAIP-2 network identifier (e.g. `"eip155:84532"`).
   * @returns A ready-to-use channel manager.
   */
  createChannelManager(
    facilitator: FacilitatorClient,
    network: Network,
  ): BatchSettlementChannelManager {
    const token = getDefaultAsset(network).address as `0x${string}`;
    return new BatchSettlementChannelManager({
      scheme: this,
      facilitator,
      receiver: this.receiverAddress,
      token,
      network,
    });
  }

  /**
   * Parses a human-readable money string (e.g. `"$1.50"`) into a decimal number.
   *
   * @param money - Money string (may include `$`) or numeric amount.
   * @returns Parsed finite number.
   */
  private parseMoneyToDecimal(money: string | number): number {
    if (typeof money === "number") {
      return money;
    }

    const cleanMoney = money.replace(/^\$/, "").trim();
    const amount = parseFloat(cleanMoney);

    if (isNaN(amount)) {
      throw new Error(`Invalid money format: ${money}`);
    }

    return amount;
  }

  /**
   * Converts a decimal dollar amount to the network's default token amount.
   *
   * @param amount - Decimal amount in display units.
   * @param network - Target chain/network for default asset resolution.
   * @returns {@link AssetAmount} with integer token amount, contract address, and metadata.
   */
  private defaultMoneyConversion(amount: number, network: Network): AssetAmount {
    const assetInfo = getDefaultAsset(network);
    const tokenAmount = convertToTokenAmount(numberToDecimalString(amount), assetInfo.decimals);

    return {
      amount: tokenAmount,
      asset: assetInfo.address,
      extra: {
        name: assetInfo.name,
        version: assetInfo.version,
      },
    };
  }
}

/**
 * Derives a reasonable onchain state freshness window from the channel withdraw delay.
 *
 * @param withdrawDelaySeconds - Onchain withdraw delay for the channel, in seconds.
 * @returns TTL in milliseconds, clamped between 30 seconds and 5 minutes.
 */
function defaultOnchainStateTtlMs(withdrawDelaySeconds: number): number {
  const withdrawDelayMs = Math.max(0, withdrawDelaySeconds) * 1000;
  return Math.min(5 * 60 * 1000, Math.max(30 * 1000, Math.floor(withdrawDelayMs / 3)));
}
