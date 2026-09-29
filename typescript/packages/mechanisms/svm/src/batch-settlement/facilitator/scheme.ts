/* eslint-disable jsdoc/require-jsdoc */
import { address, type Signature } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import type {
  FacilitatorContext,
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

import { MEMO_PROGRAM_ADDRESS } from "../../constants";
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
import { requireTokenProgramHint } from "../../payment-channels/requirements";
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
  simulateOpenSettleDistribute,
  submitChannelTransactionWithSigner,
  ChannelSimulationError,
  SettlementConfirmationTimeoutError,
} from "../../payment-channels/facilitator";
import {
  InMemoryPaymentChannelStorage,
  type PaymentChannelRecord,
  type PaymentChannelStorage,
} from "../../payment-channels/storage";
import { assertMaxIdleSecs } from "../../payment-channels/rentCleanup";
import { BatchSvmRentCleanupManager } from "./rentCleanupManager";
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
  settleFailure,
  settlementPending,
  verifiedChannelExtra,
  verifyFailure,
} from "./responses";

import { recordPendingOrTerminal, TransactionOnchainFailureError } from "../../utils";
import { ErrSettlementPending } from "../../exact/facilitator/errors";
import {
  assertNotClosing,
  prepareRefund,
  type SealDependencies,
  settleCooperativeRefund,
  settleSeal,
  validateRefund,
} from "./seal";
import {
  assertServerModeProof as checkServerModeProof,
  assertServerModeRefundProof,
  voucherSignerFor,
} from "./voucherMode";
import {
  assertBindingSource,
  assertDelegatedReceiverAuth,
  type BatchSvmFacilitatorConfig,
  delegatedIdentityForOpen,
  isDelegatedAuthorizer,
  readReceiverAuthorizer,
  resolveDelegatedIdentity,
  storedDelegatedIdentity,
} from "./bindingSource";
import {
  BatchDelegatedAuthIdentityConflictError,
  type BatchDelegatedReceiverAuth,
} from "./delegatedAuthStore";
import {
  BatchReceiverAuthorizerConflictError,
  type BatchReceiverAuthorizerStore,
} from "./receiverAuthorizerStore";
import {
  CHANNEL_READ_ATTEMPTS,
  CHANNEL_READ_INITIAL_BACKOFF_MS,
  COMPLETED_BROADCAST_SUFFIX,
  MAX_CHANNELS_PER_SETTLE_TX,
} from "./constants";
import type {
  BatchReceiverBindingHistoryReader,
  BatchTerms,
  DurableBroadcastResult,
  PreparedClaim,
  PreparedDistribution,
  ProofAmountBound,
  ValidatedDeposit,
  VoucherModeBinding,
} from "./types";
import { BatchError } from "../errors";
import { encodeReceiverBindingMemo } from "../receiverBinding";
import {
  CLIENT_VOUCHER_EXPIRES_AT,
  FULL_SPLIT_BPS,
  MAX_WITHDRAW_DELAY,
  MIN_WITHDRAW_DELAY,
} from "../constants";
import {
  BATCH_SETTLEMENT_SCHEME,
  type BatchChannelConfig,
  type BatchDepositPayload,
  type BatchClaimPayload,
  type BatchPayload,
  type BatchRefundPayload,
  type BatchSettlePayload,
  type BatchVoucher,
  isBatchFacilitatorPayload,
  isBatchPayload,
  proofOf,
} from "../types";

type DurablePhase = "completed" | "pending" | "broadcast";

type DurableObservation<T> = { ok: true; channel: T } | { ok: false; response: SettleResponse };

function isTransientRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b/.test(message) || /\b503\b/.test(message) || /too many requests/i.test(message);
}

export { calculateDistributionAmount, type BatchSvmFacilitatorConfig } from "./bindingSource";

