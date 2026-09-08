import type { Address, MessagePartialSigner } from "@solana/kit";
import type {
  FacilitatorContext,
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  InMemoryPendingSettlementStore,
  type PendingSettlementStore,
} from "@x402/core/facilitator";

import {
  buildDistributeInstruction,
  buildSettleAndSealInstructions,
  type ServerInstruction,
} from "../../payment-channels/onchain";
import { parseU64, verifyOpenTransaction } from "../../payment-channels/open";
import {
  encodeVoucherMessageBytes,
  signVoucher,
  verifyVoucherSignature,
} from "../../payment-channels/voucher";
import { SettlementCache } from "../../settlement-cache";
import type { FacilitatorSigningCapabilities, FacilitatorSvmSigner } from "../../signer";
import { isUptoSvmPayload, type UptoSvmPayloadV2 } from "../../types";
import {
  decodeTransactionFromPayload,
  recordPendingOrTerminal,
  transactionMessageHash,
  TransactionOnchainFailureError,
  validateSvmAddress,
} from "../../utils";
import { ErrSettlementPending } from "../../exact/facilitator/errors";
import {
  resolveTokenProgram,
  resolveUptoSvmMemo,
  resolveUptoSvmPaymentChannelConfig,
  SLOT_COMMITMENT,
  type UptoSvmPaymentChannelConfig,
} from "../shared";
import {
  broadcastOpen,
  channelExists,
  ChannelOpenConfirmationError,
  fetchAndVerifyOpenChannel,
  SettlementConfirmationTimeoutError,
  SettlementSimulationError,
  simulateOpenSettleDistribute,
  submitSettle,
  type ChannelReadPolicy,
  type UptoSvmSigner,
} from "./channel";
import {
  InMemoryUptoChannelStorage,
  type UptoChannelRecord,
  type UptoChannelStorage,
} from "./channelStorage";
import { InMemoryUptoDelegatedAuthStore, type UptoDelegatedAuthStore } from "./delegatedAuthStore";
import { assertUptoFacilitatorSigner, type UptoFacilitatorSigner } from "./signer";
import { UptoSvmRentCleanupManager } from "./rentCleanupManager";

/** Scheme-specific error returned when the settlement amount exceeds the ceiling. */
export const ERR_SETTLEMENT_EXCEEDS_AMOUNT = "invalid_upto_svm_payload_settlement_exceeds_amount";

/** Client-supplied voucher at verify / deposit settle (claim-only field). */
export const ERR_UNEXPECTED_VOUCHER = "invalid_upto_svm_payload_unexpected_voucher";

/** Deposit settle when the channel PDA already exists (one request, one open). */
export const ERR_CHANNEL_ALREADY_OPEN = "invalid_upto_svm_channel_already_open";

/**
 * Returned when the open transaction fails to broadcast, or when the
 * pre-broadcast durable channel index fails: in both cases nothing has
 * reached the chain and the deposit is safe to retry.
 */
export const ERR_CHANNEL_BROADCAST = "invalid_upto_svm_channel_broadcast";

/** `maxTimeoutSeconds` or `expiresAt` exceeds facilitator `maxChannelLifetimeSecs`. */
export const ERR_CHANNEL_LIFETIME_EXCEEDED = "invalid_upto_svm_payload_channel_lifetime_exceeded";

/** Payload `expiresAt` later than `now + maxTimeoutSeconds` (+ skew). */
export const ERR_EXPIRES_AT_MISMATCH = "invalid_upto_svm_payload_expires_at_mismatch";

/** Claim settle omitted `voucherSignature` and this facilitator has no authorizer. */
export const ERR_AUTHORIZER_NOT_CONFIGURED = "invalid_upto_svm_authorizer_not_configured";

/** Delegated claim `authorizedSigner` / `extra.receiverAuthorizer` is not this facilitator. */
export const ERR_AUTHORIZER_ADDRESS_MISMATCH = "invalid_upto_svm_authorizer_address_mismatch";

/** Delegated settle identity missing, unresolved, or not the deposit-time binding. */
export const ERR_DELEGATED_SETTLE_UNAUTHENTICATED =
  "invalid_upto_svm_delegated_settle_unauthenticated";

/** Client supplied `type`, or a delegated settle is missing `type`. */
export const ERR_PAYLOAD_TYPE = "invalid_upto_svm_payload_type";

/** Default facilitator `maxChannelLifetimeSecs` (1 hour). */
export const DEFAULT_MAX_CHANNEL_LIFETIME_SECS = 3_600;

/** Client/facilitator clock skew allowance for `expiresAt` checks. */
const EXPIRES_AT_CLOCK_SKEW_SECS = 60;

/** Context passed to {@link UptoSvmFacilitatorConfig.onStorageError}. */
export type UptoChannelStorageErrorContext = {
  channelId: string;
  phase: "verify" | "settle";
};

/** Context passed to {@link UptoSvmFacilitatorConfig.resolveCallerIdentity}. */
export type UptoDelegatedSettleContext = {
  abortSignal?: AbortSignal;
  step: "deposit" | "claim";
  channelId: string;
  network: Network;
  payer: string;
  amount: string;
  expiresAt: number;
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  facilitatorContext?: FacilitatorContext;
};

/**
 * Rejects non-integer / out-of-range operator caps at construction.
 *
 * @param name - Config field name for the error message
 * @param value - Cap value to validate (skipped when undefined)
 * @param min - Inclusive lower bound
 */
