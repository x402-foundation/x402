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
import { createRpcClient, getStablecoinTokenProgram } from "../../utils";
import { resolveUptoSvmPaymentChannelConfig } from "../shared";
import {
  broadcastOpen,
  channelExists,
  fetchAndVerifyOpenChannel,
  simulateOpenSettleDistribute,
  simulateZeroChargeSettle,
  submitSettle,
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

/** Client-supplied voucher at verify time (settle-only field). */
export const ERR_UNEXPECTED_VOUCHER = "invalid_upto_svm_payload_unexpected_voucher";

/** Context passed to {@link UptoSvmFacilitatorConfig.onStorageError}. */
export type UptoChannelStorageErrorContext = {
  channelId: string;
  phase: "verify" | "settle";
};

/** Optional configuration for the upto SVM facilitator. */
export interface UptoSvmFacilitatorConfig {
  /** Custom RPC URL (per-network defaults are used when omitted). */
  rpcUrl?: string;
  /**
   * Channel storage for rent cleanup. Defaults to in-memory storage.
   * Inject a durable implementation for multi-process facilitators.
   */
  channelStorage?: UptoChannelStorage;
  /**
   * Called when channel storage upsert fails after a successful verify or
   * settle. Payment results are unchanged; only rent-cleanup indexing is
   * affected. Defaults to `console.warn`.
   */
  onStorageError?: (error: unknown, context: UptoChannelStorageErrorContext) => void;
}

/**
 * SVM facilitator for the `upto` payment scheme.
 *
 * `verify` validates the client authorization and broadcasts the channel `open`
 * (escrowing the ceiling before resource execution); `settle` re-binds the open
 * channel from chain, verifies the server-supplied voucher for the actual
 * metered amount (`actual ≤ max`), then `settle_and_seal` + `distribute`,
 * refunding the remainder to the payer.
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
      network,
      rpcUrl: this.config.rpcUrl,
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
   * Verify the authorization and broadcast the channel open (idempotently).
   *
   * `requirements.amount` is treated as the authorized ceiling here.
   *
   * @param payload - The payment payload
   * @param requirements - The payment requirements (amount = ceiling)
   * @returns The verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const raw = payload.payload as Record<string, unknown>;
    if (!isUptoSvmPayload(raw)) {
      return { isValid: false, invalidReason: "unsupported_payload_type", payer: "" };
    }
    const p: UptoSvmPayloadV2 = raw;

    if (payload.accepted.scheme !== "upto" || requirements.scheme !== "upto") {
      return { isValid: false, invalidReason: "unsupported_scheme", payer: p.from };
    }
    if (payload.accepted.network !== requirements.network) {
      return { isValid: false, invalidReason: "network_mismatch", payer: p.from };
    }

    // `voucherSignature` is server-owned and settle-only. Reject on presence, not
    // on value: core's additive-enrichment policy keys off hasOwnProperty, so a
    // client-set key (even "" or undefined) blocks the real voucher at settle.
    if (Object.prototype.hasOwnProperty.call(raw, "voucherSignature")) {
      return {
        isValid: false,
        invalidReason: ERR_UNEXPECTED_VOUCHER,
        payer: p.from,
      };
    }

    let channelConfig: ReturnType<typeof resolveUptoSvmPaymentChannelConfig>;
    try {
      channelConfig = resolveUptoSvmPaymentChannelConfig(requirements);
    } catch (error) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payment_requirements",
        invalidMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
    }

    const feePayer = channelConfig.feePayer;
    const feePayerSigner = this.resolveFeePayer(feePayer);
    if (!feePayerSigner) {
      return { isValid: false, invalidReason: "facilitator_mismatch", payer: p.from };
    }
    const receiverAuthorizer = channelConfig.receiverAuthorizer;
    if (p.authorizedSigner !== receiverAuthorizer) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_receiver_authorizer",
        payer: p.from,
      };
    }

    // Ceiling: the signed maxAmount must equal the verification-phase amount.
    let maxAmount: bigint;
    let deposit: bigint;
    try {
      maxAmount = BigInt(p.maxAmount);
      deposit = BigInt(p.deposit);
    } catch {
      return { isValid: false, invalidReason: "invalid_upto_svm_payload_amount", payer: p.from };
    }
    if (maxAmount !== BigInt(requirements.amount)) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_amount_mismatch",
        payer: p.from,
      };
    }
    if (deposit !== maxAmount) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_deposit_not_ceiling",
        payer: p.from,
      };
    }

    const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
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
        recentSlot = await rpc.getSlot().send();
      }
    } catch {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_channel_seed",
        payer: p.from,
      };
    }

    const now = Math.floor(Date.now() / 1000);
    if (now < p.validAfter) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_not_yet_active",
        payer: p.from,
      };
    }
    if (p.expiresAt === 0 || now >= p.expiresAt) {
      return { isValid: false, invalidReason: "invalid_upto_svm_payload_expired", payer: p.from };
    }

    const tokenProgram =
      (requirements.extra?.tokenProgram as string | undefined) ??
      getStablecoinTokenProgram(requirements.asset, requirements.network);

    // Validate the open instruction against the pinned requirements.
    try {
      const open = await verifyOpenTransaction(p.openTransaction, {
        authorizedSigner: receiverAuthorizer,
        feePayer,
        from: p.from,
        maxCap: maxAmount,
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
          isValid: false,
          invalidReason: "invalid_upto_svm_payload_channel_id",
          invalidMessage: `open channel ${open.channelId} != payload.channelId ${p.channelId}`,
          payer: p.from,
        };
      }
      if (open.salt !== nonce) {
        return {
          isValid: false,
          invalidReason: "invalid_upto_svm_payload_nonce",
          invalidMessage: `open salt ${open.salt} != payload.nonce ${p.nonce}`,
          payer: p.from,
        };
      }
      // Bind the channel payer to `payload.from`: settlement builds the
      // distribute (refund) instruction from `p.from`, so a mismatch with the
      // open transaction's payer would make settlement fail onchain.
      if (open.payer !== p.from) {
        return {
          isValid: false,
          invalidReason: "invalid_upto_svm_payload_payer_mismatch",
          invalidMessage: `open payer ${open.payer} != payload.from ${p.from}`,
          payer: p.from,
        };
      }
    } catch (error) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_open_transaction",
        invalidMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
    }

    // Escrow the ceiling before resource execution. Fresh opens: simulate
    // open∥settle∥distribute before broadcast so settlement-account failures
    // reject without locking the deposit. Already-open: settle-only sim after
    // binding the confirmed account (composite open is not in that path).
    // Stage-specific codes (no extra RPC on the happy path): sim → broadcast → bind.
    const alreadyOpen = await channelExists(rpc, p.channelId);
    const simChannel = {
      channelId: p.channelId,
      mint: requirements.asset,
      network: requirements.network,
      payee: feePayer,
      payer: p.from,
      rentPayer: feePayer,
      splits: channelConfig.splits,
      tokenProgram,
    };
    if (!alreadyOpen) {
      try {
        await simulateOpenSettleDistribute(feePayerSigner, rpc, {
          openTransactionBase64: p.openTransaction,
          channel: simChannel,
        });
      } catch (error) {
        return {
          isValid: false,
          invalidReason: "invalid_upto_svm_settlement_simulation",
          invalidMessage: error instanceof Error ? error.message : String(error),
          payer: p.from,
        };
      }
      try {
        await broadcastOpen(
          this.signer,
          feePayer as Address,
          requirements.network,
          p.openTransaction,
        );
      } catch (error) {
        return {
          isValid: false,
          invalidReason: "invalid_upto_svm_channel_broadcast",
          invalidMessage: error instanceof Error ? error.message : String(error),
          payer: p.from,
        };
      }
    }

    let channel: Awaited<ReturnType<typeof fetchAndVerifyOpenChannel>>;
    try {
      channel = await fetchAndVerifyOpenChannel(rpc, p.channelId, {
        authorizedSigner: receiverAuthorizer,
        deposit: maxAmount,
        gracePeriod: channelConfig.withdrawDelay,
        mint: requirements.asset,
        payee: feePayer,
        payer: p.from,
        rentPayer: feePayer,
        splits: channelConfig.splits,
      });
    } catch (error) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_channel_state",
        invalidMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
    }

    if (alreadyOpen) {
      try {
        await simulateZeroChargeSettle(feePayerSigner, rpc, {
          channelId: channel.channelId,
          mint: channel.mint,
          network: requirements.network,
          payee: channel.payee,
          payer: channel.payer,
          rentPayer: channel.rentPayer,
          splits: channel.splits,
          tokenProgram,
        });
      } catch (error) {
        return {
          isValid: false,
          invalidReason: "invalid_upto_svm_settlement_simulation",
          invalidMessage: error instanceof Error ? error.message : String(error),
          payer: p.from,
        };
      }
    }

    await this.upsertChannelStorage("verify", {
      channelId: p.channelId,
      network: requirements.network,
      payTo: requirements.payTo,
      tokenProgram,
      expiresAt: p.expiresAt,
    });

    return { isValid: true, invalidReason: undefined, payer: p.from };
  }

  /**
   * Settle the actual metered amount (`requirements.amount`) against the open
   * channel: re-bind from chain, verify the server voucher + settle_and_seal +
   * distribute, refunding the remainder. `actual === 0` still seals (full
   * refund) after verifying the zero-amount voucher authenticates the settle
   * request. Standalone from `verify` — safe across serverless isolates.
   *
   * @param payload - The payment payload
   * @param requirements - The payment requirements (amount = actual charge)
   * @returns The settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const raw = payload.payload as Record<string, unknown>;
    if (!isUptoSvmPayload(raw)) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "unsupported_payload_type",
        payer: "",
      };
    }
    const p: UptoSvmPayloadV2 = raw;

    if (payload.accepted.scheme !== "upto" || requirements.scheme !== "upto") {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "unsupported_scheme",
        payer: p.from,
      };
    }
    if (payload.accepted.network !== requirements.network) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "network_mismatch",
        payer: p.from,
      };
    }

    // Enforce actual ≤ ceiling first, against the signed `maxAmount` (never the
    // settlement-phase `amount`). Checked before any RPC work.
    let actual: bigint;
    let payloadMaxAmount: bigint;
    try {
      actual = BigInt(requirements.amount);
      payloadMaxAmount = BigInt(p.maxAmount);
    } catch {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payload_amount",
        payer: p.from,
      };
    }
    if (actual < 0n) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payload_amount",
        payer: p.from,
      };
    }
    if (actual > payloadMaxAmount) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: ERR_SETTLEMENT_EXCEEDS_AMOUNT,
        payer: p.from,
      };
    }

    let channelConfig: ReturnType<typeof resolveUptoSvmPaymentChannelConfig>;
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
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payload_receiver_authorizer",
        payer: p.from,
      };
    }

    const feePayerSigner = this.resolveFeePayer(channelConfig.feePayer);
    if (!feePayerSigner) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "facilitator_mismatch",
        payer: p.from,
      };
    }

    const now = Math.floor(Date.now() / 1000);
    if (now < p.validAfter) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payload_not_yet_active",
        payer: p.from,
      };
    }
    if (p.expiresAt === 0 || now >= p.expiresAt) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payload_expired",
        payer: p.from,
      };
    }

    if (typeof p.voucherSignature !== "string" || p.voucherSignature.length === 0) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payload_missing_voucher",
        payer: p.from,
      };
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
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payload_voucher_signature",
        payer: p.from,
      };
    }
    if (!voucherOk) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payload_voucher_signature",
        payer: p.from,
      };
    }

    const tokenProgram =
      (requirements.extra?.tokenProgram as string | undefined) ??
      getStablecoinTokenProgram(requirements.asset, requirements.network);
    const network = requirements.network;
    const rpc = createRpcClient(network, this.config.rpcUrl);

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
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "duplicate_settlement",
        payer: p.from,
      };
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
      const signature = await submitSettle(feePayerSigner, rpc, instructions);

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
   * Upsert a channel into rent-cleanup storage after verify/settle success.
   * Storage failures are reported via {@link UptoSvmFacilitatorConfig.onStorageError}
   * and never propagate to the caller.
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
}
