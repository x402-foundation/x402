import type { Address } from "@solana/kit";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

import {
  buildDistributeInstruction,
  buildSettleAndSealInstructions,
  type ServerInstruction,
} from "../../payment-channels/onchain";
import { parseU64, verifyOpenTransaction } from "../../payment-channels/open";
import { encodeVoucherMessageBytes, verifyVoucherSignature } from "../../payment-channels/voucher";
import { SettlementCache } from "../../settlement-cache";
import type { FacilitatorSigningCapabilities, FacilitatorSvmSigner } from "../../signer";
import { isUptoSvmPayload, type UptoSvmPayloadV2 } from "../../types";
import { createRpcClient, validateSvmAddress } from "../../utils";
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
  fetchAndVerifyOpenChannel,
  SettlementConfirmationTimeoutError,
  simulateOpenSettleDistribute,
  submitSettle,
  type ChannelRpc,
  type UptoSvmSigner,
} from "./channel";
import {
  InMemoryUptoChannelStorage,
  type UptoChannelRecord,
  type UptoChannelStorage,
} from "./channelStorage";
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

/**
 * A claim's settle_and_seal + distribute transaction broadcast but did not
 * reach `confirmed` within the polling budget. Unlike `transaction_failed`,
 * the outcome is unknown, not a rejection — the transaction may still land.
 * The settlement dedup entry is kept (not deleted) so a caller retrying the
 * same claim cannot race a second settle_and_seal against the first.
 */
export const ERR_SETTLEMENT_CONFIRMATION_TIMEOUT = "settlement_confirmation_timeout";

/** Default facilitator `maxChannelLifetimeSecs` (1 hour). */
export const DEFAULT_MAX_CHANNEL_LIFETIME_SECS = 3_600;

/** Client/facilitator clock skew allowance for `expiresAt` checks. */
const EXPIRES_AT_CLOCK_SKEW_SECS = 60;

