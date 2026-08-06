import {
  SchemeNetworkClient,
  SchemeClientHooks,
  PaymentRequired,
  PaymentRequirements,
  PaymentPayloadResult,
  PaymentPayloadContext,
  SettleResponse,
} from "@x402/core/types";
import { getAddress } from "viem";
import { ClientEvmSigner } from "../../signer";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import {
  BatchSettlementAssetTransferMethod,
  BatchSettlementVoucherPayload,
  ChannelConfig,
} from "../types";
import { computeChannelId } from "../utils";
import {
  trySignEip2612PermitExtension,
  trySignErc20ApprovalExtension,
} from "../../shared/extensions";
import type { EvmSchemeOptions } from "../../shared/rpc";
import { createBatchSettlementEIP3009DepositPayload } from "./eip3009";
import { createBatchSettlementPermit2DepositPayload } from "./permit2";
import {
  type BatchSettlementDepositStrategy,
  type BatchSettlementDepositStrategyContext,
  type BatchSettlementDepositPolicy,
  type BatchSettlementEvmSchemeOptions,
  depositAmountForRequest,
  resolveClientOptions,
  validateDepositPolicy,
} from "./config";
import { refundChannel, type RefundOptions } from "./refund";
import {
  type BatchSettlementClientDeps,
  buildChannelConfig,
  processSettleResponse,
  recoverChannel,
} from "./channel";
import { createBatchSettlementClientHooks } from "./hooks";
import { processCorrectivePaymentRequired } from "./recovery";
import type { ClientChannelStorage } from "./storage";
import { signVoucher } from "./voucher";

export type { BatchSettlementClientContext } from "./storage";
export type {
  BatchSettlementDepositPolicy,
  BatchSettlementDepositStrategy,
  BatchSettlementDepositStrategyContext,
  BatchSettlementDepositStrategyResult,
  BatchSettlementEvmSchemeOptions,
} from "./config";
export type { RefundOptions } from "./refund";

/**
 * Client-side implementation of the `batch-settlement` scheme for EVM networks.
 *
 * Builds payment payloads (deposit + voucher or voucher-only), processes server
 * responses to update local session state via {@link processSettleResponse},
 * handles corrective 402 resynchronisation via
 * {@link processCorrectivePaymentRequired}, and supports on-demand cooperative
 * refund requests via {@link refundChannel}.
 */
export class BatchSettlementEvmScheme implements SchemeNetworkClient {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;

  readonly schemeHooks: SchemeClientHooks;

  private readonly storage: ClientChannelStorage;
  private readonly depositPolicy: BatchSettlementDepositPolicy | undefined;
  private readonly depositStrategy: BatchSettlementDepositStrategy | undefined;
  private readonly salt: `0x${string}`;
  private readonly payerAuthorizer: `0x${string}` | undefined;
  private readonly voucherSigner: ClientEvmSigner | undefined;
  private readonly extensionRpcOptions: EvmSchemeOptions | undefined;

  /**
   * Constructs a batched client scheme.
   *
   * @param signer - Client EVM wallet used for signing vouchers and ERC-3009 authorizations.
   * @param optionsOrPolicy - Either a full options object or a bare deposit-policy.
   */
  constructor(
    private readonly signer: ClientEvmSigner,
    optionsOrPolicy?: BatchSettlementEvmSchemeOptions | BatchSettlementDepositPolicy,
  ) {
    const {
      storage,
      depositPolicy,
      depositStrategy,
      salt,
      payerAuthorizer,
      voucherSigner,
      extensionRpcOptions,
    } = resolveClientOptions(optionsOrPolicy);
    this.storage = storage;
    this.depositPolicy = depositPolicy;
    this.depositStrategy = depositStrategy;
    this.salt = salt;
    this.payerAuthorizer = payerAuthorizer;
    this.voucherSigner = voucherSigner;
    this.extensionRpcOptions = extensionRpcOptions;

    if (
      payerAuthorizer !== undefined &&
      voucherSigner !== undefined &&
      getAddress(payerAuthorizer) !== getAddress(voucherSigner.address)
    ) {
      throw new Error("payerAuthorizer address must match voucherSigner.address");
    }

    validateDepositPolicy(depositPolicy);
    this.schemeHooks = createBatchSettlementClientHooks(this.deps());
  }

