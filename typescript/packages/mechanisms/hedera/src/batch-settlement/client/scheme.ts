import type {
  SchemeNetworkClient,
  SchemeClientHooks,
  PaymentRequired,
  PaymentRequirements,
  PaymentPayloadResult,
  PaymentPayloadContext,
  SettleResponse,
} from "@x402/core/types";
import { getAddress } from "viem";
import type { ClientHederaBatchSigner } from "../signer";
import { BATCH_SETTLEMENT_SCHEME, HTS_ALLOWANCE_TRANSFER_METHOD } from "../constants";
import type { BatchSettlementVoucherPayload, ChannelConfig } from "../types";
import { computeChannelId } from "../utils";
import { createBatchSettlementHederaAllowanceDepositPayload } from "./hederaAllowance";
import {
  type BatchSettlementDepositStrategy,
  type BatchSettlementDepositStrategyContext,
  type BatchSettlementDepositPolicy,
  type BatchSettlementHederaSchemeOptions,
  applyMaxDeposit,
  depositAmountForRequest,
  maxDepositFromSpendCap,
  resolveClientOptions,
  validateDepositPolicy,
} from "./config";
import { refundChannel, type RefundOptions } from "./refund";
import { type BatchSettlementClientDeps, buildChannelConfig, recoverChannel } from "./channel";
import { createBatchSettlementClientHooks } from "./hooks";
import { processCorrectivePaymentRequired } from "./recovery";
import type { ClientChannelStorage } from "./storage";
import { findDefaultAsset } from "../../defaultAssets";
import { signVoucher } from "./voucher";

export type { BatchSettlementClientContext } from "./storage";
export type {
  BatchSettlementDepositPolicy,
  BatchSettlementDepositStrategy,
  BatchSettlementDepositStrategyContext,
  BatchSettlementDepositStrategyResult,
  BatchSettlementHederaSchemeOptions,
} from "./config";
export type { RefundOptions } from "./refund";

/**
 * Client-side implementation of the `batch-settlement` scheme for Hedera networks.
 *
 * Builds payment payloads (HTS-allowance deposit + voucher, or voucher-only), updates local
 * channel state from payment-response hooks, handles corrective 402 resynchronisation via
 * {@link processCorrectivePaymentRequired}, and supports on-demand cooperative refund requests
 * via {@link refundChannel}.
 *
 * Prerequisite: the payer must have granted the network's deposit collector an HTS allowance
 * for the payment token (see `approveHtsAllowance`).
 */
export class BatchSettlementHederaScheme implements SchemeNetworkClient {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  findDefaultAsset = findDefaultAsset;

  readonly schemeHooks: SchemeClientHooks;

  private readonly storage: ClientChannelStorage;
  private readonly depositPolicy: BatchSettlementDepositPolicy | undefined;
  private readonly depositStrategy: BatchSettlementDepositStrategy | undefined;
  private readonly salt: `0x${string}`;
  private readonly payerAuthorizer: `0x${string}` | undefined;
  private readonly voucherSigner: ClientHederaBatchSigner | undefined;

  /**
   * Constructs a batched client scheme.
   *
   * @param signer - Client Hedera signer used for deposit authorizations and (by default) vouchers.
   * @param optionsOrPolicy - Either a full options object or a bare deposit-policy.
   */
  constructor(
    private readonly signer: ClientHederaBatchSigner,
    optionsOrPolicy?: BatchSettlementHederaSchemeOptions | BatchSettlementDepositPolicy,
  ) {
    const { storage, depositPolicy, depositStrategy, salt, payerAuthorizer, voucherSigner } =
      resolveClientOptions(optionsOrPolicy);
    this.storage = storage;
    this.depositPolicy = depositPolicy;
    this.depositStrategy = depositStrategy;
    this.salt = salt;
    this.payerAuthorizer = payerAuthorizer;
    this.voucherSigner = voucherSigner;

    if (
      payerAuthorizer !== undefined &&
      voucherSigner !== undefined &&
      getAddress(payerAuthorizer) !== getAddress(voucherSigner.evmAddress)
    ) {
      throw new Error("payerAuthorizer address must match voucherSigner.evmAddress");
    }

    validateDepositPolicy(depositPolicy);
    this.schemeHooks = createBatchSettlementClientHooks(this.deps());
  }

  /**
   * Creates the payment payload for a batched request.
   *
   * If the channel has no onchain deposit (or needs a top-up), builds an HTS-allowance deposit
   * payload bundled with a voucher. Otherwise, signs and returns a voucher-only payload.
   *
   * @param x402Version - Protocol version for the payload envelope.
   * @param paymentRequirements - Server payment requirements (scheme, network, asset, amount).
   * @param context - Optional extensions and the resolved atomic spend cap.
   * @returns A {@link PaymentPayloadResult} ready to be sent as the `PAYMENT-SIGNATURE` header.
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
      const minimumDepositAmount = BigInt(maxClaimableAmount) - currentBalance;
      const maxDeposit = maxDepositFromSpendCap(
        context?.maxAmountPerPayment,
        this.depositPolicy?.depositMultiplier ?? 5,
      );
      const computedDeposit = depositAmountForRequest(
        this.depositPolicy,
        requestAmount,
        minimumDepositAmount,
        paymentRequirements.extra,
        maxDeposit,
      );
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
        ...(maxDeposit !== undefined ? { maxDeposit: maxDeposit.toString() } : {}),
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
        (paymentRequirements.extra?.assetTransferMethod as string | undefined) ??
        HTS_ALLOWANCE_TRANSFER_METHOD;
      if (assetTransferMethod !== HTS_ALLOWANCE_TRANSFER_METHOD) {
        throw new Error(`unsupported batch-settlement assetTransferMethod: ${assetTransferMethod}`);
      }

      return createBatchSettlementHederaAllowanceDepositPayload(
        this.signer,
        x402Version,
        paymentRequirements,
        config,
        depositAmount,
        maxClaimableAmount,
        this.voucherSigner,
      );
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
   * Resyncs local channel state from a corrective 402 response.
   *
   * @param paymentRequired - The decoded 402 response body.
   * @returns `true` if local state was successfully resynced and a retry is warranted.
   */
  async processCorrectivePaymentRequired(paymentRequired: PaymentRequired): Promise<boolean> {
    return processCorrectivePaymentRequired(this.deps(), paymentRequired);
  }

  /**
   * Builds the immutable {@link ChannelConfig} for a given set of payment requirements.
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
    return applyMaxDeposit(
      BigInt(depositAmount),
      BigInt(context.minimumDepositAmount),
      context.maxDeposit === undefined ? undefined : BigInt(context.maxDeposit),
    );
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

    return { x402Version, payload };
  }

  /**
   * Bundles the class state into the {@link BatchSettlementClientDeps} shape.
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
