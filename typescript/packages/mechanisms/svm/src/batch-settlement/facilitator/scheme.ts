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

import {
  MEMO_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "../../constants";
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
import type {
  FacilitatorAccountInfo,
  FacilitatorConfirmedTransaction,
  FacilitatorSigningCapabilities,
  FacilitatorSvmSigner,
} from "../../signer";
import {
  broadcastOpen,
  getChannelDistributionHash,
  submitChannelTransactionWithSigner,
  ChannelSimulationError,
  SettlementConfirmationTimeoutError,
} from "../../payment-channels/facilitator";
import {
  assertMaxIdleSecs,
  PaymentChannelRentCleanupManager,
} from "../../payment-channels/rentCleanup";
import {
  InMemoryPaymentChannelStorage,
  type PaymentChannelRecord,
  type PaymentChannelStorage,
} from "../../payment-channels/storage";
import { simulateOpenSettleDistribute } from "../../upto/facilitator/channel";
import {
  InMemoryBatchPendingSettlementStore,
  PayoutAttributionAmbiguousError,
  broadcastExpiredWithoutLanding,
  discardWire,
  distributionsForStore,
  reserveBroadcast,
  type BatchPendingSettlementStore,
} from "./recovery";
import {
  CHANNEL_BUSY,
  claimResponse,
  classifyError,
  depositResponse,
  parseOptionalSlot,
  pendingSignatureOf,
  recoveredRefundResponse,
  refundResponse,
  snapshotChannel,
} from "./responses";

import { recordPendingOrTerminal, TransactionOnchainFailureError } from "../../utils";
import { ErrSettlementPending } from "../../exact/facilitator/errors";
import { BatchError } from "../errors";
import {
  BATCH_SETTLEMENT_SCHEME,
  type BatchChannelConfig,
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
const COMPLETED_BROADCAST_SUFFIX = ":completed";

/** Four Ed25519+settle pairs fit under Solana's transaction packet limit. */
export const MAX_CHANNELS_PER_SETTLE_TX = 4;

export interface BatchSvmFacilitatorConfig {
  rpcUrl?: string | undefined;
  /**
   * Durable record of pending signatures and completed operation outcomes, so
   * retries — including after a restart — reconcile instead of rebroadcasting.
   * Defaults to an in-memory store. Production deployments should supply a
   * shared durable store whose TTL covers their client retry window.
   */
  pendingSettlementStore?: BatchPendingSettlementStore | undefined;
  /** Called before completing a payout; implementations must deduplicate by transaction. */
  onDistributionConfirmed?: (
    response: SettleResponse,
    requirements: PaymentRequirements,
  ) => Promise<void>;
  /** Shared, facilitator-owned lifecycle index used for rent cleanup. */
  channelStorage?: PaymentChannelStorage | undefined;
  /**
   * Idle window advertised as `extra.maxIdleSecs`: seconds without
   * facilitator-visible lifecycle activity after which rent cleanup MAY
   * abandon-close an Open channel at its settled watermark. `0` disables and
   * is not advertised. Defaults to `DEFAULT_MAX_IDLE_SECS` (seven days).
   */
  maxIdleSecs?: number | undefined;
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

type DurableBroadcastResult =
  | { ok: true; replayed: boolean; signature: string }
  | { ok: false; response: SettleResponse };

type PreparedClaim = {
  claim: BatchClaimPayload["claims"][number];
  channelId: string;
  feePayer: string;
  cumulative: bigint;
  expiresAt: number;
  payTo: string;
  tokenProgram: string;
  terms: BatchTerms;
};

type PreparedDistribution = {
  channelConfig: BatchSettlePayload["channels"][number]["channelConfig"];
  channelId: string;
  feePayer: string;
  terms: BatchTerms;
};

export class BatchSvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly caipFamily = "solana:*";
  private readonly channelStorage: PaymentChannelStorage;
  private readonly settlementCache = new SettlementCache();
  private readonly pendingStore: BatchPendingSettlementStore;
  private readonly confirmationSlots = new Map<string, bigint>();
  private readonly distributionPasses: Map<string, Promise<SettleResponse>>;
  private readonly maxIdleSecs: number;

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
    this.pendingStore = config.pendingSettlementStore ?? new InMemoryBatchPendingSettlementStore();
    this.distributionPasses = distributionsForStore(this.pendingStore);
    this.maxIdleSecs = assertMaxIdleSecs(config.maxIdleSecs);
  }

  getExtra(_: Network): Record<string, unknown> {
    const addresses = this.signer.getAddresses();
    return {
      feePayer: addresses[Math.floor(Math.random() * addresses.length)],
      // Servers copy the idle window into the 402: it is how long they have
      // to claim before an idle channel is closed at its onchain watermark.
      ...(this.maxIdleSecs > 0 ? { maxIdleSecs: this.maxIdleSecs } : {}),
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
      maxIdleSecs: this.maxIdleSecs,
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
    const prepared: PreparedClaim[] = [];
    for (const claim of payload.claims) {
      const terms = await this.resolveTerms(claim.voucher.channelConfig, requirements);
      const channelId = await this.deriveChannelId(claim.voucher.channelConfig, terms.feePayer);
      if (channelId !== claim.voucher.channelId) throw new Error(BatchError.CHANNEL_ID_MISMATCH);
      const cumulative = parseU64(claim.voucher.maxClaimableAmount, "maxClaimableAmount");
      this.assertExpiry(claim.voucher.expiresAt);
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
        claim,
        channelId,
        cumulative,
        expiresAt: claim.voucher.expiresAt,
        feePayer: terms.feePayer,
        payTo: requirements.payTo,
        tokenProgram: terms.tokenProgram,
        terms,
      });
    }
    const feePayer = prepared[0]?.feePayer;
    if (!feePayer || prepared.some(item => item.feePayer !== feePayer)) {
      throw new Error(BatchError.FEE_PAYER_MISMATCH);
    }
    // Keyed by exactly what this batch advances, so a retry of the same claim
    // reconciles while a different one proceeds.
    const claimKey = `batch:claim:${requirements.network}:${prepared
      .map(item => `${item.channelId}:${item.cumulative}`)
      .sort()
      .join(",")}`;
    const completed = await this.pendingStore.get(this.completedBroadcastKey(claimKey));
    if (completed) return claimResponse(prepared, requirements.network, completed);

    // A completed replay must not re-register a channel already reclaimed by cleanup.
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

    const pending = await this.pendingStore.get(claimKey);
    if (pending) {
      const recovered = await this.reconcileBroadcast(
        claimKey,
        pending,
        requirements.network,
        prepared[0]?.claim.voucher.channelConfig.payer ?? "",
      );
      if (!recovered.ok) return recovered.response;
      const confirmed = await this.fetchChannelsUntil(
        requirements.network,
        prepared.map(item => item.channelId),
        channels =>
          channels.every(
            (channel, index) =>
              channel !== undefined && channel.settlement.settled >= prepared[index]!.cumulative,
          ),
      );
      if (!confirmed) {
        return this.settlementPending(
          requirements.network,
          prepared[0]?.claim.voucher.channelConfig.payer ?? "",
          recovered.signature,
          "claim confirmed but its channel watermark is not visible yet",
        );
      }
      this.assertRecoveredClaims(confirmed, prepared, requirements);
      const incomplete = await this.completeOrPending(
        claimKey,
        recovered.signature,
        requirements.network,
        prepared[0]?.claim.voucher.channelConfig.payer ?? "",
      );
      return incomplete ?? claimResponse(prepared, requirements.network, recovered.signature);
    }

    const channels = await Promise.all(
      prepared.map(item => this.fetchChannel(requirements.network, item.channelId)),
    );
    const instructions: ServerInstruction[] = [];
    for (let index = 0; index < prepared.length; index += 1) {
      const item = prepared[index]!;
      const channel = channels[index]!;
      this.assertClaimChannel(channel, item.claim.voucher.channelConfig, item.terms, requirements, [
        ChannelStatus.Open,
      ]);
      if (item.cumulative <= channel.settlement.settled || item.cumulative > channel.deposit) {
        throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
      }
      instructions.push(
        ...buildSettleInstructions({
          channelId: item.channelId,
          voucher: {
            authorizedSigner: item.claim.voucher.channelConfig.payerAuthorizer,
            cumulativeAmount: item.cumulative,
            expiresAt: BigInt(item.expiresAt),
            signatureBase58: item.claim.signature,
          },
        }),
      );
    }
    if (this.settlementCache.isDuplicate(claimKey)) {
      return this.settleFailure(
        payment,
        CHANNEL_BUSY,
        prepared[0]?.claim.voucher.channelConfig.payer ?? "",
      );
    }
    const submitted = await this.submitRedemption(
      feePayer,
      requirements.network,
      instructions,
      claimKey,
      prepared[0]?.claim.voucher.channelConfig.payer ?? "",
    );
    if (!submitted.ok) return submitted.response;
    if (submitted.replayed) {
      return claimResponse(prepared, requirements.network, submitted.signature);
    }
    const confirmed = await this.fetchChannelsUntil(
      requirements.network,
      prepared.map(item => item.channelId),
      observed =>
        observed.every(
          (channel, index) =>
            channel !== undefined && channel.settlement.settled >= prepared[index]!.cumulative,
        ),
    );
    if (!confirmed) {
      return this.settlementPending(
        requirements.network,
        prepared[0]?.claim.voucher.channelConfig.payer ?? "",
        submitted.signature,
        "claim confirmed but its channel watermark is not visible yet",
      );
    }
    this.assertRecoveredClaims(confirmed, prepared, requirements);
    const incomplete = await this.completeOrPending(
      claimKey,
      submitted.signature,
      requirements.network,
      prepared[0]?.claim.voucher.channelConfig.payer ?? "",
    );
    return incomplete ?? claimResponse(prepared, requirements.network, submitted.signature);
  }

  async settleDistributions(
    payment: PaymentPayload,
    payload: BatchSettlePayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    if (
      payload.channels.length === 0 ||
      payload.channels.length > MAX_CHANNELS_PER_SETTLE_TX ||
      new Set(payload.channels.map(item => item.channelId)).size !== payload.channels.length
    ) {
      throw new Error(`${BatchError.PAYLOAD_TYPE}: invalid channel batch`);
    }
    // This identifies a sweep queue, not an immutable merchant request. A later
    // call may sweep new earnings after the preceding transaction is resolved.
    const key = `batch:distribute:${requirements.network}:${requirements.asset}:${requirements.payTo}:${payload.channels
      .map(item => item.channelId)
      .sort()
      .join(",")}`;
    const active = this.distributionPasses.get(key);
    if (active) return active;
    const pass = this.distributeCurrent(payment, payload, requirements, key);
    this.distributionPasses.set(key, pass);
    try {
      return await pass;
    } finally {
      if (this.distributionPasses.get(key) === pass) this.distributionPasses.delete(key);
    }
  }

  private async distributeCurrent(
    payment: PaymentPayload,
    payload: BatchSettlePayload,
    requirements: PaymentRequirements,
    key: string,
  ): Promise<SettleResponse> {
    const prepared: PreparedDistribution[] = [];
    for (const entry of payload.channels) {
      const terms = await this.resolveTerms(entry.channelConfig, requirements);
      const channelId = await this.deriveChannelId(entry.channelConfig, terms.feePayer);
      if (channelId !== entry.channelId) throw new Error(BatchError.CHANNEL_ID_MISMATCH);
      prepared.push({
        channelConfig: entry.channelConfig,
        channelId,
        feePayer: terms.feePayer,
        terms,
      });
    }
    const feePayer = prepared[0]!.feePayer;
    if (prepared.some(item => item.feePayer !== feePayer))
      throw new Error(BatchError.FEE_PAYER_MISMATCH);
    const pending = await this.pendingStore.get(key);
    if (pending) {
      const recovered = await this.reconcileBroadcast(key, pending, requirements.network, "");
      if (!recovered.ok) return recovered.response;
      return this.finishDistribution(key, recovered.signature, prepared, requirements);
    }
    const previous = await this.pendingStore.get(`${key}:result`);
    const previousSlot = await this.pendingStore.get(`${key}:slot`);
    if (previousSlot) this.rememberSlot(requirements.network, BigInt(previousSlot));
    const instructions: ServerInstruction[] = [];
    for (const item of prepared) {
      const channel = previous
        ? await this.readChannel(requirements.network, item.channelId)
        : await this.fetchChannel(requirements.network, item.channelId);
      if (!channel && previous) continue; // The preceding payout may have closed it.
      if (!channel) throw new Error(BatchError.CHANNEL_STATE);
      this.assertClaimChannel(channel, item.channelConfig, item.terms, requirements, [
        ChannelStatus.Open,
        ChannelStatus.Sealed,
        ChannelStatus.Distributed,
      ]);
      if (
        channel.status === ChannelStatus.Distributed ||
        (channel.status === ChannelStatus.Open &&
          channel.settlement.payoutWatermark === channel.settlement.settled)
      )
        continue;
      instructions.push(
        await this.distributeInstruction(item.channelId, channel, item.terms, requirements),
      );
    }
    if (instructions.length === 0) {
      if (previous) return JSON.parse(previous) as SettleResponse;
      // State alone cannot identify a previous payment or its amount.
      return this.settleFailure(payment, BatchError.CUMULATIVE_AMOUNT_MISMATCH, "");
    }
    // Different sweeps can share a recent blockhash. Give each new signed
    // transaction its own identity; recovery always reuses these exact bytes.
    instructions.push({
      programAddress: address(MEMO_PROGRAM_ADDRESS),
      accounts: [],
      data: new TextEncoder().encode(`x402:batch:${crypto.randomUUID()}`),
    });
    await this.pendingStore.delete(this.completedBroadcastKey(key));
    const submitted = await this.submitRedemption(
      feePayer,
      requirements.network,
      instructions,
      key,
      "",
    );
    if (!submitted.ok) return submitted.response;
    return this.finishDistribution(key, submitted.signature, prepared, requirements);
  }

  private async finishDistribution(
    key: string,
    signature: string,
    prepared: PreparedDistribution[],
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    try {
      // A cached result contains the actual transfer, including on its first
      // successful recovery. Replaying an HTTP response does not change it.
      const cached = await this.pendingStore.get(
        `batch:transaction:${requirements.network}:${signature}:result`,
      );
      let response = cached ? (JSON.parse(cached) as SettleResponse) : undefined;
      if (!response) {
        if (!this.signer.getConfirmedTransaction)
          throw new Error("getConfirmedTransaction is required for payout accounting");
        let evidence: FacilitatorConfirmedTransaction | null | undefined;
        for (let attempt = 0; attempt < CHANNEL_READ_ATTEMPTS; attempt += 1) {
          try {
            evidence = await this.signer.getConfirmedTransaction(signature, requirements.network);
          } catch {
            /* An unavailable history read is pending, never zero paid. */
          }
          if (evidence?.meta && evidence.meta.preTokenBalances && evidence.meta.postTokenBalances)
            break;
          if (attempt + 1 < CHANNEL_READ_ATTEMPTS) await this.waitForChannelRead(attempt);
        }
        if (!evidence?.meta?.preTokenBalances || !evidence.meta.postTokenBalances)
          throw new Error("payout transaction metadata is not visible yet");
        if (evidence.meta.err !== null)
          throw new TransactionOnchainFailureError("distribution transaction failed onchain");
        this.rememberSlot(requirements.network, BigInt(evidence.slot));
        await this.pendingStore.set(`${key}:slot`, String(evidence.slot));
        const keys = evidence.transaction.message.accountKeys.map(item =>
          typeof item === "string" ? item : item.pubkey,
        );
        const [recipient] = await findAssociatedTokenPda({
          mint: address(requirements.asset),
          owner: address(requirements.payTo),
          tokenProgram: address(prepared[0]!.terms.tokenProgram),
        });
        const recipientIndex = keys.indexOf(recipient);
        if (recipientIndex < 0)
          throw new Error("recipient is absent from distribution transaction");
        // A sealed payout can also refund the payer or sweep treasury funds.
        // Balance evidence cannot separate those legs when beneficiaries alias.
        for (const item of prepared) {
          const [escrow] = await findAssociatedTokenPda({
            mint: address(requirements.asset),
            owner: address(item.channelId),
            tokenProgram: address(item.terms.tokenProgram),
          });
          const escrowIndex = keys.indexOf(escrow);
          if (escrowIndex < 0) continue; // Already paid channel omitted from this sweep.
          const closed = !evidence.meta.postTokenBalances.some(
            balance => balance.accountIndex === escrowIndex,
          );
          if (
            closed &&
            (item.channelConfig.payer === requirements.payTo ||
              getPaymentChannelsTreasuryOwner(requirements.network) === requirements.payTo)
          ) {
            throw new PayoutAttributionAmbiguousError();
          }
        }
        const balance = (balances: NonNullable<typeof evidence.meta.preTokenBalances>) => {
          const entry = balances.find(item => item.accountIndex === recipientIndex);
          if (!entry) return 0n;
          if (entry.mint !== requirements.asset || entry.owner !== requirements.payTo)
            throw new Error("payout recipient balance mismatch");
          return parseU64(entry.uiTokenAmount.amount, "payout balance");
        };
        const amount =
          balance(evidence.meta.postTokenBalances) - balance(evidence.meta.preTokenBalances);
        if (amount < 0n) throw new Error("negative recipient payout");
        response = {
          success: true,
          network: requirements.network,
          payer: "",
          transaction: signature,
          amount: amount.toString(),
          extra: { channels: prepared.map(item => item.channelId) },
        };
        await this.pendingStore.set(
          `batch:transaction:${requirements.network}:${signature}:result`,
          JSON.stringify(response),
        );
      }
      await this.config.onDistributionConfirmed?.(response, requirements);
      await this.pendingStore.set(`${key}:result`, JSON.stringify(response));
      await this.completeBroadcast(key, signature, requirements.network);
      return response;
    } catch (error) {
      if (error instanceof PayoutAttributionAmbiguousError) {
        // The sweep landed, so holding the queue pending would only block
        // every later sweep of these channels. Release it and answer with an
        // explicit reason an operator can reconcile by signature; the
        // recording callback is skipped because no amount can be attributed.
        const response: SettleResponse = {
          errorMessage: error.message,
          errorReason: BatchError.PAYOUT_ATTRIBUTION_AMBIGUOUS,
          network: requirements.network,
          payer: "",
          success: false,
          transaction: signature,
        };
        await this.pendingStore.set(`${key}:result`, JSON.stringify(response));
        await this.completeBroadcast(key, signature, requirements.network);
        return response;
      }
      return this.settlementPending(requirements.network, "", signature, String(error));
    }
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
        // Simulates the open/settle/distribute chain through the facilitator
        // signer's own RPC, like every other read and broadcast here.
        await simulateOpenSettleDistribute(
          terms.feePayerSigner,
          this.signer,
          requirements.network,
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
            this.submissionSigner(),
            address(terms.feePayer),
            requirements.network,
            payload.deposit.transaction,
            undefined,
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
    if (!broadcast.replayed) {
      const incomplete = await this.completeOrPending(
        key,
        signature,
        requirements.network,
        payload.channelConfig.payer,
      );
      if (incomplete) return incomplete;
    }
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
    const { channelId, terms } = await this.prepareRefund(payload, requirements);
    const channel = await this.fetchChannel(requirements.network, channelId);
    this.assertClaimChannel(channel, payload.channelConfig, terms, requirements, [
      ChannelStatus.Open,
      ChannelStatus.Closing,
    ]);
    return { channel, channelId, terms };
  }

  private async prepareRefund(
    payload: BatchRefundPayload,
    requirements: PaymentRequirements,
  ): Promise<{ channelId: string; terms: BatchTerms }> {
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
    return { channelId, terms };
  }

  private async settleRefund(
    payment: PaymentPayload,
    payload: BatchRefundPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const { channelId, terms } = await this.prepareRefund(payload, requirements);
    const key = `batch:refund:${requirements.network}:${channelId}:${payload.transaction}`;
    const completed = await this.pendingStore.get(this.completedBroadcastKey(key));
    if (completed) {
      const observed = await this.fetchChannelUntil(
        requirements.network,
        channelId,
        channel =>
          channel === undefined ||
          channel.status === ChannelStatus.Closing ||
          channel.status === ChannelStatus.Sealed ||
          channel.status === ChannelStatus.Distributed,
      );
      if (observed) {
        this.assertClaimChannel(observed, payload.channelConfig, terms, requirements, [
          ChannelStatus.Closing,
          ChannelStatus.Sealed,
          ChannelStatus.Distributed,
        ]);
        return refundResponse(channelId, observed, requirements.network, completed);
      }
      return recoveredRefundResponse(
        channelId,
        payload.channelConfig.payer,
        requirements.network,
        completed,
      );
    }
    const pending = await this.pendingStore.get(key);
    if (pending) {
      const recovered = await this.reconcileBroadcast(
        key,
        pending,
        requirements.network,
        payload.channelConfig.payer,
      );
      if (!recovered.ok) return recovered.response;
      const observed = await this.fetchChannelUntil(
        requirements.network,
        channelId,
        channel =>
          channel === undefined ||
          channel.status === ChannelStatus.Closing ||
          channel.status === ChannelStatus.Sealed ||
          channel.status === ChannelStatus.Distributed,
      );
      if (observed === false) {
        return this.settlementPending(
          requirements.network,
          payload.channelConfig.payer,
          recovered.signature,
          "request_close confirmed but the closing state is not visible yet",
        );
      }
      if (observed) {
        this.assertClaimChannel(observed, payload.channelConfig, terms, requirements, [
          ChannelStatus.Closing,
          ChannelStatus.Sealed,
          ChannelStatus.Distributed,
        ]);
      }
      const incomplete = await this.completeOrPending(
        key,
        recovered.signature,
        requirements.network,
        payload.channelConfig.payer,
      );
      if (incomplete) return incomplete;
      return observed
        ? refundResponse(channelId, observed, requirements.network, recovered.signature)
        : recoveredRefundResponse(
            channelId,
            payload.channelConfig.payer,
            requirements.network,
            recovered.signature,
          );
    }

    const channel = await this.fetchChannel(requirements.network, channelId);
    this.assertClaimChannel(channel, payload.channelConfig, terms, requirements, [
      ChannelStatus.Open,
      ChannelStatus.Closing,
    ]);
    if (channel.status === ChannelStatus.Closing) {
      return refundResponse(channelId, channel, requirements.network, "");
    }
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
            this.submissionSigner(),
            address(terms.feePayer),
            requirements.network,
            payload.transaction,
            undefined,
            onBroadcast,
          );
        } catch (error) {
          if (pendingSignatureOf(error) === undefined) this.settlementCache.delete(key);
          throw error;
        }
      },
    );
    if (!broadcast.ok) return broadcast.response;
    if (broadcast.replayed) {
      return recoveredRefundResponse(
        channelId,
        payload.channelConfig.payer,
        requirements.network,
        broadcast.signature,
      );
    }
    const closing = await this.fetchChannelUntil(
      requirements.network,
      channelId,
      observed =>
        observed !== undefined &&
        (observed.status === ChannelStatus.Closing ||
          observed.status === ChannelStatus.Sealed ||
          observed.status === ChannelStatus.Distributed),
    );
    if (!closing) {
      return this.settlementPending(
        requirements.network,
        payload.channelConfig.payer,
        broadcast.signature,
        "request_close confirmed but the closing state is not visible yet",
      );
    }
    this.assertClaimChannel(closing, payload.channelConfig, terms, requirements, [
      ChannelStatus.Closing,
      ChannelStatus.Sealed,
      ChannelStatus.Distributed,
    ]);
    const incomplete = await this.completeOrPending(
      key,
      broadcast.signature,
      requirements.network,
      payload.channelConfig.payer,
    );
    return (
      incomplete ?? refundResponse(channelId, closing, requirements.network, broadcast.signature)
    );
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
    broadcast: (onPrepared: (signature: string, wire: string) => Promise<void>) => Promise<string>,
  ): Promise<DurableBroadcastResult> {
    const completed = await this.pendingStore.get(this.completedBroadcastKey(key));
    if (completed) return { ok: true, replayed: true, signature: completed };
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
      signature = await broadcast(async (broadcastSignature, wire) => {
        await this.pendingStore.set(
          `batch:transaction:${network}:${broadcastSignature}:wire`,
          wire,
        );
        if (!(await reserveBroadcast(this.pendingStore, key, broadcastSignature))) {
          // Another worker owns this key; the bytes just written will never be sent.
          await discardWire(this.pendingStore, network, broadcastSignature);
          const existing = await this.pendingStore.get(key);
          if (existing) throw new SettlementConfirmationTimeoutError(existing as Signature);
          throw new Error("concurrent broadcast reservation changed");
        }
      });
    } catch (error) {
      const recorded = await this.pendingStore.get(key);
      if (recorded) return this.reconcileBroadcast(key, recorded, network, payer);
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
    // Keep the signature until the caller observes the operation-specific
    // postcondition. Confirmation can precede a fresh account view when RPC
    // requests are load-balanced across nodes.
    // Submission helpers already confirmed and captured the execution slot.
    // Do not add another status RPC to successful opens, top-ups or redemptions.
    return { ok: true, replayed: false, signature };
  }

  /**
   * Wrap submission confirmation so its existing RPC also supplies the read floor.
   *
   * @returns Submission transport with slot capture and no extra confirmation lookup
   */
  private submissionSigner() {
    return {
      signTransaction: this.signer.signTransaction.bind(this.signer),
      ...(this.signer.getLatestBlockhash
        ? { getLatestBlockhash: this.signer.getLatestBlockhash.bind(this.signer) }
        : {}),
      simulateTransaction: this.signer.simulateTransaction.bind(this.signer),
      sendTransaction: this.signer.sendTransaction.bind(this.signer),
      confirmTransaction: async (signature: string, network: string) => {
        const status = await this.signer.confirmTransaction(signature, network);
        if (status?.slot !== undefined) this.rememberSlot(network, BigInt(status.slot));
        return status;
      },
    };
  }

  /**
   * Wait on a signature this facilitator already broadcast.
   *
   * @param key - The pending record's key
   * @param signature - The recorded signature
   * @param network - Network the transaction was submitted to
   * @param payer - Payer reported on a pending or failed response
   * @param resend - Resend previously recorded bytes when recovering a stopped attempt
   * @returns The confirmed signature, or the response to answer with
   */
  private async reconcileBroadcast(
    key: string,
    signature: string,
    network: Network,
    payer: string,
    resend = true,
  ): Promise<DurableBroadcastResult> {
    const wire = await this.pendingStore
      .get(`batch:transaction:${network}:${signature}:wire`)
      .catch(() => undefined);
    try {
      // The process may have stopped after recording but before sending.
      // Re-send the same signed bytes; never construct a replacement on timeout.
      if (wire && resend) {
        try {
          await this.signer.sendTransaction(wire, network);
        } catch {
          /* confirm by identity */
        }
      }
      const status = await this.signer.confirmTransaction(signature, network, {
        searchTransactionHistory: true,
      });
      if (status && status.slot !== undefined) {
        const slot = BigInt(status.slot);
        if (slot > (this.confirmationSlots.get(network) ?? 0n))
          this.confirmationSlots.set(network, slot);
      }
    } catch (error) {
      if (error instanceof TransactionOnchainFailureError) {
        // A definite onchain rejection: nothing landed, so the record is
        // dropped and the caller reports a failure rather than a pending.
        await this.forgetPending(key, signature);
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
      if (await broadcastExpiredWithoutLanding(this.signer, signature, network, wire)) {
        // The blockhash left its validity window and the network has no record
        // of the signature: the bytes can never land, so the queue is released
        // instead of staying pending until an operator clears it.
        await this.forgetPending(key, signature);
        await discardWire(this.pendingStore, network, signature);
        return {
          ok: false,
          response: {
            errorMessage: `transaction ${signature} expired before confirmation: its blockhash is no longer valid and the network has no record of it`,
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
    return { ok: true, replayed: false, signature };
  }

  /**
   * Mark a confirmed operation replayable before its HTTP success is returned.
   *
   * @param key - Deterministic operation key
   * @param signature - Confirmed transaction signature
   * @param network - Network containing the transaction
   */
  private async completeBroadcast(key: string, signature: string, network: string): Promise<void> {
    // Write completion first. A crash before the pending delete leaves both
    // records, and completed is deliberately checked first on recovery.
    await this.pendingStore.set(this.completedBroadcastKey(key), signature);
    await this.forgetPending(key, signature);
    // The completed identity/result now survives response loss; signed bytes
    // are no longer needed for rebroadcast.
    await discardWire(this.pendingStore, network, signature);
  }

  private async completeOrPending(
    key: string,
    signature: string,
    network: Network,
    payer: string,
  ): Promise<SettleResponse | undefined> {
    try {
      await this.completeBroadcast(key, signature, network);
      return undefined;
    } catch (error) {
      return this.settlementPending(
        network,
        payer,
        signature,
        `operation confirmed but completion could not be persisted: ${String(error)}`,
      );
    }
  }

  private completedBroadcastKey(key: string): string {
    return `${key}${COMPLETED_BROADCAST_SUFFIX}`;
  }

  private settlementPending(
    network: Network,
    payer: string,
    signature: string,
    message: string,
  ): SettleResponse {
    return {
      errorMessage: message,
      errorReason: ErrSettlementPending,
      network,
      payer,
      success: false,
      transaction: signature,
    };
  }

  /**
   * Drop a pending record; a storage hiccup must not mask a confirmed result.
   *
   * @param key - The pending record to drop
   * @param signature - The transaction being completed
   */
  private async forgetPending(key: string, signature: string): Promise<void> {
    try {
      if (this.pendingStore.deleteIfEquals) {
        await this.pendingStore.deleteIfEquals(key, signature);
      } else if ((await this.pendingStore.get(key)) === signature) {
        await this.pendingStore.delete(key);
      }
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
  ): Promise<
    { ok: true; replayed: boolean; signature: Signature } | { ok: false; response: SettleResponse }
  > {
    const broadcast = await this.broadcastDurably(key, network, payer, async onBroadcast => {
      try {
        return await submitChannelTransactionWithSigner(
          this.resolveFeePayer(feePayer),
          this.submissionSigner(),
          network,
          instructions,
          { onPrepared: onBroadcast },
        );
      } catch (error) {
        if (error instanceof ChannelSimulationError) {
          throw new Error(`${BatchError.SETTLEMENT_SIMULATION}: ${String(error.cause)}`);
        }
        throw error;
      }
    });
    return broadcast.ok
      ? {
          ok: true,
          replayed: broadcast.replayed,
          signature: broadcast.signature as Signature,
        }
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
    const minContextSlot = this.confirmationSlots.get(network);
    let account: FacilitatorAccountInfo | null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        account = await this.signer.getAccountInfo(channelId, network, {
          commitment: "confirmed",
          encoding: "base64",
          minContextSlot,
        });
        break;
      } catch (error) {
        // A slot floor is only advisory for the read: a load-balanced RPC node
        // that has not reached the remembered confirmation slot rejects it.
        // Give the backend time to catch up instead of failing a deposit or
        // claim that merely wanted the channel's current state. Reads without
        // a floor have nothing to wait for and surface the error at once.
        if (minContextSlot === undefined || attempt + 1 >= CHANNEL_READ_ATTEMPTS) throw error;
        await this.waitForChannelRead(attempt);
      }
    }
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

  /**
   * Poll until an operation-specific channel postcondition is visible.
   *
   * @param network - Network to read
   * @param channelId - Channel PDA
   * @param predicate - Required postcondition
   * @returns The matching channel, `undefined` for a matching absent account, or `false` on timeout
   */
  private async fetchChannelUntil(
    network: string,
    channelId: string,
    predicate: (channel: Channel | undefined) => boolean,
  ): Promise<Channel | undefined | false> {
    for (let attempt = 0; attempt < CHANNEL_READ_ATTEMPTS; attempt += 1) {
      try {
        const channel = await this.readChannel(network, channelId);
        if (predicate(channel)) return channel;
      } catch {
        /* A lagging backend may reject minContextSlot; retry. */
      }
      if (attempt + 1 < CHANNEL_READ_ATTEMPTS) await this.waitForChannelRead(attempt);
    }
    return false;
  }

  /**
   * Poll a batch atomically from the caller's perspective until its predicate holds.
   *
   * @param network - Network to read
   * @param channelIds - Channel PDAs
   * @param predicate - Required batch postcondition
   * @returns Matching channels, or `undefined` on timeout
   */
  private async fetchChannelsUntil(
    network: string,
    channelIds: readonly string[],
    predicate: (channels: readonly (Channel | undefined)[]) => boolean,
  ): Promise<Channel[] | undefined> {
    for (let attempt = 0; attempt < CHANNEL_READ_ATTEMPTS; attempt += 1) {
      try {
        const channels = await Promise.all(channelIds.map(id => this.readChannel(network, id)));
        if (predicate(channels) && channels.every((value): value is Channel => value !== undefined))
          return channels;
      } catch {
        /* Keep transaction identity while the RPC catches up. */
      }
      if (attempt + 1 < CHANNEL_READ_ATTEMPTS) await this.waitForChannelRead(attempt);
    }
    return undefined;
  }

  private rememberSlot(network: string, slot: bigint): void {
    if (slot > (this.confirmationSlots.get(network) ?? 0n))
      this.confirmationSlots.set(network, slot);
  }

  private async waitForChannelRead(attempt: number): Promise<void> {
    await new Promise(resolve =>
      setTimeout(resolve, CHANNEL_READ_INITIAL_BACKOFF_MS * 2 ** attempt),
    );
  }

  private assertRecoveredClaims(
    channels: readonly Channel[],
    prepared: readonly PreparedClaim[],
    requirements: PaymentRequirements,
  ): void {
    for (let index = 0; index < prepared.length; index += 1) {
      const item = prepared[index]!;
      this.assertClaimChannel(
        channels[index]!,
        item.claim.voucher.channelConfig,
        item.terms,
        requirements,
        [
          ChannelStatus.Open,
          ChannelStatus.Sealed,
          ChannelStatus.Closing,
          ChannelStatus.Distributed,
        ],
      );
    }
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

  private trackChannel(
    record: Omit<PaymentChannelRecord, "firstSeenAt" | "lastActivityAt">,
  ): Promise<void> {
    // Every upsert is facilitator-visible activity: it resets the idle clock.
    const now = Date.now();
    return this.channelStorage.upsert({ ...record, firstSeenAt: now, lastActivityAt: now });
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
