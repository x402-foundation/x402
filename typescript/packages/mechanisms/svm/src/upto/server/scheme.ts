import type { MessagePartialSigner } from "@solana/kit";
import type { SettleContext, VerifiedPaymentCanceledContext } from "@x402/core/server";
import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { findDefaultAsset, getDefaultAsset } from "../../defaultAssets";
import { DEFAULT_GRACE_PERIOD_SECONDS } from "../../payment-channels/open";
import { signVoucher } from "../../payment-channels/voucher";
import { isUptoSvmPayload } from "../../types";
import { createRpcClient, getStablecoinTokenProgram, validateSvmAddress } from "../../utils";

/** Options for the server-side {@link UptoSvmScheme}. */
export interface UptoSvmServerOptions {
  /**
   * Server hot key set as the channel `authorized_signer`; signs settlement
   * vouchers. Omit to delegate to the facilitator's advertised
   * `receiverAuthorizer`.
   */
  receiverAuthorizerSigner?: MessagePartialSigner;
  /**
   * Channel `grace_period`; defaults to
   * `max(DEFAULT_GRACE_PERIOD_SECONDS, maxTimeoutSeconds)`.
   */
  withdrawDelay?: number;
  /**
   * RPC endpoint used to fetch a recent blockhash + slot to embed in the 402
   * challenge (`extra.recentBlockhash`, `extra.recentSlot`). Both are optional
   * for clients (they can fetch their own).
   */
  rpcUrl?: string;
}

/**
 * SVM server implementation for the `upto` payment scheme.
 *
 * Declares the `escrow` payment flow: deposit settle before the handler, claim
 * (or zero-amount cancel) settle after. Price parsing matches the exact scheme
 * (stablecoin → 6-decimal atomic units); `enhancePaymentRequirements` folds the
 * facilitator's `feePayer`, declares `receiverAuthorizer` (server-owned or
 * facilitator-delegated) / `withdrawDelay`, and — when an `rpcUrl` is
 * configured — embeds a fresh `recentBlockhash`/`recentSlot` pair.
 * `enrichSettlementPayload` stamps `type` on every settle and attaches the
 * receiver-authorizer voucher on claim/cancel only when the server owns the key.
 */
export class UptoSvmScheme implements SchemeNetworkServer {
  readonly scheme = "upto";
  readonly defaultAssetTransferMethod = "channel";
  readonly paymentFlows = {
    channel: { supported: ["escrow"], default: "escrow" },
  } as const satisfies Record<string, PaymentFlowConfig>;
  /** Blockhash/slot hints regenerated per PaymentRequired; omitted from accepted-echo matching. */
  readonly dynamicExtraFields = ["recentBlockhash", "lastValidBlockHeight", "recentSlot"];
  private moneyParsers: MoneyParser[] = [];
  private readonly receiverAuthorizerSigner: MessagePartialSigner | undefined;
  private readonly withdrawDelay: number | undefined;
  private readonly rpcUrl: string | undefined;

  /**
   * Construct the server-side upto scheme.
   *
   * @param options - Server configuration; omit `receiverAuthorizerSigner` to
   *   delegate voucher signing to the facilitator
   */
  constructor(options: UptoSvmServerOptions = {}) {
    this.receiverAuthorizerSigner = options.receiverAuthorizerSigner;
    this.withdrawDelay = options.withdrawDelay;
    this.rpcUrl = options.rpcUrl;
  }

  /**
   * Settle canceled verified payments as a zero-amount refund so the facilitator
   * can `settle_and_seal` + `distribute` and return the deposit to the client.
   *
   * @param ctx - Cancellation context from the resource server
   * @returns Zero-amount requirements for prompt refund paths
   */
  settleOnCancel(ctx: VerifiedPaymentCanceledContext): PaymentRequirements | void {
    if (
      ctx.reason === "handler_failed" ||
      ctx.reason === "handler_threw" ||
      ctx.reason === "after_verify_aborted"
    ) {
      return { ...ctx.requirements, amount: "0" };
    }
  }