  /**
   * Creates the payment payload for a batched request.
   *
   * If the channel has no onchain deposit (or needs a top-up), builds an
   * ERC-3009 deposit payload bundled with a voucher. Otherwise, signs and
   * returns a voucher-only payload.
   *
   * @param x402Version - Protocol version for the payload envelope.
   * @param paymentRequirements - Server payment requirements (scheme, network, asset, amount).
   * @param context - Optional payment payload context with extension hints.
   * @returns A {@link PaymentPayloadResult} ready to be sent as the `X-PAYMENT` header.
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const deps = this.deps();
    const config = buildChannelConfig(deps, paymentRequirements);
    const channelId = computeChannelId(config, paymentRequirements.network);
    const key = channelId.toLowerCase();

    let batchedCtx = await this.storage.get(key);
    if (batchedCtx === undefined && this.signer.readContract) {
      batchedCtx = await recoverChannel(deps, paymentRequirements);
    }
    batchedCtx = batchedCtx ?? {};

    const needsInitialDeposit = !batchedCtx.balance || batchedCtx.balance === "0";

    const baseCumulative = BigInt(batchedCtx.chargedCumulativeAmount ?? "0");
    const requestAmount = BigInt(paymentRequirements.amount);
    const maxClaimableAmount = (baseCumulative + requestAmount).toString();

    const currentBalance = BigInt(batchedCtx.balance ?? "0");
    const needsTopUp = !needsInitialDeposit && BigInt(maxClaimableAmount) > currentBalance;

    if (needsInitialDeposit || needsTopUp) {
      const computedDeposit = depositAmountForRequest(this.depositPolicy, requestAmount);
      const minimumDepositAmount = BigInt(maxClaimableAmount) - currentBalance;
      const depositAmount = await this.resolveDepositAmount({
        paymentRequirements,
        channelConfig: config,
        channelId,
        clientContext: batchedCtx,
        requestAmount: requestAmount.toString(),
        maxClaimableAmount,
        currentBalance: currentBalance.toString(),
        minimumDepositAmount: minimumDepositAmount.toString(),
        depositAmount: computedDeposit,
      });
      if (depositAmount === false) {
        return this.createVoucherPayload(
          x402Version,
          channelId,
          maxClaimableAmount,
          paymentRequirements.network,
          config,
        );
      }

      const assetTransferMethod =
        (paymentRequirements.extra?.assetTransferMethod as BatchSettlementAssetTransferMethod) ??
        "eip3009";

      if (assetTransferMethod === "eip3009") {
        return createBatchSettlementEIP3009DepositPayload(
          this.signer,
          x402Version,
          paymentRequirements,
          config,
          depositAmount,
          maxClaimableAmount,
          this.voucherSigner,
        );
      }

      if (assetTransferMethod !== "permit2") {
        throw new Error(`unsupported batch-settlement assetTransferMethod: ${assetTransferMethod}`);
      }

      const result = await createBatchSettlementPermit2DepositPayload(
        this.signer,
        x402Version,
        paymentRequirements,
        config,
        depositAmount,
        maxClaimableAmount,
        this.voucherSigner,
      );

      const eip2612Extensions = await trySignEip2612PermitExtension(
        this.signer,
        this.extensionRpcOptions,
        paymentRequirements,
        result,
        context,
        depositAmount,
      );
      if (eip2612Extensions) {
        return { ...result, extensions: eip2612Extensions };
      }

      const erc20Extensions = await trySignErc20ApprovalExtension(
        this.signer,
        this.extensionRpcOptions,
        paymentRequirements,
        context,
        depositAmount,
      );
      if (erc20Extensions) {
        return { ...result, extensions: erc20Extensions };
      }

      return result;
    }

    return this.createVoucherPayload(
      x402Version,
      channelId,
      maxClaimableAmount,
      paymentRequirements.network,
      config,
    );
  }

  /**
   * Sends a cooperative refund request.
   *
   * @param url - The route URL backing the channel to refund.
   * @param options - Optional `amount` (partial refund) and `fetch` override.
   * @returns The settle response describing the refund outcome.
   */
  async refund(url: string, options?: RefundOptions): Promise<SettleResponse> {
    return refundChannel(this.deps(), url, options);
  }