export class BatchSvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly caipFamily = "solana:*";
  private readonly channelStorage: PaymentChannelStorage;
  private readonly settlementCache = new SettlementCache();
  private readonly pendingStore: BatchPendingSettlementStore;
  private readonly confirmationSlots = new Map<string, bigint>();
  private readonly distributionPasses: Map<string, Promise<SettleResponse>>;
  private readonly maxIdleSecs: number;
  private readonly receiverAuthorizers: BatchReceiverAuthorizerStore | undefined;
  private readonly receiverBindingHistoryReader: BatchReceiverBindingHistoryReader | undefined;
  private readonly delegatedReceiverAuth: BatchDelegatedReceiverAuth | undefined;

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
    assertBindingSource({
      receiverAuthorizerStore: config.receiverAuthorizerStore,
      receiverBindingHistoryReader: config.receiverBindingHistoryReader,
    });
    this.receiverAuthorizers = config.receiverAuthorizerStore;
    this.receiverBindingHistoryReader = config.receiverBindingHistoryReader;
    this.delegatedReceiverAuth = assertDelegatedReceiverAuth(config.delegatedReceiverAuth);
  }

  getExtra(_: Network): Record<string, unknown> {
    const addresses = this.signer.getAddresses();
    return {
      feePayer: addresses[Math.floor(Math.random() * addresses.length)],
      // Servers copy the idle window into the 402: it is how long they have
      // to claim before an idle channel is closed at its onchain watermark.
      ...(this.maxIdleSecs > 0 ? { maxIdleSecs: this.maxIdleSecs } : {}),
      ...(this.delegatedReceiverAuth
        ? { receiverAuthorizer: this.delegatedReceiverAuth.receiverAuthorizer }
        : {}),
    };
  }

  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  getChannelStorage(): PaymentChannelStorage {
    return this.channelStorage;
  }

  createRentCleanupManager(network: Network): BatchSvmRentCleanupManager {
    return new BatchSvmRentCleanupManager({
      maxIdleSecs: this.maxIdleSecs,
      network,
      signer: this.signer,
      storage: {
        get: channelId => this.channelStorage.get(channelId),
        list: () => this.channelStorage.list(),
        upsert: record => this.channelStorage.upsert(record),
        delete: async channelId => {
          await this.channelStorage.delete(channelId);
          await this.receiverAuthorizers?.delete(network, channelId);
          await this.delegatedReceiverAuth?.identityStore.delete(network, channelId);
        },
      },
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
    if (!isBatchPayload(payload)) return verifyFailure(BatchError.PAYLOAD_TYPE, "");
    if (
      payment.accepted.scheme !== BATCH_SETTLEMENT_SCHEME ||
      requirements.scheme !== BATCH_SETTLEMENT_SCHEME
    ) {
      return verifyFailure("unsupported_scheme", payload.channelConfig.payer);
    }
    if (payment.accepted.network !== requirements.network) {
      return verifyFailure("network_mismatch", payload.channelConfig.payer);
    }

    try {
      switch (payload.type) {
        case "deposit": {
          const validated = await this.validateDeposit(payload, requirements, "exact");
          return {
            isValid: true,
            payer: payload.channelConfig.payer,
            extra: { channelId: validated.channelId },
          };
        }
        case "voucher": {
          const terms = await this.resolveTerms(
            payload.channelConfig,
            requirements,
            "requirements",
          );
          const channelId = await this.deriveChannelId(payload.channelConfig, terms.feePayer);
          if (payload.voucher.channelId !== channelId) {
            return verifyFailure(BatchError.CHANNEL_ID_MISMATCH, payload.channelConfig.payer);
          }
          const channel = await this.validateVoucherOnly(payload, requirements, terms, channelId);
          return {
            isValid: true,
            payer: payload.channelConfig.payer,
            extra: verifiedChannelExtra(channelId, channel),
          };
        }
        case "authorization": {
          const terms = await this.resolveTerms(
            payload.channelConfig,
            requirements,
            "requirements",
          );
          const channelId = await this.deriveChannelId(payload.channelConfig, terms.feePayer);
          await this.assertServerModeProof(payload, channelId, requirements, "exact");
          const channel = await this.fetchChannel(requirements.network, channelId);
          assertNotClosing(channel, channelId);
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
            extra: verifiedChannelExtra(channelId, channel),
          };
        }
        case "refund": {
          if ("amount" in payload) {
            throw new Error(
              `${BatchError.CLOSE_AMOUNT_UNSUPPORTED}: refund returns the full unused escrow`,
            );
          }
          const terms = await this.resolveTerms(
            payload.channelConfig,
            requirements,
            "requirements",
          );
          const channelId = await this.deriveChannelId(payload.channelConfig, terms.feePayer);
          const voucherSigner = voucherSignerFor(
            payload.channelConfig,
            requirements.extra ?? {},
            "payload",
          );
          if (voucherSigner === "server" && payload.voucher === undefined) {
            await assertServerModeRefundProof(payload, channelId);
            const channel = await this.fetchChannel(requirements.network, channelId);
            assertNotClosing(channel, channelId);
            this.assertClaimChannel(channel, payload.channelConfig, terms, requirements, [
              ChannelStatus.Open,
              ChannelStatus.Closing,
            ]);
            return {
              isValid: true,
              payer: payload.channelConfig.payer,
              extra: verifiedChannelExtra(channelId, channel),
            };
          }
          if (voucherSigner === "server" && payload.voucher !== undefined) {
            throw new Error(`${BatchError.VOUCHER_SIGNATURE}: invalid payer proof`);
          }
          const deps = this.sealDependencies();
          const validated = await validateRefund(deps, payload, requirements, this.config);
          return {
            isValid: true,
            payer: validated.channel.payer,
            extra: verifiedChannelExtra(validated.channelId, validated.channel),
          };
        }
      }
    } catch (error) {
      return verifyFailure(
        classifyError(error),
        payload.channelConfig.payer,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async settle(
    payment: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const payload = payment.payload;
    if (!isBatchFacilitatorPayload(payload)) {
      return settleFailure(payment.accepted.network, BatchError.PAYLOAD_TYPE, "");
    }
    try {
      switch (payload.type) {
        case "deposit":
          return await this.settleDeposit(payment, payload, requirements, context);
        case "voucher":
          return await this.settleVoucher(payment, payload, requirements);
        case "authorization":
          return await this.settleVoucher(payment, payload, requirements);
        case "refund":
          return await this.settleRefund(payment, payload, requirements, context);
        case "claim":
          return await this.settleClaims(payment, payload, requirements);
        case "settle":
          return await this.settleDistributions(payment, payload, requirements);
        case "seal":
          return await settleSeal(
            this.sealDependencies(),
            payment,
            payload,
            requirements,
            "seal",
            context,
          );
      }
    } catch (error) {
      return settleFailure(
        payment.accepted.network,
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
      const terms = await this.resolveTerms(claim.channelConfig, requirements, "payload");
      const channelId = await this.deriveChannelId(claim.channelConfig, terms.feePayer);
      if (channelId !== claim.channelId || channelId !== claim.voucher.channelId) {
        throw new Error(BatchError.CHANNEL_ID_MISMATCH);
      }
      const cumulative = await this.verifySignedVoucher(
        channelId,
        claim.voucher,
        claim.channelConfig.payerAuthorizer,
      );
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
    const payer = prepared[0]?.claim.channelConfig.payer ?? "";
    const instructions: ServerInstruction[] = [];
    const settled = await this.settleDurably({
      key: claimKey,
      network: requirements.network,
      payer,
      onCompleted: async signature => claimResponse(prepared, requirements.network, signature),
      beforePending: async () => {
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
      },
      beforeSend: async () => {
        const channels = await Promise.all(
          prepared.map(item => this.fetchChannel(requirements.network, item.channelId)),
        );
        for (let index = 0; index < prepared.length; index += 1) {
          const item = prepared[index]!;
          const channel = channels[index]!;
          assertNotClosing(channel, item.channelId);
          this.assertClaimChannel(channel, item.claim.channelConfig, item.terms, requirements, [
            ChannelStatus.Open,
          ]);
          if (item.cumulative <= channel.settlement.settled || item.cumulative > channel.deposit) {
            throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
          }
          instructions.push(
            ...buildSettleInstructions({
              channelId: item.channelId,
              voucher: {
                authorizedSigner: item.claim.channelConfig.payerAuthorizer,
                cumulativeAmount: item.cumulative,
                expiresAt: BigInt(item.expiresAt),
                signatureBase58: item.claim.voucher.signature,
              },
            }),
          );
        }
        if (this.settlementCache.isDuplicate(claimKey)) {
          return settleFailure(payment.accepted.network, CHANNEL_BUSY, payer);
        }
      },
      broadcast: () =>
        this.submitRedemption(feePayer, requirements.network, instructions, claimKey, payer),
      onReplay: signature => claimResponse(prepared, requirements.network, signature),
      postcondition: async signature => {
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
          return {
            ok: false as const,
            response: settlementPending(
              requirements.network,
              payer,
              signature,
              "claim confirmed but its channel watermark is not visible yet",
            ),
          };
        }
        this.assertRecoveredClaims(confirmed, prepared, requirements);
        return { ok: true as const, channel: confirmed };
      },
    });
    if (!("channel" in settled)) return settled;
    return claimResponse(prepared, requirements.network, settled.signature);
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
      const terms = await this.resolveTerms(entry.channelConfig, requirements, "payload");
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
      return settleFailure(payment.accepted.network, BatchError.CUMULATIVE_AMOUNT_MISMATCH, "");
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
        const swept: PreparedDistribution[] = [];
        for (const item of prepared) {
          const [escrow] = await findAssociatedTokenPda({
            mint: address(requirements.asset),
            owner: address(item.channelId),
            tokenProgram: address(item.terms.tokenProgram),
          });
          const escrowIndex = keys.indexOf(escrow);
          if (escrowIndex < 0) continue; // Already paid channel omitted from this sweep.
          swept.push(item);
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
        // A confirmed `settle` is facilitator-visible lifecycle activity for
        // every channel it paid (spec Phase 4), so it resets the idle clock
        // the abandon-close runs on. A replayed cached result is not new
        // activity and is left alone.
        await Promise.all(
          swept.map(item =>
            this.trackChannel({
              channelId: item.channelId,
              expiresAt: CLIENT_VOUCHER_EXPIRES_AT,
              network: requirements.network,
              payTo: requirements.payTo,
              tokenProgram: item.terms.tokenProgram,
            }),
          ),
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
      return settlementPending(requirements.network, "", signature, String(error));
    }
  }

  private async validateDeposit(
    payload: BatchDepositPayload,
    requirements: PaymentRequirements,
    proofBound: ProofAmountBound,
  ): Promise<ValidatedDeposit> {
    const terms = await this.resolveTerms(payload.channelConfig, requirements, "requirements");
    const deposit = parseU64(payload.deposit.amount, "deposit.amount");
    const charge = parseU64(requirements.amount, "amount");
    const channelId = await this.deriveChannelId(payload.channelConfig, terms.feePayer);
    const proof = proofOf(payload);
    let proofAmount: bigint;
    switch (proof.signer) {
      case "client": {
        // Parse before the channel check: a non-numeric amount fails first.
        proofAmount = parseU64(proof.voucher.maxClaimableAmount, "maxClaimableAmount");
        if (proof.voucher.channelId !== channelId) {
          throw new Error(`${BatchError.CHANNEL_ID_MISMATCH}: voucher channel mismatch`);
        }
        const voucherValid = await verifyVoucherSignature({
          message: encodeVoucherMessageBytes({
            channelId,
            cumulativeAmount: proofAmount,
            expiresAt: BigInt(proof.voucher.expiresAt),
          }),
          signatureBase58: proof.voucher.signature,
          signerBase58: payload.channelConfig.payerAuthorizer,
        });
        if (!voucherValid) throw new Error(`${BatchError.VOUCHER_SIGNATURE}: invalid voucher`);
        this.assertExpiry(proof.voucher.expiresAt);
        break;
      }
      case "server": {
        proofAmount = charge;
        await this.assertServerModeProof(payload, channelId, requirements, proofBound);
        break;
      }
      default: {
        const unexpected: never = proof;
        throw new Error(String(unexpected));
      }
    }
    const existing = await this.readChannel(requirements.network, channelId);
    if (existing) {
      this.assertClaimChannel(existing, payload.channelConfig, terms, requirements, [
        ChannelStatus.Open,
      ]);
      const expectedDeposit = existing.deposit + deposit;
      switch (proof.signer) {
        case "server":
          if (charge > expectedDeposit) {
            throw new Error(
              `${BatchError.CUMULATIVE_AMOUNT_MISMATCH}: charge exceeds topped-up ceiling`,
            );
          }
          break;
        case "client":
          if (proofAmount < charge || proofAmount > expectedDeposit) {
            throw new Error(
              `${BatchError.CUMULATIVE_AMOUNT_MISMATCH}: voucher exceeds topped-up ceiling`,
            );
          }
          break;
        default: {
          const unexpected: never = proof;
          throw new Error(String(unexpected));
        }
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
        proof,
        proofAmount,
        terms,
      };
    }
    switch (proof.signer) {
      case "server":
        if (charge > deposit) {
          throw new Error(`${BatchError.CUMULATIVE_AMOUNT_MISMATCH}: invalid first voucher amount`);
        }
        break;
      case "client":
        if (proofAmount !== charge || charge > deposit) {
          throw new Error(`${BatchError.CUMULATIVE_AMOUNT_MISMATCH}: invalid first voucher amount`);
        }
        break;
      default: {
        const unexpected: never = proof;
        throw new Error(String(unexpected));
      }
    }
    const open = await verifyOpenTransaction(payload.deposit.transaction, {
      authorizedSigner: payload.channelConfig.payerAuthorizer,
      expectedBindingMemo: encodeReceiverBindingMemo(terms.receiverAuthorizer),
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
      recipients: [{ bps: FULL_SPLIT_BPS, recipient: requirements.payTo }],
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
      proof,
      proofAmount,
      terms,
    };
  }

  private async settleDeposit(
    payment: PaymentPayload,
    payload: BatchDepositPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const validated = await this.validateDeposit(payload, requirements, "ceiling");
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
      return depositResponse(channelId, existing, requirements.network, "", validated.deposit);
    }
    if (this.settlementCache.isDuplicate(key)) {
      return settleFailure(
        payment.accepted.network,
        "duplicate_settlement",
        payload.channelConfig.payer,
      );
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
              splits: [{ bps: FULL_SPLIT_BPS, recipient: requirements.payTo }],
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
        expiresAt: payload.voucher?.expiresAt ?? CLIENT_VOUCHER_EXPIRES_AT,
        network: requirements.network,
        payTo: requirements.payTo,
        tokenProgram: terms.tokenProgram,
      });
      if (!validated.isTopUp) {
        const callerIdentity = await delegatedIdentityForOpen(
          this.delegatedReceiverAuth,
          terms.receiverAuthorizer,
          channelId,
          payload.channelConfig.payer,
          requirements,
          context,
        );
        await this.bindReceiverAuthorizer(
          channelId,
          requirements.network,
          terms.receiverAuthorizer,
        );
        if (callerIdentity !== undefined && this.delegatedReceiverAuth) {
          await this.delegatedReceiverAuth.identityStore.bind({
            callerIdentity,
            channelId,
            network: requirements.network,
          });
        }
      }
    } catch (error) {
      // No transaction has been broadcast. Release the channel lock so a
      // caller can safely retry once durable indexing is healthy again.
      this.settlementCache.delete(key);
      if (error instanceof BatchReceiverAuthorizerConflictError) {
        throw new Error(`${BatchError.RECEIVER_AUTHORIZER_MISMATCH}: ${error.message}`);
      }
      if (error instanceof BatchDelegatedAuthIdentityConflictError) {
        throw new Error(`${BatchError.DELEGATED_UNAUTHENTICATED}: ${error.message}`);
      }
      throw error;
    }
    const settled = await this.settleDurably({
      key,
      network: requirements.network,
      payer: payload.channelConfig.payer,
      send: async onBroadcast => {
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
      postcondition: async () => {
        const channel = await this.fetchChannel(requirements.network, channelId);
        this.assertDepositChannel(channel, validated, requirements);
        return { ok: true as const, channel };
      },
    });
    if (!("channel" in settled)) return settled;
    return depositResponse(
      channelId,
      settled.channel,
      requirements.network,
      settled.signature,
      validated.deposit,
    );
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
    return settleFailure(
      payment.accepted.network,
      BatchError.PAYLOAD_TYPE,
      payload.channelConfig.payer,
    );
  }

  private async validateVoucherOnly(
    payload: Extract<BatchPayload, { type: "voucher" }>,
    requirements: PaymentRequirements,
    terms: BatchTerms,
    channelId: string,
  ): Promise<Channel> {
    const cumulative = await this.verifySignedVoucher(
      channelId,
      payload.voucher,
      payload.channelConfig.payerAuthorizer,
    );
    const channel = await this.fetchChannel(requirements.network, channelId);
    assertNotClosing(channel, channelId);
    this.assertClaimChannel(channel, payload.channelConfig, terms, requirements, [
      ChannelStatus.Open,
    ]);
    if (cumulative > channel.deposit) throw new Error(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT);
    return channel;
  }

  private async settleRefund(
    payment: PaymentPayload,
    payload: BatchRefundPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const deps = this.sealDependencies();
    const prepared = await prepareRefund(deps, payload, requirements, this.config, context);
    const { channelId, requestClose, terms } = prepared;
    if (requestClose === undefined) {
      return settleCooperativeRefund(deps, payment, payload, requirements, prepared, context);
    }
    const key = `batch:refund:${requirements.network}:${channelId}:${requestClose}`;
    const payer = payload.channelConfig.payer;
    const closed: readonly ChannelStatus[] = [
      ChannelStatus.Closing,
      ChannelStatus.Sealed,
      ChannelStatus.Distributed,
    ];
    const settled = await this.settleDurably<Channel | undefined>({
      key,
      network: requirements.network,
      payer,
      onCompleted: async signature => {
        const observed = await this.fetchChannelUntil(
          requirements.network,
          channelId,
          channel => channel === undefined || closed.includes(channel.status),
        );
        if (observed) {
          this.assertClaimChannel(observed, payload.channelConfig, terms, requirements, closed);
          return refundResponse(channelId, observed, requirements.network, signature);
        }
        return recoveredRefundResponse(channelId, payer, requirements.network, signature);
      },
      beforeSend: async () => {
        const channel = await this.fetchChannel(requirements.network, channelId);
        this.assertClaimChannel(channel, payload.channelConfig, terms, requirements, [
          ChannelStatus.Open,
          ChannelStatus.Closing,
        ]);
        if (channel.status === ChannelStatus.Closing) {
          return refundResponse(channelId, channel, requirements.network, "");
        }
        if (this.settlementCache.isDuplicate(key)) {
          return settleFailure(payment.accepted.network, "duplicate_settlement", channel.payer);
        }
        await this.trackChannel({
          channelId,
          expiresAt: CLIENT_VOUCHER_EXPIRES_AT,
          network: requirements.network,
          payTo: requirements.payTo,
          tokenProgram: terms.tokenProgram,
        });
      },
      send: async onBroadcast => {
        try {
          // Simulated unsigned: the fee payer's signature is not what the
          // program checks here, and leaving it off keeps simulation portable
          // across signer backends that will not sign twice.
          await this.signer.simulateTransaction(requestClose, requirements.network);
          return await broadcastOpen(
            this.submissionSigner(),
            address(terms.feePayer),
            requirements.network,
            requestClose,
            undefined,
            onBroadcast,
          );
        } catch (error) {
          if (pendingSignatureOf(error) === undefined) this.settlementCache.delete(key);
          throw error;
        }
      },
      onReplay: signature =>
        recoveredRefundResponse(channelId, payer, requirements.network, signature),
      postcondition: async (signature, phase) => {
        const pendingView = phase === "pending";
        const observed = await this.fetchChannelUntil(requirements.network, channelId, channel =>
          pendingView
            ? channel === undefined || closed.includes(channel.status)
            : channel !== undefined && closed.includes(channel.status),
        );
        if (pendingView && observed === undefined) return { ok: true as const, channel: undefined };
        if (!observed) {
          return {
            ok: false as const,
            response: settlementPending(
              requirements.network,
              payer,
              signature,
              "request_close confirmed but the closing state is not visible yet",
            ),
          };
        }
        this.assertClaimChannel(observed, payload.channelConfig, terms, requirements, closed);
        return { ok: true as const, channel: observed };
      },
    });
    if (!("channel" in settled)) return settled;
    return settled.channel
      ? refundResponse(channelId, settled.channel, requirements.network, settled.signature)
      : recoveredRefundResponse(channelId, payer, requirements.network, settled.signature);
  }

  private async resolveTerms(
    config: BatchChannelConfig,
    requirements: PaymentRequirements,
    binding: VoucherModeBinding = "requirements",
  ): Promise<BatchTerms> {
    const extra = requirements.extra;
    if (!extra || (extra.paymentFlow !== undefined && extra.paymentFlow !== "authorization")) {
      throw new Error(BatchError.PAYMENT_FLOW);
    }
    const feePayer = extra.feePayer;
    if (typeof feePayer !== "string") throw new Error(BatchError.FEE_PAYER_MISMATCH);
    const feePayerSigner = this.resolveFeePayer(feePayer);
    const voucherSigner = voucherSignerFor(config, extra, binding);
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
      typeof receiverAuthorizer !== "string" ||
      receiverAuthorizer.length === 0 ||
      receiverAuthorizer !== config.receiverAuthorizer
    ) {
      throw new Error(BatchError.RECEIVER_AUTHORIZER_MISMATCH);
    }
    const tokenProgram = requireTokenProgramHint(extra, BatchError.TOKEN_PROGRAM);
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
      receiverAuthorizer,
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
    if (expiresAt !== CLIENT_VOUCHER_EXPIRES_AT) throw new Error(BatchError.VOUCHER_EXPIRY);
  }

  // Signature and expiry of a client voucher. The caller checks the channel id.
  private async verifySignedVoucher(
    channelId: string,
    voucher: Pick<BatchVoucher, "expiresAt" | "maxClaimableAmount" | "signature">,
    signerBase58: string,
  ): Promise<bigint> {
    const cumulative = parseU64(voucher.maxClaimableAmount, "maxClaimableAmount");
    this.assertExpiry(voucher.expiresAt);
    const valid = await verifyVoucherSignature({
      message: encodeVoucherMessageBytes({
        channelId,
        cumulativeAmount: cumulative,
        expiresAt: BigInt(voucher.expiresAt),
      }),
      signatureBase58: voucher.signature,
      signerBase58,
    });
    if (!valid) throw new Error(BatchError.VOUCHER_SIGNATURE);
    return cumulative;
  }

  // Completed record, pending reconcile, or a new broadcast, then the postcondition.
  // A completed signature is not marked complete again; onReplay skips that check.
  private async settleDurably<T>(args: {
    key: string;
    network: Network;
    payer: string;
    beforePending?: () => Promise<void>;
    beforeSend?: () => Promise<SettleResponse | void>;
    send?: (onBroadcast: (signature: string, wire: string) => Promise<void>) => Promise<string>;
    // Claims already broadcast inside submitRedemption, so they skip send.
    broadcast?: () => Promise<DurableBroadcastResult>;
    onCompleted?: (signature: string) => Promise<SettleResponse> | SettleResponse;
    onReplay?: (signature: string) => SettleResponse;
    postcondition: (signature: string, phase: DurablePhase) => Promise<DurableObservation<T>>;
  }): Promise<{ signature: string; channel: T } | SettleResponse> {
    const finish = async (signature: string, phase: DurablePhase) => {
      const observed = await args.postcondition(signature, phase);
      if (!observed.ok) return observed.response;
      if (phase === "completed") return { signature, channel: observed.channel };
      const incomplete = await this.completeOrPending(
        args.key,
        signature,
        args.network,
        args.payer,
      );
      return incomplete ?? { signature, channel: observed.channel };
    };
    const completed = await this.pendingStore.get(this.completedBroadcastKey(args.key));
    if (completed)
      return args.onCompleted ? args.onCompleted(completed) : finish(completed, "completed");
    if (args.beforePending) await args.beforePending();
    const pending = await this.pendingStore.get(args.key);
    if (pending) {
      const recovered = await this.reconcileBroadcast(args.key, pending, args.network, args.payer);
      if (!recovered.ok) return recovered.response;
      return finish(recovered.signature, "pending");
    }
    if (args.beforeSend) {
      const early = await args.beforeSend();
      if (early) return early;
    }
    const send = args.send;
    if (!args.broadcast && !send) throw new Error("settleDurably requires send");
    const sent = args.broadcast
      ? await args.broadcast()
      : await this.broadcastDurably(args.key, args.network, args.payer, send!);
    if (!sent.ok) return sent.response;
    if (sent.replayed && args.onReplay) return args.onReplay(sent.signature);
    return finish(sent.signature, sent.replayed ? "completed" : "broadcast");
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
      return settlementPending(
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
        // claim that merely wanted the channel's current state. Also backoff on
        // transient RPC rate limits, which are common on public devnet endpoints.
        const retry =
          attempt + 1 < CHANNEL_READ_ATTEMPTS &&
          (minContextSlot !== undefined || isTransientRpcError(error));
        if (!retry) throw error;
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
        item.claim.channelConfig,
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

  private assertServerModeProof(
    payload: Extract<BatchPayload, { type: "authorization" | "deposit" }>,
    channelId: string,
    requirements: PaymentRequirements,
    proofBound: ProofAmountBound = "exact",
  ): Promise<void> {
    return checkServerModeProof(payload, channelId, requirements, proofBound);
  }

  private assertClaimChannel(
    channel: Channel,
    config: BatchChannelConfig,
    terms: Pick<BatchTerms, "feePayer" | "withdrawDelay">,
    requirements: PaymentRequirements,
    allowedStatuses: readonly ChannelStatus[],
  ): void {
    const expectedDistributionHash = getChannelDistributionHash([
      { bps: FULL_SPLIT_BPS, recipient: requirements.payTo },
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
      splits: [{ bps: FULL_SPLIT_BPS, recipient: requirements.payTo }],
      tokenProgram: terms.tokenProgram,
    });
  }

  private sealDependencies(): SealDependencies {
    return {
      assertClaimChannel: (channel, config, terms, requirements, allowed) =>
        this.assertClaimChannel(channel, config, terms as BatchTerms, requirements, allowed),
      completeOrPending: (key, signature, network, payer) =>
        this.completeOrPending(key, signature, network, payer),
      deriveChannelId: (config, feePayer) => this.deriveChannelId(config, feePayer),
      distributeInstruction: (channelId, channel, terms, requirements) =>
        this.distributeInstruction(channelId, channel, terms as BatchTerms, requirements),
      fetchChannel: (network, channelId) => this.fetchChannel(network, channelId),
      nowSeconds: () => Math.floor(Date.now() / 1000),
      pendingStore: this.pendingStore,
      readChannel: (network, channelId) => this.readChannel(network, channelId),
      getDelegatedCallerIdentity: (network, channelId) =>
        storedDelegatedIdentity(this.delegatedReceiverAuth, network, channelId),
      isDelegatedAuthorizer: bound => isDelegatedAuthorizer(this.delegatedReceiverAuth, bound),
      resolveDelegatedIdentity: ctx => resolveDelegatedIdentity(this.delegatedReceiverAuth, ctx),
      resolveReceiverAuthorizer: (network, channelId) =>
        readReceiverAuthorizer(
          this.receiverAuthorizers,
          this.receiverBindingHistoryReader,
          network,
          channelId,
        ),
      resolveTerms: (config, requirements, binding) =>
        this.resolveTerms(config, requirements, binding ?? "requirements"),
      settlementCache: this.settlementCache,
      submitRedemption: (feePayer, network, instructions, key, payer) =>
        this.submitRedemption(feePayer, network, instructions, key, payer),
      trackChannel: record => this.trackChannel(record),
    };
  }

  /**
   * Persist the open's receiver authorizer before it is broadcast.
   *
   * Store only: the write must succeed and read back as the same key, or the
   * open is not sent. Store and an explicit history reader: a failed write
   * still allows the open, because history is the fallback at close. History
   * only: nothing is written.
   *
   * @param channelId - Channel PDA
   * @param network - CAIP-2 network the channel is opening on
   * @param receiverAuthorizer - Key carried in the open's binding memo
   */
  private async bindReceiverAuthorizer(
    channelId: string,
    network: Network,
    receiverAuthorizer: string,
  ): Promise<void> {
    const store = this.receiverAuthorizers;
    if (!store) return;
    try {
      await store.bind({ channelId, network, receiverAuthorizer });
    } catch (error) {
      if (this.receiverBindingHistoryReader) return;
      throw error;
    }
    if (this.receiverBindingHistoryReader) return;
    const stored = await store.get(network, channelId);
    if (stored?.receiverAuthorizer !== receiverAuthorizer) {
      throw new Error(
        `${BatchError.RECEIVER_BINDING_UNAVAILABLE}: receiver authorizer was not stored for ${channelId}`,
      );
    }
  }

  private trackChannel(
    record: Omit<PaymentChannelRecord, "firstSeenAt" | "lastActivityAt">,
  ): Promise<void> {
    // Every upsert is facilitator-visible activity: it resets the idle clock.
    const now = Date.now();
    return this.channelStorage.upsert({ ...record, firstSeenAt: now, lastActivityAt: now });
  }
}