/** Context passed to {@link UptoSvmFacilitatorConfig.onStorageError}. */
export type UptoChannelStorageErrorContext = {
  channelId: string;
  phase: "verify" | "settle";
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
  /** Custom RPC URL (per-network defaults are used when omitted). */
  rpcUrl?: string;
  /**
   * Injected RPC client used instead of building one from `rpcUrl`. Lets the
   * host route channel sends through its own paced/instrumented transport.
   */
  rpc?: ChannelRpc;
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
 * Escrow flow: `/settle` without `voucherSignature` and with
 * `requirements.amount === payload.maxAmount` deposits (broadcasts `open`);
 * `/settle` with a server voucher claims (`settle_and_seal` + `distribute`).
 * `/verify` is an optional read-only preflight of the same static checks —
 * it never broadcasts.
 *
 * The fee payer holds the channel `payee` seat with a zero distribution share:
 * it signs `settle_and_seal` (lifecycle authority) and can always seal an
 * abandoned channel with `has_voucher = 0` to recover its rent, while any
 * nonzero settlement still requires the server's receiver-authorizer voucher
 * (payment authority).
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

  private readonly getKitSigner: (feePayer: Address) => FacilitatorSigningCapabilities;

  /**
   * Create the upto SVM facilitator.
   *
   * @param signer - Facilitator signer (fee payers / channel rent payers /
   *   zero-share channel payees). `getExtra` randomly selects among
   *   `signer.getAddresses()`. Must provide {@link FacilitatorSvmSigner.getSigner}.
   * @param config - Optional RPC / channel-storage configuration
   */
  constructor(
    private readonly signer: FacilitatorSvmSigner,
    config: UptoSvmFacilitatorConfig = {},
  ) {
    if (typeof signer.getSigner !== "function") {
      throw new Error(
        "UptoSvmScheme requires getSigner on the signer. " +
          "Use toFacilitatorSvmSigner() which provides all required methods.",
      );
    }
    this.getKitSigner = signer.getSigner.bind(signer);
    if (this.signer.getAddresses().length === 0) {
      throw new Error("UptoSvmScheme requires at least one fee payer signer");
    }
    assertLimit("maxChannelLifetimeSecs", config.maxChannelLifetimeSecs, 1);
    assertLimit("maxPriorityFeeMicroLamports", config.maxPriorityFeeMicroLamports, 0);
    assertLimit("maxComputeUnits", config.maxComputeUnits, 1);
    assertLimit("maxRequiredSignatures", config.maxRequiredSignatures, 1);
    assertLimit("computeUnitPriceMicroLamports", config.computeUnitPriceMicroLamports, 0);
    assertLimit("settleComputeUnitLimit", config.settleComputeUnitLimit, 1);
    this.config = config;
    this.channelStorage = config.channelStorage ?? new InMemoryUptoChannelStorage();
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
   * this scheme's signer pool and channel storage. Does not auto-start; call
   * `manager.start(...)` or schedule `manager.cleanup()`.
   *
   * @param network - CAIP-2 network the manager should clean up
   * @returns A rent cleanup manager for that network
   */
  createRentCleanupManager(network: Network): UptoSvmRentCleanupManager {
    return new UptoSvmRentCleanupManager({
      computeUnitPriceMicroLamports: this.config.computeUnitPriceMicroLamports,
      network,
      rpcUrl: this.config.rpcUrl,
      settleComputeUnitLimit: this.config.settleComputeUnitLimit,
      rpc: this.config.rpc,
      signer: this.signer,
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
    return { feePayer: addresses[randomIndex] };
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
   * Discrimination (no settle phase on the wire):
   * - no `voucherSignature` and `requirements.amount === payload.maxAmount` → deposit
   * - `voucherSignature` present → claim against the open channel
   *
   * @param payload - The payment payload
   * @param requirements - Deposit: amount = ceiling; claim: amount = actual charge
   * @returns The settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
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

    const hasVoucher = Object.prototype.hasOwnProperty.call(raw, "voucherSignature");
    if (hasVoucher) {
      return this.settleClaim(payload, requirements, p, actual, payloadMaxAmount);
    }
    if (actual === payloadMaxAmount) {
      return this.settleDeposit(payload, requirements);
    }
    return this.settleFailure(payload, "invalid_upto_svm_payload_missing_voucher", p.from);
  }

  /**
   * Deposit path: validate open authorization, then sim → broadcast → bind.
   * Rejects when the channel already exists (one request, one open).
   *
   * @param payload - The payment payload
   * @param requirements - Requirements with amount = authorized ceiling
   * @returns Deposit settlement response
   */
  private async settleDeposit(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
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

    const { p, channelConfig, feePayerSigner, maxAmount, tokenProgram } = auth.ctx;
    const feePayer = channelConfig.feePayer;
    const rpc = this.config.rpc ?? createRpcClient(requirements.network, this.config.rpcUrl);

    // One authorization → one deposit open. A confirmed channel is replay or a
    // stranded prior open, not a supported re-bind path; handler failure after
    // a successful deposit uses the zero-amount cancel/refund settle instead.
    if (await channelExists(rpc, p.channelId)) {
      return this.settleFailure(payload, ERR_CHANNEL_ALREADY_OPEN, p.from);
    }

    // Race: two deposit settles can both see "channel missing", broadcast the
    // same open, and both get success back from RPC. Dedup here so only one
    // proceeds. Key is deposit-scoped so this does not block the later claim.
    const depositKey = `upto:deposit:${requirements.network}:${p.channelId}`;
    if (this.settlementCache.isDuplicate(depositKey)) {
      return this.settleFailure(payload, "duplicate_settlement", p.from);
    }

    // Simulate open + settle + distribute before broadcast so settlement-account
    // failures reject without locking the deposit.
    try {
      await simulateOpenSettleDistribute(feePayerSigner, rpc, {
        openTransactionBase64: p.openTransaction,
        channel: {
          channelId: p.channelId,
          mint: requirements.asset,
          network: requirements.network,
          payee: feePayer,
          payer: p.from,
          rentPayer: feePayer,
          splits: channelConfig.splits,
          tokenProgram,
        },
      });
    } catch (error) {
      this.settlementCache.delete(depositKey);
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
    } catch (error) {
      this.settlementCache.delete(depositKey);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: ERR_CHANNEL_BROADCAST,
        errorMessage: `failed to durably index the channel before broadcast: ${
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
      this.settlementCache.delete(depositKey);
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
      await fetchAndVerifyOpenChannel(rpc, p.channelId, {
        authorizedSigner: channelConfig.receiverAuthorizer,
        deposit: maxAmount,
        gracePeriod: channelConfig.withdrawDelay,
        mint: requirements.asset,
        payee: feePayer,
        payer: p.from,
        rentPayer: feePayer,
        splits: channelConfig.splits,
      });
    } catch (error) {
      this.settlementCache.delete(depositKey);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_channel_state",
        errorMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
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
   * Claim path: re-bind the open channel, verify the voucher, then
   * settle_and_seal + distribute.
   *
   * @param payload - The payment payload
   * @param requirements - Requirements with amount = actual charge
   * @param p - Typed upto payload
   * @param actual - Actual charge in atomic units
   * @param payloadMaxAmount - Signed ceiling from the payload
   * @returns Claim settlement response
   */
  private async settleClaim(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    p: UptoSvmPayloadV2,
    actual: bigint,
    payloadMaxAmount: bigint,
  ): Promise<SettleResponse> {
    if (typeof p.voucherSignature !== "string" || p.voucherSignature.length === 0) {
      return this.settleFailure(payload, "invalid_upto_svm_payload_missing_voucher", p.from);
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
    const voucherMessage = encodeVoucherMessageBytes({
      channelId: p.channelId,
      cumulativeAmount: actual,
      expiresAt,
    });
    let voucherOk: boolean;
    try {
      voucherOk = await verifyVoucherSignature({
        message: voucherMessage,
        signatureBase58: p.voucherSignature,
        signerBase58: p.authorizedSigner,
      });
    } catch {
      return this.settleFailure(payload, "invalid_upto_svm_payload_voucher_signature", p.from);
    }
    if (!voucherOk) {
      return this.settleFailure(payload, "invalid_upto_svm_payload_voucher_signature", p.from);
    }

    let tokenProgram: string;
    try {
      tokenProgram = resolveTokenProgram(requirements);
    } catch {
      return this.settleFailure(payload, "invalid_upto_svm_payment_requirements", p.from);
    }
    const network = requirements.network;
    const rpc = this.config.rpc ?? createRpcClient(network, this.config.rpcUrl);

    let channel: Awaited<ReturnType<typeof fetchAndVerifyOpenChannel>>;
    try {
      channel = await fetchAndVerifyOpenChannel(rpc, p.channelId, {
        authorizedSigner: channelConfig.receiverAuthorizer,
        deposit: payloadMaxAmount,
        gracePeriod: channelConfig.withdrawDelay,
        mint: requirements.asset,
        payee: channelConfig.feePayer,
        payer: p.from,
        rentPayer: channelConfig.feePayer,
        splits: channelConfig.splits,
      });
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

    // Claim only after the open channel is rebound. Concurrent or replayed
    // settles for the same channel — including different valid amounts /
    // vouchers — must fail after the first claim so only one settle_and_seal +
    // distribute is submitted. Failures above (invalid voucher / not open) do
    // not insert into the cache.
    const settlementKey = `upto:${network}:${p.channelId}`;
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
                signatureBase58: p.voucherSignature,
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
      const signature = await submitSettle(feePayerSigner, rpc, instructions, {
        computeUnitLimit: this.config.settleComputeUnitLimit,
        computeUnitPriceMicroLamports: this.config.computeUnitPriceMicroLamports,
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

      return {
        success: true,
        transaction: signature,
        network,
        amount: actual.toString(),
        payer: channel.payer,
      };
    } catch (error) {
      // A confirmation timeout leaves the transaction's fate unknown, not
      // failed: it may still land. The dedup entry is kept, not deleted, so
      // a caller retrying this claim cannot race a second settle_and_seal
      // against the first while the outcome is still unresolved.
      if (error instanceof SettlementConfirmationTimeoutError) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: ERR_SETTLEMENT_CONFIRMATION_TIMEOUT,
          errorMessage: error.message,
          payer: p.from,
        };
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
   * @returns Open auth context or a structured failure
   */
  private async validateOpenAuthorization(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    options: { rejectVoucher: boolean },
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

    const rpc = this.config.rpc ?? createRpcClient(requirements.network, this.config.rpcUrl);
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
        recentSlot = await rpc.getSlot({ commitment: SLOT_COMMITMENT }).send();
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
