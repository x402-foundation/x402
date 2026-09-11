/* eslint-disable jsdoc/require-jsdoc */
import { address, type Signature } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "../../constants";
import { verifyRequestCloseTransaction } from "../../payment-channels/close";
import {
  discoverChannelsByRentPayer,
  type DiscoveredChannel,
} from "../../payment-channels/discovery";
import { getChannelDecoder, type Channel } from "../../payment-channels/generated/accounts/channel";
import { AccountDiscriminator } from "../../payment-channels/generated/types/accountDiscriminator";
import {
  buildDistributeInstruction,
  buildSettleInstructions,
  ChannelStatus,
  getPaymentChannelsTreasuryOwner,
  type ServerInstruction,
} from "../../payment-channels/onchain";
import {
  findPaymentChannelPda,
  parseU64,
  verifyOpenTransaction,
  verifyTopUpTransaction,
} from "../../payment-channels/open";
import { encodeVoucherMessageBytes, verifyVoucherSignature } from "../../payment-channels/voucher";
import { SettlementCache } from "../../settlement-cache";
import type { FacilitatorSigningCapabilities, FacilitatorSvmSigner } from "../../signer";
import {
  broadcastOpen,
  getChannelDistributionHash,
  simulateOpenSettleDistribute,
  submitChannelTransactionWithSigner,
  ChannelSimulationError,
  ChannelBroadcastConfirmationError,
  SettlementConfirmationTimeoutError,
} from "../../payment-channels/facilitator";
import { PaymentChannelRentCleanupManager } from "../../payment-channels/rentCleanup";
import {
  InMemoryPaymentChannelStorage,
  type PaymentChannelRecord,
  type PaymentChannelStorage,
} from "../../payment-channels/storage";
import { createRpcClient } from "../../utils";
import {
  InMemoryPendingSettlementStore,
  type PendingSettlementStore,
} from "@x402/core/facilitator";

import { recordPendingOrTerminal, TransactionOnchainFailureError } from "../../utils";
import { ErrSettlementPending } from "../../exact/facilitator/errors";
import { BatchError } from "../errors";
import {
  BATCH_SETTLEMENT_SCHEME,
  type BatchChannelConfig,
  type BatchChannelState,
  type BatchDepositPayload,
  type BatchClaimPayload,
  type BatchPayload,
  type BatchRefundPayload,
  type BatchSettlePayload,
  isBatchFacilitatorPayload,
  isBatchPayload,
} from "../types";
const MIN_WITHDRAW_DELAY = 900;
const MAX_WITHDRAW_DELAY = 2_592_000;
const CHANNEL_READ_ATTEMPTS = 5;
const CHANNEL_READ_INITIAL_BACKOFF_MS = 200;
const CHANNEL_BUSY = "duplicate_settlement";

/** Four Ed25519+settle pairs fit under Solana's transaction packet limit. */
export const MAX_CHANNELS_PER_SETTLE_TX = 4;

export interface BatchSvmFacilitatorConfig {
  rpcUrl?: string | undefined;
  /**
   * Durable record of transactions this facilitator broadcast but could not
   * confirm, so a retry — or a restart — reconciles against the signature
   * instead of broadcasting the same escrow or redemption again. Defaults to
   * an in-memory store, which does not survive a restart; production
   * deployments should supply a durable one.
   */
  pendingSettlementStore?: PendingSettlementStore | undefined;
  /** Shared, facilitator-owned lifecycle index used for rent cleanup. */
  channelStorage?: PaymentChannelStorage | undefined;
  maxPriorityFeeMicroLamports?: number | undefined;
  maxComputeUnits?: number | undefined;
  maxRequiredSignatures?: number | undefined;
}

type BatchTerms = {
  feePayer: string;
  feePayerSigner: FacilitatorSigningCapabilities;
  receiverAuthorizer?: string | undefined;
  tokenProgram: string;
  withdrawDelay: number;
  memo?: string | undefined;
  voucherSigner: "client" | "server";
};

type ValidatedDeposit = {
  payload: BatchDepositPayload;
  terms: BatchTerms;
  channelId: string;
  deposit: bigint;
  expectedDeposit: bigint;
  isTopUp: boolean;
  voucherAmount: bigint;
};

type ValidatedRefund = {
  channel: Channel;
  channelId: string;
  terms: BatchTerms;
};