function assertLimit(name: string, value: number | undefined, min: number): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be a safe integer >= ${min}, received ${value}`);
  }
}

/** Optional configuration for the upto SVM facilitator. */
export interface UptoSvmFacilitatorConfig {
  /**
   * Channel storage for rent cleanup. Defaults to in-memory storage.
   * Inject a durable implementation for multi-process facilitators.
   */
  channelStorage?: UptoChannelStorage;
  /**
   * Called when channel storage upsert fails. Payment results are unchanged;
   * only rent-cleanup indexing is affected. Defaults to `console.warn`.
   */
  onStorageError?: (error: unknown, context: UptoChannelStorageErrorContext) => void;
  /**
   * Max channel lifetime (seconds) accepted at verify/deposit.
   * Default: {@link DEFAULT_MAX_CHANNEL_LIFETIME_SECS} (3600).
   */
  maxChannelLifetimeSecs?: number;
  /**
   * Maximum compute unit price in microlamports accepted on the open
   * transaction. The facilitator is the fee payer, so the payer chooses a
   * priority fee the facilitator pays. Clamped to the upto spec ceiling
   * (`MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS` = 5,000,000).
   *
   * Default: 5,000,000
   */
  maxPriorityFeeMicroLamports?: number;
  /**
   * Maximum compute unit limit accepted on the open transaction. Clamped to
   * the upto spec ceiling (`OPEN_MAX_COMPUTE_UNIT_LIMIT` = 400,000).
   *
   * Default: 400,000
   */
  maxComputeUnits?: number;
  /**
   * Maximum number of required signatures. Every signature adds 5,000 lamports
   * of base fee, paid by the facilitator. A typical upto open needs two
   * (payer + fee payer). The exact `{from, feePayer}` signer-set check still
   * applies independently.
   *
   * Default: unset (no additional ceiling beyond the exact signer-set rule)
   */
  maxRequiredSignatures?: number;
  /**
   * `SetComputeUnitPrice` (microlamports per compute unit) attached to
   * facilitator-submitted settlement transactions (claim, zero-charge cancel,
   * and rent cleanup via {@link UptoSvmScheme.createRentCleanupManager}).
   * `0` omits the instruction. The priority fee is charged on the requested
   * compute-unit limit, which these transactions size statically.
   *
   * Default: `DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS` (1)
   */
  computeUnitPriceMicroLamports?: number;
  /**
   * `SetComputeUnitLimit` for facilitator-submitted settlement transactions
   * (claim, zero-charge cancel, and rent-cleanup close/distribute). The
   * default (`DEFAULT_SETTLE_COMPUTE_UNIT_LIMIT` = 100k) assumes standard SPL
   * Token settlement with a single-recipient distribution; raise it for
   * compute-heavy Token-2022 extension mints (e.g. transfer hooks) or
   * unusually large distributions. Reclaim batches size themselves per
   * channel and are mint-independent, so they are not affected by this cap.
   *
   * Default: `DEFAULT_SETTLE_COMPUTE_UNIT_LIMIT` (100,000)
   */
  settleComputeUnitLimit?: number;
  /**
   * Lets a retried deposit (open) or claim (settle_and_seal + distribute)
   * settle for the same channel reconcile against an already-broadcast
   * signature instead of re-broadcasting (see {@link PendingSettlementStore}).
   * Defaults to a fresh in-memory store shared across all settle calls on
   * this scheme instance. Inject a shared, network-backed implementation
   * (e.g. Redis) for a multi-instance facilitator so a settle retry landing
   * on a different replica still reconciles correctly.
   */
  pendingSettlementStore?: PendingSettlementStore;
  /**
   * Enables facilitator-delegated receiver authorization. Advertised as
   * `/supported` `extra.receiverAuthorizer` and used to sign claim vouchers
   * when the server omits `voucherSignature`. Requires
   * {@link resolveCallerIdentity}.
   */
  authorizerSigner?: MessagePartialSigner;
  /**
   * Resolves a stable caller identity for a delegated settle. Returning
   * `undefined` (or throwing) rejects the settle. Required when
   * {@link authorizerSigner} is set.
   */
  resolveCallerIdentity?: (
    ctx: UptoDelegatedSettleContext,
  ) => Promise<string | undefined> | string | undefined;
  /**
   * Stores `channelId → caller identity` bindings written at deposit and
   * checked at claim. Defaults to {@link InMemoryUptoDelegatedAuthStore}.
   * Inject a shared implementation for a multi-replica facilitator.
   */
  delegatedAuthStore?: UptoDelegatedAuthStore;
  /**
   * Caps how many times settle re-reads a channel account that a confirmed
   * open has not made visible yet. Unset defaults to
   * `DEFAULT_CHANNEL_READ_MAX_ATTEMPTS` (6).
   */
  channelReadMaxAttempts?: number;
  /**
   * Linear backoff step in milliseconds between those re-reads: attempt N
   * waits `N * step`, totalling `step * (attempts-1) * attempts / 2`.
   * Unset defaults to `DEFAULT_CHANNEL_READ_BACKOFF_STEP_MS` (200). Raise
   * either field to widen the budget on a provider with slower replica
   * convergence.
   */
  channelReadBackoffStepMs?: number;
}

type OpenAuthFailure = {
  reason: string;
  message?: string;
  payer: string;
};

type OpenAuthContext = {
  p: UptoSvmPayloadV2;
  channelConfig: UptoSvmPaymentChannelConfig;
  feePayerSigner: UptoSvmSigner;
  maxAmount: bigint;
  tokenProgram: string;
};

/**
 * SVM facilitator for the `upto` payment scheme.
 *
 * Escrow flow: `/settle` with `payload.type === "deposit"` (or, when `type` is
 * absent, no `voucherSignature` and `requirements.amount === payload.maxAmount`)
 * deposits (broadcasts `open`); `/settle` with `type === "claim"` or a server
 * voucher claims (`settle_and_seal` + `distribute`). `/verify` is an optional
 * read-only preflight of the same static checks — it never broadcasts.
 *
 * The fee payer holds the channel `payee` seat with a zero distribution share:
 * it signs `settle_and_seal` (lifecycle authority) and can always seal an
 * abandoned channel with `has_voucher = 0` to recover its rent. Nonzero
 * settlement requires a receiver-authorizer voucher — signed by the server, or
 * by this facilitator when the server delegates and the caller identity
 * matches the deposit-time binding.
 *
 * Fee-payer selection matches the exact SVM facilitator: `getExtra` randomly
 * picks one of the configured signers so load is distributed across keys.
 */
export class UptoSvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "upto";
  readonly caipFamily = "solana:*";

  private readonly config: UptoSvmFacilitatorConfig;
  private readonly channelStorage: UptoChannelStorage;
  private readonly settlementCache = new SettlementCache();
  private readonly pendingStore: PendingSettlementStore;
  private readonly authorizerSigner: MessagePartialSigner | undefined;
  private readonly resolveCallerIdentity: UptoSvmFacilitatorConfig["resolveCallerIdentity"];
  private readonly delegatedAuthStore: UptoDelegatedAuthStore;
  private readonly signer: UptoFacilitatorSigner;

  private readonly getKitSigner: (feePayer: Address) => FacilitatorSigningCapabilities;

  /**
   * Create the upto SVM facilitator.
   *
   * @param signer - Facilitator signer (fee payers / channel rent payers /
   *   zero-share channel payees). `getExtra` randomly selects among
   *   `signer.getAddresses()`. Must expose the optional read RPC caps
   *   ({@link FacilitatorSvmSigner.getAccountInfo}, etc.) — typically via
   *   {@link toFacilitatorSvmSigner}.
   * @param config - Optional channel-storage configuration
   */
  constructor(signer: FacilitatorSvmSigner, config: UptoSvmFacilitatorConfig = {}) {
    assertLimit("maxChannelLifetimeSecs", config.maxChannelLifetimeSecs, 1);
    assertLimit("maxPriorityFeeMicroLamports", config.maxPriorityFeeMicroLamports, 0);
    assertLimit("maxComputeUnits", config.maxComputeUnits, 1);
    assertLimit("maxRequiredSignatures", config.maxRequiredSignatures, 1);
    assertLimit("computeUnitPriceMicroLamports", config.computeUnitPriceMicroLamports, 0);
    assertLimit("settleComputeUnitLimit", config.settleComputeUnitLimit, 1);
    assertUptoFacilitatorSigner(signer);
    this.signer = signer;
    this.getKitSigner = signer.getSigner.bind(signer);
    if (this.signer.getAddresses().length === 0) {
      throw new Error("UptoSvmScheme requires at least one fee payer signer");
    }
    if (config.authorizerSigner && !config.resolveCallerIdentity) {
      throw new Error("authorizerSigner requires resolveCallerIdentity");
    }
    this.config = config;
    this.channelStorage = config.channelStorage ?? new InMemoryUptoChannelStorage();
    this.pendingStore = config.pendingSettlementStore ?? new InMemoryPendingSettlementStore();
    this.authorizerSigner = config.authorizerSigner;
    this.resolveCallerIdentity = config.resolveCallerIdentity;
    this.delegatedAuthStore = config.delegatedAuthStore ?? new InMemoryUptoDelegatedAuthStore();
  }

  /**
   * Channel storage used for async rent cleanup.
   *
   * @returns The configured {@link UptoChannelStorage}
   */
  getChannelStorage(): UptoChannelStorage {
    return this.channelStorage;
  }

  /**
   * Create a {@link UptoSvmRentCleanupManager} for the given network, wired to
   * this scheme's channel storage. Does not auto-start; call
   * `manager.start(...)` or schedule `manager.cleanup()`.
   *
   * @param network - CAIP-2 network the manager should clean up
   * @param options - Optional overrides (e.g. a cleanup-only signer on a slower RPC)
   * @param options.signer - Facilitator signer for cleanup RPC (defaults to this scheme's signer)
   * @returns A rent cleanup manager for that network
   */
  createRentCleanupManager(
    network: Network,
    options?: { signer?: FacilitatorSvmSigner },
  ): UptoSvmRentCleanupManager {
    let cleanupSigner: UptoFacilitatorSigner = this.signer;
    if (options?.signer) {
      assertUptoFacilitatorSigner(options.signer, "UptoSvmRentCleanupManager");
      cleanupSigner = options.signer;
    }
    return new UptoSvmRentCleanupManager({
      computeUnitPriceMicroLamports: this.config.computeUnitPriceMicroLamports,
      network,
      settleComputeUnitLimit: this.config.settleComputeUnitLimit,
      signer: cleanupSigner,
      storage: this.channelStorage,
    });
  }

  /**
   * Advertise a randomly selected fee payer for payment-channel opens.
   * Random selection distributes load across multiple signers (same as exact).
   *
   * @param _ - The network identifier (unused)
   * @returns Extra metadata folded into the requirement's `extra`
   */
  getExtra(_: Network): Record<string, unknown> | undefined {
    const addresses = this.signer.getAddresses();
    const randomIndex = Math.floor(Math.random() * addresses.length);
    const extra: Record<string, unknown> = { feePayer: addresses[randomIndex] };
    if (this.authorizerSigner) {
      extra.receiverAuthorizer = this.authorizerSigner.address;
    }
    return extra;
  }

  /**
   * Signer addresses managed by this facilitator.
   *
   * @param _ - The network identifier (unused)
   * @returns Unique fee-payer addresses
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Read-only preflight: validate the open authorization without broadcasting.
   *
   * @param payload - The payment payload
   * @param requirements - The payment requirements (amount = ceiling)
   * @returns The verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const auth = await this.validateOpenAuthorization(payload, requirements, {
      rejectVoucher: true,
      rejectType: true,
    });
    if (!auth.ok) {
      return {
        isValid: false,
        invalidReason: auth.failure.reason,
        invalidMessage: auth.failure.message,
        payer: auth.failure.payer,
      };
    }
    return { isValid: true, invalidReason: undefined, payer: auth.ctx.p.from };
  }

  /**
   * Deposit (open channel) or claim (settle_and_seal + distribute).
   *
   * Prefers `payload.type` when present. When absent (older servers):
   * - no `voucherSignature` and `requirements.amount === payload.maxAmount` → deposit
   * - `voucherSignature` present → claim against the open channel
   * `type` is required when the settle is delegated to this facilitator.
   *
   * @param payload - The payment payload
   * @param requirements - Deposit: amount = ceiling; claim: amount = actual charge
   * @param context - Facilitator extensions (used by `resolveCallerIdentity`)
   * @returns The settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const raw = payload.payload as Record<string, unknown>;
    if (!isUptoSvmPayload(raw)) {
      return this.settleFailure(payload, "unsupported_payload_type", "");
    }
    const p: UptoSvmPayloadV2 = raw;

    if (payload.accepted.scheme !== "upto" || requirements.scheme !== "upto") {
      return this.settleFailure(payload, "unsupported_scheme", p.from);
    }
    if (payload.accepted.network !== requirements.network) {
      return this.settleFailure(payload, "network_mismatch", p.from);
    }

    let actual: bigint;
    let payloadMaxAmount: bigint;
    try {
      actual = BigInt(requirements.amount);
      payloadMaxAmount = BigInt(p.maxAmount);
    } catch {
      return this.settleFailure(payload, "invalid_upto_svm_payload_amount", p.from);
    }
    if (actual < 0n) {
      return this.settleFailure(payload, "invalid_upto_svm_payload_amount", p.from);
    }
    if (actual > payloadMaxAmount) {
      return this.settleFailure(payload, ERR_SETTLEMENT_EXCEEDS_AMOUNT, p.from);
    }

    const delegated = this.isDelegatedSettle(requirements);
    if (p.type === "deposit") {
      return this.settleDeposit(payload, requirements, p, context);
    }
    if (p.type === "claim") {
      return this.settleClaim(payload, requirements, p, actual, payloadMaxAmount, context);
    }
    if (delegated) {
      return this.settleFailure(payload, ERR_PAYLOAD_TYPE, p.from);
    }

    const hasVoucher = Object.prototype.hasOwnProperty.call(raw, "voucherSignature");
    if (hasVoucher) {
      return this.settleClaim(payload, requirements, p, actual, payloadMaxAmount, context);
    }
    if (actual === payloadMaxAmount) {
      return this.settleDeposit(payload, requirements, p, context);
    }
    return this.settleFailure(payload, "invalid_upto_svm_payload_missing_voucher", p.from);
  }

  /**
   * Re-awaits confirmation of a signature previously recorded in the
   * `PendingSettlementStore` under `pendingKey`, without re-verifying,
   * re-signing, or re-broadcasting. Re-broadcasting is not a safe fallback
   * here: the deposit's channel PDA is one-shot (a second open would hit
   * `ERR_CHANNEL_ALREADY_OPEN`) and a claim seals the channel (a second
   * claim attempt would fail the "channel is not open" check) — either of
   * which would misreport an already-successful payment as failed. Mirrors
   * Go's `awaitPendingUptoSignature`.
   *
   * @param pendingKey - The pending-settlement store key for this deposit/claim
   * @param dedupKey - The settlementCache dedup key to release on terminal failure;
   *   for claim this equals pendingKey, but for deposit it's channel-scoped while
   *   pendingKey is bound to the exact open transaction bytes
   * @param signature - The previously broadcast signature to re-await
   * @param payer - Payer address for the response
   * @param network - The network the transaction was broadcast to
   * @returns `{ ok: true }` on confirmation (store entry cleared), or
   *   `{ ok: false, response }` with a `settlement_pending` (non-terminal) or
   *   `transaction_failed` (terminal) response to surface
   */
  private async awaitPendingUptoSignature(
    pendingKey: string,
    dedupKey: string,
    signature: string,
    payer: string,
    network: PaymentRequirements["network"],
  ): Promise<{ ok: true } | { ok: false; response: SettleResponse }> {
    try {
      await this.signer.confirmTransaction(signature, network);
    } catch (error) {
      if (error instanceof TransactionOnchainFailureError) {
        // Definite onchain rejection: release the dedup lock set by the
        // original call so a fresh attempt for this channel isn't blocked.
        this.settlementCache.delete(dedupKey);
        return {
          ok: false,
          response: {
            success: false,
            errorReason: "transaction_failed",
            errorMessage: error.message,
            transaction: signature,
            network,
            payer,
          },
        };
      }
      return {
        ok: false,
        response: await recordPendingOrTerminal(
          this.pendingStore,
          pendingKey,
          signature,
          payer,
          network,
          ErrSettlementPending,
          "transaction_failed",
          error,
        ),
      };
    }
    try {
      await this.pendingStore.delete(pendingKey);
    } catch {
      // Best-effort cleanup; the confirmed settlement is correct regardless
      // and must not be masked by a storage hiccup.
    }
    return { ok: true };
  }

  /**
   * Builds the channel-account re-read policy from configured overrides.
   *
   * @returns Unresolved policy; {@link fetchAndVerifyOpenChannel} fills defaults
   */
  private resolveChannelReadPolicy(): ChannelReadPolicy {
    return {
      maxAttempts: this.config.channelReadMaxAttempts,
      backoffStepMs: this.config.channelReadBackoffStepMs,
    };
  }

  /**
   * Deposit path: validate open authorization, then sim → broadcast → bind.
   * Rejects when the channel already exists (one request, one open).
   *
   * @param payload - The payment payload
   * @param requirements - Requirements with amount = authorized ceiling
   * @param p - Typed upto payload (channelId is needed before open validation)
   * @param context - Facilitator extensions (used by `resolveCallerIdentity`)
   * @returns Deposit settlement response
   */
  private async settleDeposit(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    p: UptoSvmPayloadV2,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const delegated = this.isDelegatedSettle(requirements);
    let depositIdentity: string | undefined;
    if (delegated) {
      depositIdentity = await this.resolveDelegatedCallerIdentity({
        step: "deposit",
        channelId: p.channelId,
        network: requirements.network,
        payer: p.from,
        amount: requirements.amount,
        expiresAt: p.expiresAt,
        payload,
        requirements,
        facilitatorContext: context,
      });
      if (!depositIdentity) {
        return this.settleFailure(payload, ERR_DELEGATED_SETTLE_UNAUTHENTICATED, p.from);
      }
    }

    // settlementCache dedup key: channel-scoped (not tied to exact transaction
    // bytes) so concurrent settles for the same channel with differently-signed
    // opens are still caught (see the race comment below).
    const depositChannelKey = `upto:deposit:${requirements.network}:${p.channelId}`;

    // Pending-settlement fast path: a prior deposit settle for this exact open
    // transaction broadcast successfully but couldn't confirm in time. Reconcile
    // against that signature instead of re-broadcasting (a second open would hit
    // ERR_CHANNEL_ALREADY_OPEN). Keyed on the message hash, not just channelId,
    // so a differently-shaped retry (e.g. mismatched deposit amount) falls
    // through to full validation instead of trusting a stale signature. Mirrors
    // `exact`'s txKey.
    let depositKey: string | undefined;
    try {
      depositKey = `upto:deposit:${requirements.network}:${transactionMessageHash(
        decodeTransactionFromPayload({ transaction: p.openTransaction }),
      )}`;
    } catch {
      depositKey = undefined;
    }

    if (depositKey) {
      const cachedDepositSignature = await this.pendingStore.get(depositKey);
      if (cachedDepositSignature) {
        // Remove before reconciling (rather than after) so a concurrent retry
        // of the same payload misses here instead of also reconciling: it
        // falls through to the settlementCache dedup check, which
        // independently rejects it as a duplicate.
        await this.pendingStore.delete(depositKey);
        const pending = await this.awaitPendingUptoSignature(
          depositKey,
          depositChannelKey,
          cachedDepositSignature,
          p.from,
          payload.accepted.network,
        );
        if (!pending.ok) {
          return pending.response;
        }
        return {
          success: true,
          transaction: cachedDepositSignature,
          network: requirements.network,
          amount: p.maxAmount,
          payer: p.from,
        };
      }
    }

    const auth = await this.validateOpenAuthorization(payload, requirements, {
      rejectVoucher: true,
    });
    if (!auth.ok) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: auth.failure.reason,
        errorMessage: auth.failure.message,
        payer: auth.failure.payer,
      };
    }

    const { channelConfig, feePayerSigner, maxAmount, tokenProgram } = auth.ctx;
    const feePayer = channelConfig.feePayer;
    const network = requirements.network;

    // One authorization → one deposit open. A confirmed channel is replay or a
    // stranded prior open, not a supported re-bind path; handler failure after
    // a successful deposit uses the zero-amount cancel/refund settle instead.
    if (await channelExists(this.signer, network, p.channelId)) {
      return this.settleFailure(payload, ERR_CHANNEL_ALREADY_OPEN, p.from);
    }

    // Race: two deposit settles can both see "channel missing", broadcast the
    // same open, and both get success back from RPC. Dedup here so only one
    // proceeds. Key is deposit-scoped so this does not block the later claim.
    if (this.settlementCache.isDuplicate(depositChannelKey)) {
      return this.settleFailure(payload, "duplicate_settlement", p.from);
    }

    // Decoding succeeded above (validateOpenAuthorization), so this recompute
    // (only needed if the earlier attempt above failed) can't throw.
    depositKey ??= `upto:deposit:${requirements.network}:${transactionMessageHash(
      decodeTransactionFromPayload({ transaction: p.openTransaction }),
    )}`;

    // Simulate open + settle + distribute before broadcast so settlement-account
    // failures reject without locking the deposit.
    try {
      await simulateOpenSettleDistribute(feePayerSigner, this.signer, network, {
        openTransactionBase64: p.openTransaction,
        channel: {
          channelId: p.channelId,
          mint: requirements.asset,
          network,
          payee: feePayer,
          payer: p.from,
          rentPayer: feePayer,
          splits: channelConfig.splits,
          tokenProgram,
        },
      });
    } catch (error) {
      this.settlementCache.delete(depositChannelKey);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_settlement_simulation",
        errorMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
    }

    // Indexed before broadcast, and the index must succeed before broadcast:
    // an open that reaches the chain without a durable record can never be
    // found by rent cleanup, permanently stranding the facilitator's rent.
    // Nothing has been broadcast yet, so failing here is safe to retry.
    try {
      await this.upsertChannelStorageOrFail({
        channelId: p.channelId,
        network: requirements.network,
        payTo: requirements.payTo,
        tokenProgram,
        expiresAt: p.expiresAt,
      });
      if (delegated && depositIdentity) {
        await this.delegatedAuthStore.bind({
          channelId: p.channelId,
          network: requirements.network,
          callerIdentity: depositIdentity,
          expiresAt: p.expiresAt,
        });
      }
    } catch (error) {
      this.settlementCache.delete(depositChannelKey);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: ERR_CHANNEL_BROADCAST,
        errorMessage: `failed to durably record the channel before broadcast: ${
          error instanceof Error ? error.message : String(error)
        }`,
        payer: p.from,
      };
    }

    let openSignature: string;
    try {
      openSignature = await broadcastOpen(
        this.signer,
        feePayer as Address,
        requirements.network,
        p.openTransaction,
      );
    } catch (error) {
      // A ChannelOpenConfirmationError means the open broadcast successfully
      // but confirmation couldn't be observed in time: leave the deposit dedup
      // lock in place (a fresh broadcast would double-open) and record the
      // signature so a retry reconciles via the fast path above instead of
      // re-validating.
      if (error instanceof ChannelOpenConfirmationError) {
        return recordPendingOrTerminal(
          this.pendingStore,
          depositKey,
          error.signature,
          p.from,
          payload.accepted.network,
          ErrSettlementPending,
          ERR_CHANNEL_BROADCAST,
          error,
        );
      }
      this.settlementCache.delete(depositChannelKey);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: ERR_CHANNEL_BROADCAST,
        errorMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
    }

    try {
      await fetchAndVerifyOpenChannel(
        this.signer,
        network,
        p.channelId,
        {
          authorizedSigner: channelConfig.receiverAuthorizer,
          deposit: maxAmount,
          gracePeriod: channelConfig.withdrawDelay,
          mint: requirements.asset,
          payee: feePayer,
          payer: p.from,
          rentPayer: feePayer,
          splits: channelConfig.splits,
        },
        this.resolveChannelReadPolicy(),
      );
    } catch (error) {
      this.settlementCache.delete(depositChannelKey);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_channel_state",
        errorMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
    }

    try {
      await this.pendingStore.delete(depositKey);
    } catch {
      // Best-effort cleanup; the confirmed deposit is correct regardless and
      // must not be masked by a storage hiccup.
    }
    return {
      success: true,
      transaction: openSignature,
      network: requirements.network,
      amount: maxAmount.toString(),
      payer: p.from,
    };
  }

  /**
   * Claim path: re-bind the open channel, verify or produce the voucher, then
   * settle_and_seal + distribute.
   *
   * @param payload - The payment payload
   * @param requirements - Requirements with amount = actual charge
   * @param p - Typed upto payload
   * @param actual - Actual charge in atomic units
   * @param payloadMaxAmount - Signed ceiling from the payload
   * @param context - Facilitator extensions (used by `resolveCallerIdentity`)
   * @returns Claim settlement response
   */
  private async settleClaim(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    p: UptoSvmPayloadV2,
    actual: bigint,
    payloadMaxAmount: bigint,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const hasVoucher = typeof p.voucherSignature === "string" && p.voucherSignature.length > 0;
    if (!hasVoucher) {
      const unauthenticated = await this.authenticateDelegatedClaim(
        payload,
        requirements,
        p,
        context,
      );
      if (unauthenticated) return unauthenticated;
    }

    // Pending-settlement fast path: a prior claim settle for this exact
    // channel broadcast settle_and_seal + distribute successfully but
    // couldn't confirm it in time. Reconcile against that signature instead
    // of re-verifying and re-submitting — the channel is sealed by a
    // successful settle_and_seal, so a second claim attempt would fail
    // fetchAndVerifyOpenChannel's "channel is not open" check even though
    // the original payment succeeded.
    const settlementKey = `upto:${requirements.network}:${p.channelId}`;
    const cachedClaimSignature = await this.pendingStore.get(settlementKey);
    if (cachedClaimSignature) {
      // Remove before reconciling (rather than after) so a concurrent retry
      // of the same payload misses here instead of also reconciling: it
      // falls through to the settlementCache dedup check, which
      // independently rejects it as a duplicate.
      await this.pendingStore.delete(settlementKey);
      const pending = await this.awaitPendingUptoSignature(
        settlementKey,
        settlementKey,
        cachedClaimSignature,
        p.from,
        payload.accepted.network,
      );
      if (!pending.ok) {
        return pending.response;
      }
      try {
        await this.delegatedAuthStore.delete(p.channelId, requirements.network);
      } catch {
        // Best-effort; settlement is already confirmed.
      }
      return {
        success: true,
        transaction: cachedClaimSignature,
        network: requirements.network,
        amount: actual.toString(),
        payer: p.from,
      };
    }

    let channelConfig: UptoSvmPaymentChannelConfig;
    try {
      channelConfig = resolveUptoSvmPaymentChannelConfig(requirements);
    } catch (error) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payment_requirements",
        errorMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
    }

    if (p.authorizedSigner !== channelConfig.receiverAuthorizer) {
      return this.settleFailure(payload, "invalid_upto_svm_payload_receiver_authorizer", p.from);
    }

    const feePayerSigner = this.resolveFeePayer(channelConfig.feePayer);
    if (!feePayerSigner) {
      return this.settleFailure(payload, "facilitator_mismatch", p.from);
    }

    const now = Math.floor(Date.now() / 1000);
    if (now < p.validAfter) {
      return this.settleFailure(payload, "invalid_upto_svm_payload_not_yet_active", p.from);
    }
    if (p.expiresAt === 0 || now >= p.expiresAt) {
      return this.settleFailure(payload, "invalid_upto_svm_payload_expired", p.from);
    }

    const expiresAt = BigInt(p.expiresAt);
    let voucherSignature = p.voucherSignature;
    if (hasVoucher) {
      const voucherMessage = encodeVoucherMessageBytes({
        channelId: p.channelId,
        cumulativeAmount: actual,
        expiresAt,
      });
      let voucherOk: boolean;
      try {
        voucherOk = await verifyVoucherSignature({
          message: voucherMessage,
          signatureBase58: p.voucherSignature as string,
          signerBase58: p.authorizedSigner,
        });
      } catch {
        return this.settleFailure(payload, "invalid_upto_svm_payload_voucher_signature", p.from);
      }
      if (!voucherOk) {
        return this.settleFailure(payload, "invalid_upto_svm_payload_voucher_signature", p.from);
      }
    }

    let tokenProgram: string;
    try {
      tokenProgram = resolveTokenProgram(requirements);
    } catch {
      return this.settleFailure(payload, "invalid_upto_svm_payment_requirements", p.from);
    }
    const network = requirements.network;

    const channelPromise = fetchAndVerifyOpenChannel(
      this.signer,
      network,
      p.channelId,
      {
        authorizedSigner: channelConfig.receiverAuthorizer,
        deposit: payloadMaxAmount,
        gracePeriod: channelConfig.withdrawDelay,
        mint: requirements.asset,
        payee: channelConfig.feePayer,
        payer: p.from,
        rentPayer: channelConfig.feePayer,
        splits: channelConfig.splits,
      },
      this.resolveChannelReadPolicy(),
    );
    const blockhashPromise = this.signer.getLatestBlockhash(network);

    let channel: Awaited<ReturnType<typeof fetchAndVerifyOpenChannel>>;
    let prefetchedBlockhash: { blockhash: string; lastValidBlockHeight: bigint };
    try {
      [channel, prefetchedBlockhash] = await Promise.all([channelPromise, blockhashPromise]);
    } catch (error) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_channel_state",
        errorMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
    }

    if (!hasVoucher) {
      const authorizerSigner = this.authorizerSigner;
      if (!authorizerSigner || channel.authorizedSigner !== authorizerSigner.address) {
        return this.settleFailure(payload, ERR_AUTHORIZER_ADDRESS_MISMATCH, p.from);
      }
      voucherSignature = await signVoucher(authorizerSigner, {
        channelId: p.channelId,
        cumulativeAmount: actual,
        expiresAt,
      });
    }

    // Claim only after the open channel is rebound. Concurrent or replayed
    // settles for the same channel — including different valid amounts /
    // vouchers — must fail after the first claim so only one settle_and_seal +
    // distribute is submitted. Failures above (invalid voucher / not open) do
    // not insert into the cache.
    if (this.settlementCache.isDuplicate(settlementKey)) {
      return this.settleFailure(payload, "duplicate_settlement", p.from);
    }

    try {
      // Program requires settled < cumulative_amount, so has_voucher only when actual > 0.
      // The zero-amount voucher still authenticated the settle request above.
      const settle = buildSettleAndSealInstructions({
        channelId: channel.channelId,
        payeeSigner: feePayerSigner,
        voucher:
          actual > 0n
            ? {
                authorizedSigner: channel.authorizedSigner,
                cumulativeAmount: actual,
                expiresAt,
                signatureBase58: voucherSignature as string,
              }
            : undefined,
      });

      const distribute = await buildDistributeInstruction({
        channelId: channel.channelId,
        mint: channel.mint,
        network,
        payee: channel.payee,
        payer: channel.payer,
        rentPayer: channel.rentPayer,
        splits: channel.splits,
        tokenProgram,
      });

      const instructions: ServerInstruction[] = [...settle, distribute];
      const signature = await submitSettle(feePayerSigner, this.signer, network, instructions, {
        computeUnitLimit: this.config.settleComputeUnitLimit,
        computeUnitPriceMicroLamports: this.config.computeUnitPriceMicroLamports,
        latestBlockhash: prefetchedBlockhash,
      });

      // Settlement is confirmed onchain past this point; storage is cleanup
      // bookkeeping and must never turn a charged payment into a failure.
      await this.upsertChannelStorage("settle", {
        channelId: channel.channelId,
        network,
        payTo: requirements.payTo,
        tokenProgram,
        expiresAt: p.expiresAt,
      });

      try {
        await this.pendingStore.delete(settlementKey);
      } catch {
        // Best-effort cleanup, per the comment above: settlement is already
        // confirmed onchain and must not be masked by a storage hiccup.
      }
      try {
        await this.delegatedAuthStore.delete(channel.channelId, network);
      } catch {
        // Best-effort; settlement is already confirmed.
      }
      return {
        success: true,
        transaction: signature,
        network,
        amount: actual.toString(),
        payer: channel.payer,
      };
    } catch (error) {
      if (error instanceof SettlementSimulationError) {
        this.settlementCache.delete(settlementKey);
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "invalid_upto_svm_settlement_simulation",
          errorMessage: error.message,
          payer: p.from,
        };
      }
      // A confirmation timeout leaves the transaction's fate unknown, not
      // failed: it may still land. The dedup entry is kept, not deleted, so
      // a caller retrying this claim cannot race a second settle_and_seal
      // against the first while the outcome is still unresolved. The
      // broadcast signature is recorded so that retry reconciles via the
      // fast path above instead of re-verifying/re-submitting.
      if (error instanceof SettlementConfirmationTimeoutError) {
        return recordPendingOrTerminal(
          this.pendingStore,
          settlementKey,
          error.signature,
          p.from,
          payload.accepted.network,
          ErrSettlementPending,
          "transaction_failed",
          error,
        );
      }
      this.settlementCache.delete(settlementKey);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "transaction_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
    }
  }

  /**
   * Static open-authorization checks shared by verify and deposit settle.
   * Never broadcasts or mutates chain state.
   *
   * @param payload - The payment payload
   * @param requirements - Payment requirements (amount must equal ceiling)
   * @param options - Validation options
   * @param options.rejectVoucher - Reject payloads that include `voucherSignature`
   * @param options.rejectType - Reject payloads that include `type` (client-owned verify)
   * @returns Open auth context or a structured failure
   */
  private async validateOpenAuthorization(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    options: { rejectVoucher: boolean; rejectType?: boolean },
  ): Promise<{ ok: true; ctx: OpenAuthContext } | { ok: false; failure: OpenAuthFailure }> {
    const raw = payload.payload as Record<string, unknown>;
    if (!isUptoSvmPayload(raw)) {
      return {
        ok: false,
        failure: { reason: "unsupported_payload_type", payer: "" },
      };
    }
    const p: UptoSvmPayloadV2 = raw;

    if (payload.accepted.scheme !== "upto" || requirements.scheme !== "upto") {
      return { ok: false, failure: { reason: "unsupported_scheme", payer: p.from } };
    }
    if (payload.accepted.network !== requirements.network) {
      return { ok: false, failure: { reason: "network_mismatch", payer: p.from } };
    }

    // `voucherSignature` is server-owned and claim-only. Reject on presence, not
    // on value: core's additive-enrichment policy keys off hasOwnProperty, so a
    // client-set key (even "" or undefined) blocks the real voucher at claim.
    if (options.rejectVoucher && Object.prototype.hasOwnProperty.call(raw, "voucherSignature")) {
      return { ok: false, failure: { reason: ERR_UNEXPECTED_VOUCHER, payer: p.from } };
    }
    if (options.rejectType && Object.prototype.hasOwnProperty.call(raw, "type")) {
      return { ok: false, failure: { reason: ERR_PAYLOAD_TYPE, payer: p.from } };
    }

    let channelConfig: UptoSvmPaymentChannelConfig;
    try {
      channelConfig = resolveUptoSvmPaymentChannelConfig(requirements);
    } catch (error) {
      return {
        ok: false,
        failure: {
          reason: "invalid_upto_svm_payment_requirements",
          message: error instanceof Error ? error.message : String(error),
          payer: p.from,
        },
      };
    }

    const feePayer = channelConfig.feePayer;
    const feePayerSigner = this.resolveFeePayer(feePayer);
    if (!feePayerSigner) {
      return { ok: false, failure: { reason: "facilitator_mismatch", payer: p.from } };
    }
    const receiverAuthorizer = channelConfig.receiverAuthorizer;
    if (p.authorizedSigner !== receiverAuthorizer) {
      return {
        ok: false,
        failure: { reason: "invalid_upto_svm_payload_receiver_authorizer", payer: p.from },
      };
    }

    let maxAmount: bigint;
    let deposit: bigint;
    let requiredAmount: bigint;
    try {
      maxAmount = BigInt(p.maxAmount);
      deposit = BigInt(p.deposit);
      requiredAmount = BigInt(requirements.amount);
    } catch {
      return {
        ok: false,
        failure: { reason: "invalid_upto_svm_payload_amount", payer: p.from },
      };
    }
    if (maxAmount !== requiredAmount) {
      return {
        ok: false,
        failure: { reason: "invalid_upto_svm_payload_amount_mismatch", payer: p.from },
      };
    }
    if (deposit !== maxAmount) {
      return {
        ok: false,
        failure: { reason: "invalid_upto_svm_payload_deposit_not_ceiling", payer: p.from },
      };
    }

    const network = requirements.network;
    let openSlot: bigint;
    let recentSlot: bigint;
    let nonce: bigint;
    try {
      openSlot = parseU64(p.openSlot, "payload.openSlot");
      nonce = parseU64(p.nonce, "payload.nonce");
      if (requirements.extra?.recentSlot !== undefined && requirements.extra?.recentSlot !== null) {
        recentSlot = parseU64(
          requirements.extra.recentSlot as bigint | number | string,
          "requirements.extra.recentSlot",
        );
      } else {
        recentSlot = await this.signer.getSlot(network, SLOT_COMMITMENT);
      }
    } catch {
      return {
        ok: false,
        failure: { reason: "invalid_upto_svm_payload_channel_seed", payer: p.from },
      };
    }

    const now = Math.floor(Date.now() / 1000);
    if (now < p.validAfter) {
      return {
        ok: false,
        failure: { reason: "invalid_upto_svm_payload_not_yet_active", payer: p.from },
      };
    }
    if (p.expiresAt === 0 || now >= p.expiresAt) {
      return {
        ok: false,
        failure: { reason: "invalid_upto_svm_payload_expired", payer: p.from },
      };
    }

    const maxTimeoutSeconds = requirements.maxTimeoutSeconds;
    if (!Number.isSafeInteger(maxTimeoutSeconds) || maxTimeoutSeconds < 1) {
      return {
        ok: false,
        failure: {
          reason: "invalid_upto_svm_payment_requirements",
          message: `maxTimeoutSeconds must be a safe integer >= 1, received ${maxTimeoutSeconds}`,
          payer: p.from,
        },
      };
    }
    const maxChannelLifetimeSecs =
      this.config.maxChannelLifetimeSecs ?? DEFAULT_MAX_CHANNEL_LIFETIME_SECS;
    if (maxTimeoutSeconds > maxChannelLifetimeSecs) {
      return {
        ok: false,
        failure: {
          reason: ERR_CHANNEL_LIFETIME_EXCEEDED,
          message:
            `maxTimeoutSeconds ${maxTimeoutSeconds} exceeds maxChannelLifetimeSecs ` +
            `${maxChannelLifetimeSecs}`,
          payer: p.from,
        },
      };
    }
    if (p.expiresAt > now + maxChannelLifetimeSecs + EXPIRES_AT_CLOCK_SKEW_SECS) {
      return {
        ok: false,
        failure: {
          reason: ERR_CHANNEL_LIFETIME_EXCEEDED,
          message:
            `expiresAt remaining ${p.expiresAt - now}s exceeds maxChannelLifetimeSecs ` +
            `${maxChannelLifetimeSecs}`,
          payer: p.from,
        },
      };
    }
    if (p.expiresAt > now + maxTimeoutSeconds + EXPIRES_AT_CLOCK_SKEW_SECS) {
      return {
        ok: false,
        failure: {
          reason: ERR_EXPIRES_AT_MISMATCH,
          message:
            `expiresAt ${p.expiresAt} exceeds now + maxTimeoutSeconds ` +
            `(${now + maxTimeoutSeconds})`,
          payer: p.from,
        },
      };
    }

    // Reject unusable addresses here rather than letting them fail as an opaque
    // open-transaction mismatch, so the payer learns which field is wrong.
    if (!validateSvmAddress(p.from)) {
      return {
        ok: false,
        failure: {
          reason: "invalid_upto_svm_payload_payer_mismatch",
          message: `payload.from ${p.from} is not a valid address`,
          payer: p.from,
        },
      };
    }
    if (!validateSvmAddress(requirements.asset)) {
      return {
        ok: false,
        failure: {
          reason: "invalid_upto_svm_payment_requirements",
          message: `requirements.asset ${requirements.asset} is not a valid mint address`,
          payer: p.from,
        },
      };
    }
    // Checked after the fee-payer and receiver-authorizer identity comparisons
    // above: a mismatch is the more specific answer, and a malformed value only
    // matters once it is the value this facilitator would have signed against.
    for (const [field, value] of [
      ["feePayer", feePayer],
      ["receiverAuthorizer", receiverAuthorizer],
    ] as const) {
      if (!validateSvmAddress(value)) {
        return {
          ok: false,
          failure: {
            reason: "invalid_upto_svm_payment_requirements",
            message: `extra.${field} ${value} is not a valid address`,
            payer: p.from,
          },
        };
      }
    }

    let tokenProgram: string;
    try {
      tokenProgram = resolveTokenProgram(requirements);
    } catch (error) {
      return {
        ok: false,
        failure: {
          reason: "invalid_upto_svm_payment_requirements",
          message: error instanceof Error ? error.message : String(error),
          payer: p.from,
        },
      };
    }

    try {
      const open = await verifyOpenTransaction(p.openTransaction, {
        authorizedSigner: receiverAuthorizer,
        feePayer,
        from: p.from,
        maxCap: maxAmount,
        maxComputeUnits: this.config.maxComputeUnits,
        maxPriorityFeeMicroLamports: this.config.maxPriorityFeeMicroLamports,
        maxRequiredSignatures: this.config.maxRequiredSignatures,
        memo: resolveUptoSvmMemo(requirements.extra),
        mint: requirements.asset,
        openSlot,
        payee: feePayer,
        recentSlot,
        recipients: channelConfig.splits,
        tokenProgram,
        withdrawDelay: channelConfig.withdrawDelay,
      });
      if (open.channelId !== p.channelId) {
        return {
          ok: false,
          failure: {
            reason: "invalid_upto_svm_payload_channel_id",
            message: `open channel ${open.channelId} != payload.channelId ${p.channelId}`,
            payer: p.from,
          },
        };
      }
      if (open.salt !== nonce) {
        return {
          ok: false,
          failure: {
            reason: "invalid_upto_svm_payload_nonce",
            message: `open salt ${open.salt} != payload.nonce ${p.nonce}`,
            payer: p.from,
          },
        };
      }
      // Bind the channel payer to `payload.from`: settlement builds the
      // distribute (refund) instruction from `p.from`, so a mismatch with the
      // open transaction's payer would make settlement fail onchain.
      if (open.payer !== p.from) {
        return {
          ok: false,
          failure: {
            reason: "invalid_upto_svm_payload_payer_mismatch",
            message: `open payer ${open.payer} != payload.from ${p.from}`,
            payer: p.from,
          },
        };
      }
    } catch (error) {
      return {
        ok: false,
        failure: {
          reason: "invalid_upto_svm_payload_open_transaction",
          message: error instanceof Error ? error.message : String(error),
          payer: p.from,
        },
      };
    }

    return {
      ok: true,
      ctx: { p, channelConfig, feePayerSigner, maxAmount, tokenProgram },
    };
  }

  /**
   * Build a failed settle response.
   *
   * @param payload - Payment payload (for network)
   * @param errorReason - Error reason code
   * @param payer - Payer address when known
   * @returns Failed settle response
   */
  private settleFailure(
    payload: PaymentPayload,
    errorReason: string,
    payer: string,
  ): SettleResponse {
    return {
      success: false,
      network: payload.accepted.network,
      transaction: "",
      errorReason,
      payer,
    };
  }

  /**
   * Whether this settle's `extra.receiverAuthorizer` is this facilitator's
   * advertised authorizer.
   *
   * @param requirements - Payment requirements for the settle
   * @returns True when this facilitator is the delegated receiver authorizer
   */
  private isDelegatedSettle(requirements: PaymentRequirements): boolean {
    const advertised = requirements.extra?.receiverAuthorizer;
    return (
      this.authorizerSigner !== undefined &&
      typeof advertised === "string" &&
      advertised === this.authorizerSigner.address
    );
  }

  /**
   * Resolve a delegated settle's caller identity. Throws and empty/missing
   * results are treated as unauthenticated.
   *
   * @param ctx - Settle context passed to the operator resolver
   * @returns Stable identity, or undefined when the caller is unauthenticated
   */
  private async resolveDelegatedCallerIdentity(
    ctx: UptoDelegatedSettleContext,
  ): Promise<string | undefined> {
    if (!this.resolveCallerIdentity) return undefined;
    try {
      const identity = await this.resolveCallerIdentity(ctx);
      if (typeof identity !== "string" || identity.length === 0) return undefined;
      return identity;
    } catch {
      return undefined;
    }
  }

  /**
   * Authenticate a delegated claim that omitted `voucherSignature`.
   * Runs before the pending-settlement fast path and any RPC.
   *
   * @param payload - The payment payload
   * @param requirements - Claim requirements
   * @param p - Typed upto payload
   * @param context - Facilitator extensions
   * @returns A failure response, or undefined when the caller matches the binding
   */
  private async authenticateDelegatedClaim(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    p: UptoSvmPayloadV2,
    context?: FacilitatorContext,
  ): Promise<SettleResponse | undefined> {
    const authorizerSigner = this.authorizerSigner;
    if (!authorizerSigner) {
      return this.settleFailure(payload, ERR_AUTHORIZER_NOT_CONFIGURED, p.from);
    }
    const extraAuthorizer = requirements.extra?.receiverAuthorizer;
    if (
      typeof extraAuthorizer !== "string" ||
      p.authorizedSigner !== extraAuthorizer ||
      extraAuthorizer !== authorizerSigner.address
    ) {
      return this.settleFailure(payload, ERR_AUTHORIZER_ADDRESS_MISMATCH, p.from);
    }

    const identity = await this.resolveDelegatedCallerIdentity({
      step: "claim",
      channelId: p.channelId,
      network: requirements.network,
      payer: p.from,
      amount: requirements.amount,
      expiresAt: p.expiresAt,
      payload,
      requirements,
      facilitatorContext: context,
    });
    if (!identity) {
      return this.settleFailure(payload, ERR_DELEGATED_SETTLE_UNAUTHENTICATED, p.from);
    }
    let binding: Awaited<ReturnType<UptoDelegatedAuthStore["get"]>>;
    try {
      binding = await this.delegatedAuthStore.get(p.channelId, requirements.network);
    } catch {
      return this.settleFailure(payload, ERR_DELEGATED_SETTLE_UNAUTHENTICATED, p.from);
    }
    if (!binding || binding.callerIdentity !== identity) {
      return this.settleFailure(payload, ERR_DELEGATED_SETTLE_UNAUTHENTICATED, p.from);
    }
  }

  /**
   * Resolve the configured signer for a fee-payer address.
   *
   * @param feePayerAddress - Fee-payer address from the challenge
   * @returns The matching kit signer, or undefined when not managed
   */
  private resolveFeePayer(feePayerAddress: string): UptoSvmSigner | undefined {
    if (!this.signer.getAddresses().includes(feePayerAddress as Address)) {
      return undefined;
    }
    return this.getKitSigner(feePayerAddress as Address);
  }

  /**
   * Upsert a channel into rent-cleanup storage after settlement is already
   * confirmed onchain. Failures go to
   * {@link UptoSvmFacilitatorConfig.onStorageError} and never propagate: a
   * charged payment must never turn into a failure over bookkeeping.
   *
   * @param phase - Whether verify or settle succeeded before the upsert
   * @param fields - Channel facts retained for cleanup (payTo included)
   */
  private async upsertChannelStorage(
    phase: UptoChannelStorageErrorContext["phase"],
    fields: Omit<UptoChannelRecord, "firstSeenAt">,
  ): Promise<void> {
    try {
      await this.channelStorage.upsert({
        ...fields,
        firstSeenAt: Date.now(),
      });
    } catch (error) {
      const context = { channelId: fields.channelId, phase };
      if (this.config.onStorageError) {
        this.config.onStorageError(error, context);
      } else {
        console.warn(`[x402] upto svm: channel storage upsert failed after ${phase}`, {
          channelId: fields.channelId,
          error,
        });
      }
    }
  }

  /**
   * Upsert a channel and rethrow on storage failure. Used only for the
   * pre-broadcast deposit index, where nothing has reached the chain yet and
   * a durable record is the only way rent cleanup can ever find the channel.
   *
   * @param fields - Channel facts retained for cleanup (payTo included)
   */
  private async upsertChannelStorageOrFail(
    fields: Omit<UptoChannelRecord, "firstSeenAt">,
  ): Promise<void> {
    try {
      await this.channelStorage.upsert({
        ...fields,
        firstSeenAt: Date.now(),
      });
    } catch (error) {
      this.config.onStorageError?.(error, { channelId: fields.channelId, phase: "settle" });
      throw error;
    }
  }
}