  /**
   * Register a custom money parser in the parser chain (tried in order).
   *
   * @param parser - Custom function to convert an amount to an AssetAmount (or null to skip)
   * @returns This instance for chaining
   */
  registerMoneyParser(parser: MoneyParser): UptoSvmScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Return the decimal precision used for `$…` settlement amount overrides.
   * Only registered SVM stablecoins are accepted; unknown assets throw so
   * callers must supply atomic units instead of relying on a USDC-shaped default.
   *
   * @param asset - Stablecoin symbol or mint address from payment requirements
   * @param network - Network identifier used to look up the default asset
   * @returns Decimal precision for the asset
   */
  getAssetDecimals(asset: string, network: Network): number {
    const byMint = findDefaultAsset(asset, network);
    if (byMint) return byMint.decimals;
    try {
      return getDefaultAsset(network, asset).decimals;
    } catch {
      throw new Error(
        `Token ${asset} is not a registered stablecoin; provide amount in atomic units`,
      );
    }
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
        `facilitator does not advertise a valid feePayer for upto on ${network}; ` +
        `a base58 Solana address is required`
      );
    }
    if (this.receiverAuthorizerSigner) return;

    const advertised = supportedKind.extra?.receiverAuthorizer;
    if (typeof advertised !== "string" || !validateSvmAddress(advertised)) {
      return (
        `no receiverAuthorizerSigner is configured and the facilitator does not advertise a ` +
        `receiverAuthorizer on ${network}. Configure a receiverAuthorizerSigner or use a ` +
        `facilitator that advertises one.`
      );
    }
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
   * Fold the facilitator's `feePayer` into the requirement, declare
   * `receiverAuthorizer` (local signer, else the facilitator's advertised key)
   * / `withdrawDelay`, and optionally embed a fresh blockhash/slot pair for
   * the client open.
   *
   * @param paymentRequirements - The base payment requirements
   * @param supportedKind - The supported kind from the facilitator's /supported endpoint
   * @param supportedKind.x402Version - The x402 version
   * @param supportedKind.scheme - The payment scheme
   * @param supportedKind.network - The network identifier
   * @param supportedKind.extra - Facilitator extra (`feePayer`, optional `receiverAuthorizer`)
   * @param extensionKeys - Extension keys supported by the facilitator (unused)
   * @returns Enhanced payment requirements
   */
  async enhancePaymentRequirements(
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
      this.withdrawDelay ??
      Math.max(DEFAULT_GRACE_PERIOD_SECONDS, paymentRequirements.maxTimeoutSeconds);
    const advertised = supportedKind.extra?.receiverAuthorizer;
    const receiverAuthorizer =
      this.receiverAuthorizerSigner?.address ??
      (typeof advertised === "string" ? advertised : undefined);
    if (!receiverAuthorizer || !validateSvmAddress(receiverAuthorizer)) {
      throw new Error("Payment requirements must include a valid extra.receiverAuthorizer");
    }

    const extra: Record<string, unknown> = {
      ...paymentRequirements.extra,
      ...supportedKind.extra,
      receiverAuthorizer,
      withdrawDelay,
    };
    extra.tokenProgram ??= getStablecoinTokenProgram(
      paymentRequirements.asset,
      supportedKind.network,
    );

    // Fetch the blockhash and the slot from the SAME response: the RPC result
    // context carries the slot the blockhash was produced at, so no separate
    // `getSlot` round-trip is needed and the two values are consistent.
    // Best-effort — clients can fetch their own when these hints are absent.
    if (this.rpcUrl) {
      try {
        const rpc = createRpcClient(supportedKind.network, this.rpcUrl);
        const { context, value } = await rpc.getLatestBlockhash().send();
        extra.recentBlockhash = value.blockhash;
        extra.lastValidBlockHeight = value.lastValidBlockHeight.toString();
        extra.recentSlot = context.slot.toString();
      } catch {
        // Leave the fields out; the client falls back to its own RPC.
      }
    }

    return { ...paymentRequirements, extra };
  }

  /**
   * Stamp `type` on every settle. Attach the receiver-authorizer voucher on
   * claim/cancel only when this server owns the key.
   *
   * @param ctx - Settlement context (`requirements.amount` is the charge or `0`)
   * @returns Additive settle fields
   */
  enrichSettlementPayload = async (ctx: SettleContext): Promise<Record<string, unknown> | void> => {
    if (ctx.phase === "before-handler") return { type: "deposit" };

    const raw = ctx.paymentPayload.payload as Record<string, unknown>;
    if (!isUptoSvmPayload(raw)) return { type: "claim" };

    if (!this.receiverAuthorizerSigner) return { type: "claim" };

    if (raw.authorizedSigner !== this.receiverAuthorizerSigner.address) {
      throw new Error(
        `payload.authorizedSigner ${raw.authorizedSigner} != configured ` +
          `receiverAuthorizer ${this.receiverAuthorizerSigner.address}`,
      );
    }

    const voucherSignature = await signVoucher(this.receiverAuthorizerSigner, {
      channelId: raw.channelId,
      cumulativeAmount: BigInt(ctx.requirements.amount),
      expiresAt: BigInt(raw.expiresAt),
    });
    return { type: "claim", voucherSignature };
  };

  /**
   * Default money conversion: decimal amount → default-asset atomic units.
   *
   * @param amount - The decimal amount
   * @param network - The network to use
   * @param symbol - Optional ticker from a suffixed price
   * @returns The parsed asset amount
   */
  private defaultMoneyConversion(amount: string, network: Network, symbol?: string): AssetAmount {
    const assetInfo = getDefaultAsset(network, symbol);
    const tokenAmount = convertToTokenAmount(amount, assetInfo.decimals);
    return {
      amount: tokenAmount,
      asset: assetInfo.asset,
      extra: {},
    };
  }
}