export class BatchSvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly caipFamily = "solana:*";
  private readonly channelStorage: PaymentChannelStorage;
  private readonly settlementCache = new SettlementCache();
  private readonly pendingStore: PendingSettlementStore;

  constructor(
    private readonly signer: FacilitatorSvmSigner,
    private readonly config: BatchSvmFacilitatorConfig = {},
  ) {
    if (typeof signer.getSigner !== "function") {
      throw new Error("BatchSvmScheme requires getSigner on the facilitator signer");
    }
    if (signer.getAddresses().length === 0) {
      throw new Error("BatchSvmScheme requires at least one fee payer signer");
    }
    this.channelStorage = config.channelStorage ?? new InMemoryPaymentChannelStorage();
    this.pendingStore = config.pendingSettlementStore ?? new InMemoryPendingSettlementStore();
  }

  getExtra(_: Network): Record<string, unknown> {
    const addresses = this.signer.getAddresses();
    return {
      feePayer: addresses[Math.floor(Math.random() * addresses.length)],
    };
  }

  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  getChannelStorage(): PaymentChannelStorage {
    return this.channelStorage;
  }

  createRentCleanupManager(network: Network): PaymentChannelRentCleanupManager {
    return new PaymentChannelRentCleanupManager({
      network,
      rpcUrl: this.config.rpcUrl,
      signer: this.signer,
      storage: this.channelStorage,
    });
  }

  /**
   * Rebuild the facilitator's onchain lifecycle view after local index loss.
   *
   * @param network - Network to scan
   * @returns Canonical channels sponsored by any configured fee payer
   */
  async discoverChannels(network: Network): Promise<DiscoveredChannel[]> {
    const channels = await Promise.all(
      this.signer
        .getAddresses()
        .map(rentPayer => discoverChannelsByRentPayer(this.signer, network, rentPayer)),
    );
    return [...new Map(channels.flat().map(item => [item.channelId, item])).values()];
  }

  async verify(
    payment: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const payload = payment.payload;
    if (!isBatchPayload(payload)) return this.verifyFailure(BatchError.PAYLOAD_TYPE, "");
    if (
      payment.accepted.scheme !== BATCH_SETTLEMENT_SCHEME ||
      requirements.scheme !== BATCH_SETTLEMENT_SCHEME
    ) {
      return this.verifyFailure("unsupported_scheme", payload.channelConfig.payer);
    }
    if (payment.accepted.network !== requirements.network) {
      return this.verifyFailure("network_mismatch", payload.channelConfig.payer);
    }

    try {
      switch (payload.type) {
        case "deposit": {
          const validated = await this.validateDeposit(payload, requirements);
          return {
            isValid: true,
            payer: payload.channelConfig.payer,
            extra: { channelId: validated.channelId },
          };
        }
        case "voucher": {
          const terms = await this.resolveTerms(payload.channelConfig, requirements);
          const channelId = await this.deriveChannelId(payload.channelConfig, terms.feePayer);
          if (payload.voucher.channelId !== channelId) {
            return this.verifyFailure(BatchError.CHANNEL_ID_MISMATCH, payload.channelConfig.payer);
          }
          const channel = await this.validateVoucherOnly(payload, requirements, terms, channelId);
          return {
            isValid: true,
            payer: payload.channelConfig.payer,
            extra: { channelState: snapshotChannel(channelId, channel) },
          };
        }
        case "authorization": {
          const terms = await this.resolveTerms(payload.channelConfig, requirements);
          const channelId = await this.deriveChannelId(payload.channelConfig, terms.feePayer);
          const channel = await this.fetchChannel(requirements.network, channelId);
          this.assertClaimChannel(channel, payload.channelConfig, terms, requirements, [
            ChannelStatus.Open,
          ]);
          const ceiling = parseU64(requirements.amount, "amount");
          if (ceiling > channel.deposit) {
            throw new Error(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT);
          }
          return {
            isValid: true,
            payer: payload.channelConfig.payer,
            extra: { channelState: snapshotChannel(channelId, channel) },
          };
        }
        case "refund": {
          const validated = await this.validateRefund(payload, requirements);
          return {
            isValid: true,
            payer: validated.channel.payer,
            extra: { channelState: snapshotChannel(validated.channelId, validated.channel) },
          };
        }
      }
    } catch (error) {
      return this.verifyFailure(
        classifyError(error),
        payload.channelConfig.payer,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async settle(
    payment: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const payload = payment.payload;
    if (!isBatchFacilitatorPayload(payload)) {
      return this.settleFailure(payment, BatchError.PAYLOAD_TYPE, "");
    }
    try {
      switch (payload.type) {
        case "deposit":
          return await this.settleDeposit(payment, payload, requirements);
        case "voucher":
          return await this.settleVoucher(payment, payload, requirements);
        case "authorization":
          return await this.settleVoucher(payment, payload, requirements);
        case "refund":
          return await this.settleRefund(payment, payload, requirements);
        case "claim":
          return await this.settleClaims(payment, payload, requirements);
        case "settle":
          return await this.settleDistributions(payment, payload, requirements);
      }
    } catch (error) {
      return this.settleFailure(
        payment,
        classifyError(error),
        "channelConfig" in payload ? payload.channelConfig.payer : "",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async settleClaims(
    payment: PaymentPayload,
    payload: BatchClaimPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    void payment;
    const prepared: {
      channel: Channel;
      channelId: string;
      feePayer: string;
      instructions: ServerInstruction[];
      cumulative: bigint;
      expiresAt: number;
      payTo: string;
      tokenProgram: string;
    }[] = [];
    for (const claim of payload.claims) {
      const terms = await this.resolveTerms(claim.voucher.channelConfig, requirements);
      const channelId = await this.deriveChannelId(claim.voucher.channelConfig, terms.feePayer);
      if (channelId !== claim.voucher.channelId) throw new Error(BatchError.CHANNEL_ID_MISMATCH);
      const cumulative = parseU64(claim.voucher.maxClaimableAmount, "maxClaimableAmount");
      this.assertExpiry(claim.voucher.expiresAt);
      const channel = await this.fetchChannel(requirements.network, channelId);
      this.assertClaimChannel(channel, claim.voucher.channelConfig, terms, requirements, [
        ChannelStatus.Open,
      ]);
      if (cumulative <= channel.settlement.settled || cumulative > channel.deposit) {
        throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
      }
      const voucher = {
        authorizedSigner: claim.voucher.channelConfig.payerAuthorizer,
        cumulativeAmount: cumulative,
        expiresAt: BigInt(claim.voucher.expiresAt),
        signatureBase58: claim.signature,
      };
      const valid = await verifyVoucherSignature({
        message: encodeVoucherMessageBytes({
          channelId,
          cumulativeAmount: cumulative,
          expiresAt: voucher.expiresAt,
        }),
        signatureBase58: claim.signature,
        signerBase58: voucher.authorizedSigner,
      });
      if (!valid) throw new Error(BatchError.VOUCHER_SIGNATURE);
      prepared.push({
        channel,
        channelId,
        cumulative,
        expiresAt: claim.voucher.expiresAt,
        feePayer: terms.feePayer,
        instructions: buildSettleInstructions({ channelId, voucher }),
        payTo: requirements.payTo,
        tokenProgram: terms.tokenProgram,
      });
    }
    const feePayer = prepared[0]?.feePayer;
    if (!feePayer || prepared.some(item => item.feePayer !== feePayer)) {
      throw new Error(BatchError.FEE_PAYER_MISMATCH);
    }
    await Promise.all(
      prepared.map(item =>
        this.trackChannel({
          channelId: item.channelId,
          expiresAt: item.expiresAt,
          network: requirements.network,
          payTo: item.payTo,
          tokenProgram: item.tokenProgram,
        }),
      ),
    );
    // Keyed by exactly what this batch advances, so a retry of the same claim
    // reconciles while a different one proceeds.
    const claimKey = `batch:claim:${requirements.network}:${prepared
      .map(item => `${item.channelId}:${item.cumulative}`)
      .sort()
      .join(",")}`;
    const submitted = await this.submitRedemption(
      feePayer,
      requirements.network,
      prepared.flatMap(item => item.instructions),
      claimKey,
      prepared[0]?.channel.payer ?? "",
    );
    if (!submitted.ok) return submitted.response;
    const signature = submitted.signature;
    const accepts = [];
    for (const item of prepared) {
      const confirmed = await this.fetchChannel(requirements.network, item.channelId);
      if (confirmed.settlement.settled !== item.cumulative) {
        throw new Error(BatchError.CHANNEL_STATE);
      }
      accepts.push({ channelId: item.channelId, totalClaimed: item.cumulative.toString() });
    }
    return {
      amount: "",
      extra: { accepts },
      network: requirements.network,
      payer: "",
      success: true,
      transaction: signature,
    };
  }

  async settleDistributions(
    payment: PaymentPayload,
    payload: BatchSettlePayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    void payment;
    if (payload.channels.length > MAX_CHANNELS_PER_SETTLE_TX) {
      throw new Error(`${BatchError.PAYLOAD_TYPE}: too many channels`);
    }
    const prepared: {
      channelId: string;
      feePayer: string;
      instruction: ServerInstruction;
      payoutBefore: bigint;
      settled: bigint;
    }[] = [];
    for (const entry of payload.channels) {
      const terms = await this.resolveTerms(entry.channelConfig, requirements);
      const channelId = await this.deriveChannelId(entry.channelConfig, terms.feePayer);
      if (channelId !== entry.channelId) throw new Error(BatchError.CHANNEL_ID_MISMATCH);
      const channel = await this.fetchChannel(requirements.network, channelId);
      this.assertClaimChannel(channel, entry.channelConfig, terms, requirements, [
        ChannelStatus.Open,
        ChannelStatus.Sealed,
      ]);
      prepared.push({
        channelId,
        feePayer: terms.feePayer,
        instruction: await this.distributeInstruction(channelId, channel, terms, requirements),
        payoutBefore: channel.settlement.payoutWatermark,
        settled: channel.settlement.settled,
      });
    }
    const feePayer = prepared[0]?.feePayer;
    if (!feePayer || prepared.some(item => item.feePayer !== feePayer)) {
      throw new Error(BatchError.FEE_PAYER_MISMATCH);
    }
    const distributeKey = `batch:distribute:${requirements.network}:${prepared
      .map(item => `${item.channelId}:${item.settled}`)
      .sort()
      .join(",")}`;
    const submitted = await this.submitRedemption(
      feePayer,
      requirements.network,
      prepared.map(item => item.instruction),
      distributeKey,
      // A distribution names no payer: it pays the receiver from settled funds.
      "",
    );
    if (!submitted.ok) return submitted.response;
    const signature = submitted.signature;
    for (const item of prepared) {
      const confirmed = await this.fetchChannel(requirements.network, item.channelId);
      if (confirmed.settlement.payoutWatermark !== item.settled) {
        throw new Error(`${BatchError.CHANNEL_STATE}: distribution watermark did not advance`);
      }
    }
    const amount = calculateDistributionAmount(
      prepared.map(item => ({
        payoutWatermark: item.payoutBefore,
        settled: item.settled,
      })),
    );
    return {
      amount: amount.toString(),
      extra: { channels: prepared.map(item => item.channelId) },
      network: requirements.network,
      payer: "",
      success: true,
      transaction: signature,
    };
  }

  private async validateDeposit(
    payload: BatchDepositPayload,
    requirements: PaymentRequirements,
  ): Promise<ValidatedDeposit> {
    const terms = await this.resolveTerms(payload.channelConfig, requirements);
    const deposit = parseU64(payload.deposit.amount, "deposit.amount");
    const charge = parseU64(requirements.amount, "amount");
    const channelId = await this.deriveChannelId(payload.channelConfig, terms.feePayer);
    const voucherAmount = payload.voucher
      ? parseU64(payload.voucher.maxClaimableAmount, "maxClaimableAmount")
      : terms.voucherSigner === "server"
        ? charge
        : undefined;
    if (terms.voucherSigner === "client" && !payload.voucher) {
      throw new Error(`${BatchError.VOUCHER_SIGNATURE}: client voucher missing`);
    }
    if (terms.voucherSigner === "server" && voucherAmount === undefined) {
      throw new Error(`${BatchError.CUMULATIVE_AMOUNT_MISMATCH}: amount missing`);
    }
    if (payload.voucher) {
      if (payload.voucher.channelId !== channelId) {
        throw new Error(`${BatchError.CHANNEL_ID_MISMATCH}: voucher channel mismatch`);
      }
      const voucherValid = await verifyVoucherSignature({
        message: encodeVoucherMessageBytes({
          channelId,
          cumulativeAmount: voucherAmount!,
          expiresAt: BigInt(payload.voucher.expiresAt),
        }),
        signatureBase58: payload.voucher.signature,
        signerBase58: payload.channelConfig.payerAuthorizer,
      });
      if (!voucherValid) throw new Error(`${BatchError.VOUCHER_SIGNATURE}: invalid voucher`);
      this.assertExpiry(payload.voucher.expiresAt);
    }
    const existing = await this.readChannel(requirements.network, channelId);
    if (existing) {
      this.assertClaimChannel(existing, payload.channelConfig, terms, requirements, [
        ChannelStatus.Open,
      ]);
      const expectedDeposit = existing.deposit + deposit;
      if (
        voucherAmount !== undefined &&
        (voucherAmount < charge || voucherAmount > expectedDeposit)
      ) {
        throw new Error(
          `${BatchError.CUMULATIVE_AMOUNT_MISMATCH}: voucher exceeds topped-up ceiling`,
        );
      }
      await verifyTopUpTransaction(payload.deposit.transaction, {
        amount: deposit,
        channelId,
        feePayer: terms.feePayer,
        from: payload.channelConfig.payer,
        maxComputeUnits: this.config.maxComputeUnits,
        maxPriorityFeeMicroLamports: this.config.maxPriorityFeeMicroLamports,
        memo: terms.memo,
        mint: requirements.asset,
        tokenProgram: terms.tokenProgram,
      });
      await this.assertSettlementAccounts(
        requirements,
        payload.channelConfig.payer,
        terms.tokenProgram,
      );
      return {
        channelId,
        deposit,
        expectedDeposit,
        isTopUp: true,
        payload,
        terms,
        voucherAmount: voucherAmount!,
      };
    }
    if ((voucherAmount !== undefined && voucherAmount !== charge) || charge > deposit) {
      throw new Error(`${BatchError.CUMULATIVE_AMOUNT_MISMATCH}: invalid first voucher amount`);
    }
    const open = await verifyOpenTransaction(payload.deposit.transaction, {
      authorizedSigner: payload.channelConfig.payerAuthorizer,
      feePayer: terms.feePayer,
      from: payload.channelConfig.payer,
      maxCap: deposit,
      maxComputeUnits: this.config.maxComputeUnits,
      maxPriorityFeeMicroLamports: this.config.maxPriorityFeeMicroLamports,
      maxRequiredSignatures: this.config.maxRequiredSignatures,
      memo: terms.memo,
      mint: requirements.asset,
      openSlot: BigInt(payload.channelConfig.openSlot),
      payee: terms.feePayer,
      recentSlot: parseOptionalSlot(requirements.extra?.recentSlot),
      recipients: [{ bps: 10_000, recipient: requirements.payTo }],
      tokenProgram: terms.tokenProgram,
      withdrawDelay: terms.withdrawDelay,
    });
    if (open.channelId !== channelId) {
      throw new Error(`${BatchError.CHANNEL_ID_MISMATCH}: setup transaction channel mismatch`);
    }
    await this.assertSettlementAccounts(
      requirements,
      payload.channelConfig.payer,
      terms.tokenProgram,
    );
    return {
      channelId,
      deposit,
      expectedDeposit: deposit,
      isTopUp: false,
      payload,
      terms,
      voucherAmount: voucherAmount!,
    };
  }

  private async settleDeposit(
    payment: PaymentPayload,
    payload: BatchDepositPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const validated = await this.validateDeposit(payload, requirements);
    const { channelId, terms } = validated;
    // Serialize opens by channel so two distinct signed setup transactions
    // cannot race for the same PDA. Top-ups remain transaction-scoped because
    // a channel can legitimately receive several of them within the cache TTL.
    const key = validated.isTopUp
      ? `batch:topup:${requirements.network}:${payload.deposit.transaction}`
      : `batch:deposit:${requirements.network}:${channelId}`;
    if ((await this.readChannel(requirements.network, channelId)) && !validated.isTopUp) {
      const existing = await this.fetchChannel(requirements.network, channelId);
      this.assertDepositChannel(existing, validated, requirements);
      return depositResponse(channelId, existing, requirements.network, "");
    }
    if (this.settlementCache.isDuplicate(key)) {
      return this.settleFailure(payment, "duplicate_settlement", payload.channelConfig.payer);
    }
    try {
      if (validated.isTopUp) {
        // Simulated unsigned: `sigVerify` is off, so the fee payer's signature
        // adds nothing here, and not asking for it keeps simulation portable
        // across signer backends that will not sign the same bytes twice.
        await this.signer.simulateTransaction(payload.deposit.transaction, requirements.network);
      } else {
        // The only read still on its own client: this shared helper simulates
        // the open/settle/distribute chain through an rpc of its own, and is
        // used by `upto` too.
        await simulateOpenSettleDistribute(
          terms.feePayerSigner,
          createRpcClient(requirements.network, this.config.rpcUrl),
          {
            channel: {
              channelId,
              mint: requirements.asset,
              network: requirements.network,
              payee: terms.feePayer,
              payer: payload.channelConfig.payer,
              rentPayer: terms.feePayer,
              splits: [{ bps: 10_000, recipient: requirements.payTo }],
              tokenProgram: terms.tokenProgram,
            },
            openTransactionBase64: payload.deposit.transaction,
          },
        );
      }
    } catch (error) {
      this.settlementCache.delete(key);
      if (
        error instanceof Error &&
        error.message.startsWith(`${BatchError.SETTLEMENT_SIMULATION}:`)
      ) {
        throw error;
      }
      throw new Error(`${BatchError.SETTLEMENT_SIMULATION}: ${String(error)}`);
    }
    try {
      await this.trackChannel({
        channelId,
        expiresAt: payload.voucher?.expiresAt ?? 0,
        network: requirements.network,
        payTo: requirements.payTo,
        tokenProgram: terms.tokenProgram,
      });
    } catch (error) {
      // No transaction has been broadcast. Release the channel lock so a
      // caller can safely retry once durable indexing is healthy again.
      this.settlementCache.delete(key);
      throw error;
    }
    const broadcast = await this.broadcastDurably(
      key,
      requirements.network,
      payload.channelConfig.payer,
      async onBroadcast => {
        try {
          return await broadcastOpen(
            this.signer,
            address(terms.feePayer),
            requirements.network,
            payload.deposit.transaction,
            onBroadcast,
          );
        } catch (error) {
          // Only a transaction that never reached the network frees the
          // duplicate lock; one already broadcast is reconciled, not resent.
          if (pendingSignatureOf(error) === undefined) this.settlementCache.delete(key);
          throw error;
        }
      },
    );
    if (!broadcast.ok) return broadcast.response;
    const signature = broadcast.signature;
    const channel = await this.fetchChannel(requirements.network, channelId);
    this.assertDepositChannel(channel, validated, requirements);
    return depositResponse(channelId, channel, requirements.network, signature);
  }

  private async assertSettlementAccounts(
    requirements: PaymentRequirements,
    payer: string,
    tokenProgram: string,
  ): Promise<void> {
    if (typeof this.signer.getAccountInfo !== "function") {
      throw new Error(
        "BatchSvmScheme requires getAccountInfo on the facilitator signer. " +
          "Use toFacilitatorSvmSigner() which provides all required methods.",
      );
    }
    const mint = address(requirements.asset);
    const tokenProgramAddress = address(tokenProgram);
    const required = [
      { label: "payer", owner: address(payer) },
      { label: "recipient", owner: address(requirements.payTo) },
      {
        label: "payment-channel treasury",
        owner: getPaymentChannelsTreasuryOwner(requirements.network),
      },
    ] as const;
    for (const { label, owner } of required) {
      const [ata] = await findAssociatedTokenPda({
        mint,
        owner,
        tokenProgram: tokenProgramAddress,
      });
      const account = await this.signer.getAccountInfo(ata, requirements.network, {
        commitment: "confirmed",
        encoding: "base64",
      });
      if (!account) {
        throw new Error(`${BatchError.SETTLEMENT_SIMULATION}: missing ${label} ATA: ${ata}`);
      }
      if (account.owner.toString() !== tokenProgram) {
        throw new Error(
          `${BatchError.SETTLEMENT_SIMULATION}: ${label} ATA is not owned by ${tokenProgram}: ${ata}`,
        );
      }
    }
  }

  private async settleVoucher(
    payment: PaymentPayload,
    payload: Extract<BatchPayload, { type: "authorization" | "voucher" }>,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    void requirements;
    return this.settleFailure(payment, BatchError.PAYLOAD_TYPE, payload.channelConfig.payer);
  }

  private async validateVoucherOnly(
    payload: Extract<BatchPayload, { type: "voucher" }>,
    requirements: PaymentRequirements,
    terms: BatchTerms,
    channelId: string,
  ): Promise<Channel> {
    const cumulative = parseU64(payload.voucher.maxClaimableAmount, "maxClaimableAmount");
    this.assertExpiry(payload.voucher.expiresAt);
    const valid = await verifyVoucherSignature({
      message: encodeVoucherMessageBytes({
        channelId,
        cumulativeAmount: cumulative,
        expiresAt: BigInt(payload.voucher.expiresAt),
      }),
      signatureBase58: payload.voucher.signature,
      signerBase58: payload.channelConfig.payerAuthorizer,
    });
    if (!valid) throw new Error(BatchError.VOUCHER_SIGNATURE);
    const channel = await this.fetchChannel(requirements.network, channelId);
    this.assertClaimChannel(channel, payload.channelConfig, terms, requirements, [
      ChannelStatus.Open,
    ]);
    if (cumulative > channel.deposit) throw new Error(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT);
    return channel;
  }

  private async validateRefund(
    payload: BatchRefundPayload,
    requirements: PaymentRequirements,
  ): Promise<ValidatedRefund> {
    if (payload.voucher !== undefined || payload.closeAuthorization !== undefined) {
      throw new Error(
        `${BatchError.CLOSE_AUTHORIZATION}: cooperative close requires a trusted server binding`,
      );
    }
    const terms = await this.resolveTerms(payload.channelConfig, requirements);
    const channelId = await this.deriveChannelId(payload.channelConfig, terms.feePayer);
    await verifyRequestCloseTransaction(payload.transaction, {
      channelId,
      feePayer: terms.feePayer,
      maxComputeUnits: this.config.maxComputeUnits,
      maxPriorityFeeMicroLamports: this.config.maxPriorityFeeMicroLamports,
      memo: terms.memo,
      payer: payload.channelConfig.payer,
    });
    const channel = await this.fetchChannel(requirements.network, channelId);
    this.assertClaimChannel(channel, payload.channelConfig, terms, requirements, [
      ChannelStatus.Open,
      ChannelStatus.Closing,
    ]);
    return { channel, channelId, terms };
  }

  private async settleRefund(
    payment: PaymentPayload,
    payload: BatchRefundPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const validated = await this.validateRefund(payload, requirements);
    const { channel, channelId, terms } = validated;
    if (channel.status === ChannelStatus.Closing) {
      return refundResponse(channelId, channel, requirements.network, "");
    }
    const key = `batch:refund:${requirements.network}:${channelId}:${payload.transaction}`;
    if (this.settlementCache.isDuplicate(key)) {
      return this.settleFailure(payment, "duplicate_settlement", channel.payer);
    }
    await this.trackChannel({
      channelId,
      expiresAt: 0,
      network: requirements.network,
      payTo: requirements.payTo,
      tokenProgram: terms.tokenProgram,
    });
    const broadcast = await this.broadcastDurably(
      key,
      requirements.network,
      channel.payer,
      async onBroadcast => {
        try {
          // Simulated unsigned: the fee payer's signature is not what the
          // program checks here, and leaving it off keeps simulation portable
          // across signer backends that will not sign twice.
          await this.signer.simulateTransaction(payload.transaction, requirements.network);
          return await broadcastOpen(
            this.signer,
            address(terms.feePayer),
            requirements.network,
            payload.transaction,
            onBroadcast,
          );
        } catch (error) {
          if (pendingSignatureOf(error) === undefined) this.settlementCache.delete(key);
          throw error;
        }
      },
    );
    if (!broadcast.ok) return broadcast.response;
    const signature = broadcast.signature;
    const closing = await this.fetchChannel(requirements.network, channelId);
    if (closing.status !== ChannelStatus.Closing) {
      throw new Error(`${BatchError.CLOSE_STATE}: request_close did not enter Closing`);
    }
    this.assertClaimChannel(closing, payload.channelConfig, terms, requirements, [
      ChannelStatus.Closing,
    ]);
    return refundResponse(channelId, closing, requirements.network, signature);
  }

  private async resolveTerms(
    config: BatchChannelConfig,
    requirements: PaymentRequirements,
  ): Promise<BatchTerms> {
    const extra = requirements.extra;
    if (!extra || (extra.paymentFlow !== undefined && extra.paymentFlow !== "authorization")) {
      throw new Error(BatchError.PAYMENT_FLOW);
    }
    const feePayer = extra.feePayer;
    if (typeof feePayer !== "string") throw new Error(BatchError.FEE_PAYER_MISMATCH);
    const feePayerSigner = this.resolveFeePayer(feePayer);
    const voucherSigner = extra.voucherSigner ?? "client";
    const operator = extra.operator;
    if (voucherSigner !== "client" && voucherSigner !== "server") {
      throw new Error(BatchError.CHANNEL_STATE);
    }
    if (
      (voucherSigner === "server" &&
        (typeof operator !== "string" || config.payerAuthorizer !== operator)) ||
      (voucherSigner === "client" && operator !== undefined) ||
      (config.voucherSigner ?? "client") !== voucherSigner
    ) {
      throw new Error(BatchError.CHANNEL_STATE);
    }
    if (config.payer === feePayer || config.payerAuthorizer === feePayer) {
      throw new Error(BatchError.FEE_PAYER_MISMATCH);
    }
    const withdrawDelay = extra.withdrawDelay;
    if (
      typeof withdrawDelay !== "number" ||
      !Number.isInteger(withdrawDelay) ||
      withdrawDelay < MIN_WITHDRAW_DELAY ||
      withdrawDelay > MAX_WITHDRAW_DELAY ||
      withdrawDelay < requirements.maxTimeoutSeconds
    ) {
      throw new Error(BatchError.WITHDRAW_DELAY_OUT_OF_RANGE);
    }
    if (config.withdrawDelay !== withdrawDelay) throw new Error(BatchError.WITHDRAW_DELAY_MISMATCH);
    if (config.receiver !== requirements.payTo || config.token !== requirements.asset) {
      throw new Error(BatchError.CHANNEL_STATE);
    }
    const receiverAuthorizer = extra.receiverAuthorizer;
    if (
      (receiverAuthorizer === undefined) !== (config.receiverAuthorizer === undefined) ||
      (receiverAuthorizer !== undefined && receiverAuthorizer !== config.receiverAuthorizer)
    ) {
      throw new Error(BatchError.RECEIVER_AUTHORIZER_MISMATCH);
    }
    const tokenProgram = extra.tokenProgram;
    if (tokenProgram !== TOKEN_PROGRAM_ADDRESS && tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS) {
      throw new Error(BatchError.TOKEN_PROGRAM);
    }
    // A mint's owner is its token program, so the declared one is checked
    // with an account read rather than a decode.
    if (typeof this.signer.getAccountInfo !== "function") {
      throw new Error(
        "BatchSvmScheme requires getAccountInfo on the facilitator signer. " +
          "Use toFacilitatorSvmSigner() which provides all required methods.",
      );
    }
    const mint = await this.signer.getAccountInfo(requirements.asset, requirements.network, {
      commitment: "confirmed",
      encoding: "base64",
    });
    if (!mint || mint.owner.toString() !== tokenProgram) {
      throw new Error(BatchError.TOKEN_PROGRAM);
    }
    const memo = extra.memo;
    if (memo !== undefined && typeof memo !== "string")
      throw new Error(BatchError.SETUP_TRANSACTION);
    return {
      feePayer,
      feePayerSigner,
      ...(memo !== undefined ? { memo } : {}),
      ...(typeof receiverAuthorizer === "string" ? { receiverAuthorizer } : {}),
      tokenProgram,
      withdrawDelay,
      voucherSigner,
    };
  }

  private async deriveChannelId(config: BatchChannelConfig, feePayer: string): Promise<string> {
    return findPaymentChannelPda({
      authorizedSigner: config.payerAuthorizer,
      mint: config.token,
      openSlot: parseU64(config.openSlot, "channelConfig.openSlot"),
      payee: feePayer,
      payer: config.payer,
      salt: parseU64(config.salt, "channelConfig.salt"),
    });
  }

  private assertExpiry(expiresAt: number): void {
    if (expiresAt !== 0) throw new Error(BatchError.VOUCHER_EXPIRY);
  }

  /**
   * Broadcast through the pending-settlement record, or reconcile against a
   * broadcast this facilitator already made and could not confirm.
   *
   * A confirmation wait that ends without an answer says nothing about the
   * transaction: it may still land. Rebroadcasting then would escrow or redeem
   * twice, so the signature is recorded before the wait and reconciled on the
   * next attempt — including after a restart, when the in-memory duplicate
   * cache is gone.
   *
   * @param key - Deterministic key for this exact piece of work
   * @param network - Network the work is submitted to
   * @param payer - Payer reported on a pending or failed response
   * @param broadcast - Sends the transaction, reporting its signature to
   *   `onBroadcast` before waiting on confirmation
   * @returns The confirmed signature, or the response to answer with
   */
  private async broadcastDurably(
    key: string,
    network: Network,
    payer: string,
    broadcast: (onBroadcast: (signature: string) => Promise<void>) => Promise<string>,
  ): Promise<{ ok: true; signature: string } | { ok: false; response: SettleResponse }> {
    const recorded = await this.pendingStore.get(key);
    if (recorded) {
      // Reconciled before the record is dropped, not after. Dropping it first
      // would leave a concurrent retry — one that read no record because this
      // call had already removed it — to broadcast the work a second time,
      // with only the in-memory duplicate cache in the way. That cache is
      // empty after a restart, which is exactly when a pending record is being
      // reconciled. Two callers reconciling the same signature is harmless:
      // they confirm the same transaction and reach the same answer.
      return this.reconcileBroadcast(key, recorded, network, payer);
    }
    let signature: string;
    try {
      signature = await broadcast(async broadcastSignature => {
        await this.pendingStore.set(key, broadcastSignature);
      });
    } catch (error) {
      const pending = pendingSignatureOf(error);
      if (pending === undefined) throw error;
      return {
        ok: false,
        response: await recordPendingOrTerminal(
          this.pendingStore,
          key,
          pending,
          payer,
          network,
          ErrSettlementPending,
          "transaction_failed",
          error,
        ),
      };
    }
    await this.forgetPending(key);
    return { ok: true, signature };
  }

  /**
   * Wait on a signature this facilitator already broadcast.
   *
   * @param key - The pending record's key
   * @param signature - The recorded signature
   * @param network - Network the transaction was submitted to
   * @param payer - Payer reported on a pending or failed response
   * @returns The confirmed signature, or the response to answer with
   */
  private async reconcileBroadcast(
    key: string,
    signature: string,
    network: Network,
    payer: string,
  ): Promise<{ ok: true; signature: string } | { ok: false; response: SettleResponse }> {
    try {
      await this.signer.confirmTransaction(signature, network);
    } catch (error) {
      if (error instanceof TransactionOnchainFailureError) {
        // A definite onchain rejection: nothing landed, so the record is
        // dropped and the caller reports a failure rather than a pending.
        await this.forgetPending(key);
        return {
          ok: false,
          response: {
            errorMessage: error.message,
            errorReason: "transaction_failed",
            network,
            payer,
            success: false,
            transaction: signature,
          },
        };
      }
      return {
        ok: false,
        response: await recordPendingOrTerminal(
          this.pendingStore,
          key,
          signature,
          payer,
          network,
          ErrSettlementPending,
          "transaction_failed",
          error,
        ),
      };
    }
    await this.forgetPending(key);
    return { ok: true, signature };
  }

  /**
   * Drop a pending record; a storage hiccup must not mask a confirmed result.
   *
   * @param key - The pending record to drop
   */
  private async forgetPending(key: string): Promise<void> {
    try {
      await this.pendingStore.delete(key);
    } catch {
      // Best effort: the work is confirmed either way.
    }
  }

  /**
   * Submit a redemption batch: claim or distribute.
   *
   * Simulation is explicit and its failure is reported as
   * `settlement_simulation` rather than as a generic send error. A batch packs
   * several channels into one transaction, so a caller that cannot tell
   * simulation from transport cannot tell a poisoned batch from a flaky node —
   * and would retry the same doomed batch forever. The signer then broadcasts
   * with preflight skipped, so the node does not simulate the same bytes again.
   *
   * @param feePayer - Address of the managed fee payer to sign with
   * @param network - CAIP-2 network to submit against
   * @param instructions - The batch's channel instructions
   * @param key - Deterministic key for this exact batch
   * @param payer - Payer reported on a pending or failed response
   * @returns The confirmed signature, or the response to answer with
   */
  private async submitRedemption(
    feePayer: string,
    network: Network,
    instructions: readonly ServerInstruction[],
    key: string,
    payer: string,
  ): Promise<{ ok: true; signature: Signature } | { ok: false; response: SettleResponse }> {
    const broadcast = await this.broadcastDurably(key, network, payer, async onBroadcast => {
      try {
        return await submitChannelTransactionWithSigner(
          this.resolveFeePayer(feePayer),
          this.signer,
          network,
          instructions,
          { onBroadcast },
        );
      } catch (error) {
        if (error instanceof ChannelSimulationError) {
          throw new Error(`${BatchError.SETTLEMENT_SIMULATION}: ${String(error.cause)}`);
        }
        throw error;
      }
    });
    return broadcast.ok
      ? { ok: true, signature: broadcast.signature as Signature }
      : { ok: false, response: broadcast.response };
  }

  private resolveFeePayer(feePayer: string): FacilitatorSigningCapabilities {
    if (!this.signer.getAddresses().some(value => value === feePayer)) {
      throw new Error(BatchError.FEE_PAYER_MISMATCH);
    }
    return this.signer.getSigner!(address(feePayer));
  }

  /**
   * Read a channel account through the facilitator signer.
   *
   * Every read goes through the same transport that signs, simulates and
   * broadcasts, so an operator configuring one RPC does not find reads
   * quietly answered by another.
   *
   * @param network - CAIP-2 network to read from
   * @param channelId - Channel PDA (base58)
   * @returns The decoded channel, or undefined when the account is absent
   */
  private async readChannel(network: string, channelId: string): Promise<Channel | undefined> {
    if (typeof this.signer.getAccountInfo !== "function") {
      throw new Error(
        "BatchSvmScheme requires getAccountInfo on the facilitator signer. " +
          "Use toFacilitatorSvmSigner() which provides all required methods.",
      );
    }
    const account = await this.signer.getAccountInfo(channelId, network, {
      commitment: "confirmed",
      encoding: "base64",
    });
    if (!account) return undefined;
    const encoded = Array.isArray(account.data) ? account.data[0] : account.data;
    return getChannelDecoder().decode(Buffer.from(encoded, "base64"));
  }

  private async fetchChannel(network: string, channelId: string): Promise<Channel> {
    for (let attempt = 0; attempt < CHANNEL_READ_ATTEMPTS; attempt += 1) {
      const channel = await this.readChannel(network, channelId);
      if (channel) return channel;
      if (attempt + 1 < CHANNEL_READ_ATTEMPTS) {
        await new Promise(resolve =>
          setTimeout(resolve, CHANNEL_READ_INITIAL_BACKOFF_MS * 2 ** attempt),
        );
      }
    }
    throw new Error(`${BatchError.CHANNEL_STATE}: channel is not visible after confirmation`);
  }

  private assertDepositChannel(
    channel: Channel,
    validated: ValidatedDeposit,
    requirements: PaymentRequirements,
  ): void {
    this.assertClaimChannel(
      channel,
      validated.payload.channelConfig,
      validated.terms,
      requirements,
      [ChannelStatus.Open],
    );
    if (channel.deposit !== validated.expectedDeposit) {
      throw new Error(`${BatchError.CHANNEL_STATE}: confirmed deposit mismatch`);
    }
  }

  private assertClaimChannel(
    channel: Channel,
    config: BatchChannelConfig,
    terms: BatchTerms,
    requirements: PaymentRequirements,
    allowedStatuses: readonly ChannelStatus[],
  ): void {
    const expectedDistributionHash = getChannelDistributionHash([
      { bps: 10_000, recipient: requirements.payTo },
    ]);
    if (
      channel.discriminator !== AccountDiscriminator.Channel ||
      !allowedStatuses.includes(channel.status as ChannelStatus) ||
      channel.payer !== config.payer ||
      channel.payee !== terms.feePayer ||
      channel.rentPayer !== terms.feePayer ||
      channel.authorizedSigner !== config.payerAuthorizer ||
      channel.mint !== requirements.asset ||
      channel.gracePeriod !== terms.withdrawDelay ||
      channel.salt !== BigInt(config.salt) ||
      channel.openSlot !== BigInt(config.openSlot) ||
      channel.distributionHash.length !== expectedDistributionHash.length ||
      channel.distributionHash.some((value, index) => value !== expectedDistributionHash[index])
    ) {
      throw new Error(BatchError.CHANNEL_STATE);
    }
  }

  private async distributeInstruction(
    channelId: string,
    channel: Channel,
    terms: BatchTerms,
    requirements: PaymentRequirements,
  ): Promise<ServerInstruction> {
    return buildDistributeInstruction({
      channelId,
      mint: channel.mint,
      network: requirements.network,
      payee: channel.payee,
      payer: channel.payer,
      rentPayer: channel.rentPayer,
      splits: [{ bps: 10_000, recipient: requirements.payTo }],
      tokenProgram: terms.tokenProgram,
    });
  }

  private trackChannel(record: Omit<PaymentChannelRecord, "firstSeenAt">): Promise<void> {
    return this.channelStorage.upsert({ ...record, firstSeenAt: Date.now() });
  }

  private verifyFailure(reason: string, payer: string, message?: string): VerifyResponse {
    return {
      isValid: false,
      invalidReason: reason,
      ...(message ? { invalidMessage: message } : {}),
      payer,
    };
  }

  private settleFailure(
    payment: PaymentPayload,
    reason: string,
    payer: string,
    message?: string,
  ): SettleResponse {
    return {
      success: false,
      network: payment.accepted.network,
      transaction: "",
      errorReason: reason,
      ...(message ? { errorMessage: message } : {}),
      payer,
    };
  }
}

export function calculateDistributionAmount(
  channels: readonly { payoutWatermark: bigint; settled: bigint }[],
): bigint {
  return channels.reduce((total, channel) => {
    if (channel.payoutWatermark > channel.settled) {
      throw new Error(`${BatchError.CHANNEL_STATE}: payout watermark exceeds settled amount`);
    }
    return total + channel.settled - channel.payoutWatermark;
  }, 0n);
}

/**
 * The signature carried by an error that means "broadcast, outcome unknown",
 * or `undefined` for anything else.
 *
 * @param error - The error a broadcast attempt threw
 * @returns The signature already on the network, when there is one
 */
function pendingSignatureOf(error: unknown): string | undefined {
  if (error instanceof ChannelBroadcastConfirmationError) return error.signature;
  if (error instanceof SettlementConfirmationTimeoutError) return String(error.signature);
  return undefined;
}

function snapshotChannel(
  channelId: string,
  channel: Channel,
  chargedCumulativeAmount?: bigint,
): BatchChannelState {
  const snapshot: BatchChannelState = {
    channelId,
    balance: channel.deposit.toString(),
    totalClaimed: channel.settlement.settled.toString(),
    withdrawRequestedAt:
      channel.status === ChannelStatus.Closing ? Number(channel.closureStartedAt) : 0,
  };
  if (chargedCumulativeAmount !== undefined) {
    snapshot.chargedCumulativeAmount = chargedCumulativeAmount.toString();
  }
  return snapshot;
}

function depositResponse(
  channelId: string,
  channel: Channel,
  network: Network,
  transaction: string,
): SettleResponse {
  return {
    success: true,
    payer: channel.payer,
    transaction,
    network,
    amount: channel.deposit.toString(),
    extra: {
      channelState: snapshotChannel(channelId, channel),
    },
  };
}

function refundResponse(
  channelId: string,
  channel: Channel,
  network: Network,
  transaction: string,
): SettleResponse {
  return {
    success: true,
    payer: channel.payer,
    transaction,
    network,
    extra: { channelState: snapshotChannel(channelId, channel) },
  };
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(CHANNEL_BUSY)) return CHANNEL_BUSY;
  const known = Object.values(BatchError).find(value => message.includes(value));
  return known ?? "transaction_failed";
}

function parseOptionalSlot(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  return parseU64(value as string | number | bigint, "extra.recentSlot");
}