  /**
   * Updates local channel state from a settle response.
   *
   * @param settle - The parsed settle response from the server.
   * @returns Resolves when local channel state has been updated.
   */
  async processSettleResponse(settle: SettleResponse): Promise<void> {
    return processSettleResponse(this.storage, settle);
  }

  /**
   * Resyncs local channel state from a corrective 402 response.
   *
   * @param paymentRequired - The decoded 402 response body.
   * @returns `true` if local state was successfully resynced and a retry is warranted.
   */
  async processCorrectivePaymentRequired(paymentRequired: PaymentRequired): Promise<boolean> {
    return processCorrectivePaymentRequired(this.deps(), paymentRequired);
  }

  /**
   * Builds the immutable {@link ChannelConfig} for a given set of payment
   * requirements, using the scheme's own signer and salt.
   *
   * @param paymentRequirements - Server payment requirements for the channel.
   * @returns The channel config that uniquely identifies the payment channel.
   */
  buildChannelConfig(paymentRequirements: PaymentRequirements): ChannelConfig {
    return buildChannelConfig(this.deps(), paymentRequirements);
  }

  /**
   * Resolves the deposit amount after applying the optional custom strategy.
   *
   * @param context - Deposit attempt context exposed to the strategy.
   * @returns The deposit amount to sign, or `false` to skip this deposit attempt.
   */
  private async resolveDepositAmount(
    context: BatchSettlementDepositStrategyContext,
  ): Promise<string | false> {
    const strategyResult = await this.depositStrategy?.(context);
    if (strategyResult === false) return false;
    if (strategyResult === undefined) return context.depositAmount;

    const depositAmount = this.normalizeStrategyDepositAmount(strategyResult);
    if (BigInt(depositAmount) < BigInt(context.minimumDepositAmount)) {
      throw new Error(
        `depositStrategy returned ${depositAmount}, below required top-up ${context.minimumDepositAmount}`,
      );
    }
    return depositAmount;
  }

  /**
   * Normalizes and validates a strategy-provided base-unit deposit amount.
   *
   * @param value - Strategy-provided string or bigint amount.
   * @returns Normalized decimal string.
   */
  private normalizeStrategyDepositAmount(value: string | bigint): string {
    if (typeof value === "bigint") {
      if (value <= 0n) {
        throw new Error("depositStrategy must return a positive integer deposit amount");
      }
      return value.toString();
    }

    if (/^\d+$/.test(value) && BigInt(value) > 0n) {
      return BigInt(value).toString();
    }

    throw new Error("depositStrategy must return a positive integer deposit amount");
  }

  /**
   * Signs a voucher-only payment payload for the current channel.
   *
   * @param x402Version - Protocol version for the payload envelope.
   * @param channelId - Channel identifier for the voucher.
   * @param maxClaimableAmount - Cumulative ceiling for the voucher.
   * @param network - CAIP-2 network identifier.
   * @param config - Immutable channel configuration.
   * @returns Voucher-only payment payload.
   */
  private async createVoucherPayload(
    x402Version: number,
    channelId: `0x${string}`,
    maxClaimableAmount: string,
    network: string,
    config: ChannelConfig,
  ): Promise<PaymentPayloadResult> {
    const voucherSigner = this.voucherSigner ?? this.signer;
    const voucher = await signVoucher(voucherSigner, channelId, maxClaimableAmount, network);

    const payload: BatchSettlementVoucherPayload = {
      type: "voucher",
      channelConfig: config,
      voucher,
    };

    return {
      x402Version,
      payload,
    };
  }

  /**
   * Bundles the class state into the {@link BatchSettlementClientDeps} shape
   * consumed by the `channel`, `recovery`, and `refund` modules.
   *
   * @returns Client deps wrapping the scheme's own signer and storage.
   */
  private deps(): BatchSettlementClientDeps {
    return {
      signer: this.signer,
      storage: this.storage,
      salt: this.salt,
      payerAuthorizer: this.payerAuthorizer,
      voucherSigner: this.voucherSigner,
    };
  }
}
