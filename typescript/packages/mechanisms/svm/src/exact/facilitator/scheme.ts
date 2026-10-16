import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  parseSetComputeUnitLimitInstruction,
  parseSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  parseTransferCheckedInstruction as parseTransferCheckedInstructionToken,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  findAssociatedTokenPda,
  parseTransferCheckedInstruction as parseTransferCheckedInstruction2022,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import {
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  type Address,
  type Transaction,
} from "@solana/kit";
import type {
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
  LIGHTHOUSE_PROGRAM_ADDRESS,
  MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  MEMO_PROGRAM_ADDRESS,
} from "../../constants";
import { SettlementCache } from "../../settlement-cache";
import type { FacilitatorSvmSigner } from "../../signer";
import type { ExactSvmPayloadV2 } from "../../types";
import {
  decodeTransactionFromPayload,
  getTokenPayerFromTransaction,
  recordPendingOrTerminal,
  transactionMessageHash,
  TransactionOnchainFailureError,
} from "../../utils";
import {
  assertSmartWalletLimits,
  assertSmartWalletVerifySigner,
  resolveAccountKeys,
  verifySmartWalletTransaction,
  verifyPostSettlement,
  type DecodedTransactionView,
  type SmartWalletVerifySigner,
  type TransferCheckedInfo,
} from "./smartWalletVerification";
import { verifyRequiredSignatures } from "./signatureVerification";
import * as Errors from "./errors";

const compiledMessageDecoder = getCompiledTransactionMessageDecoder();

/**
 * Default allowed smart wallet program addresses.
 * Only these programs can reach Path 2 (simulation-based verification).
 * Operators can override via smartWalletAllowedPrograms in options.
 */
const DEFAULT_SMART_WALLET_ALLOWED_PROGRAMS = [
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf", // Squads Multisig v4
  "SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG", // Squads Smart Account
  "SWiGmQedKzMz1tiTqoJCWeGDnGXfNBp2PkXLkpCAtQo", // Swig (legacy)
  "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB", // Swig v2 (@swig-wallet/kit 2.x)
  "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw", // SPL Governance
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d", // Metaplex Core
  LIGHTHOUSE_PROGRAM_ADDRESS, // Phantom's wallet-protection assertions (see #2097)
];

const IX_TOKEN_TRANSFER_CHECKED = 12;

/**
 * Maximum wallet-injected Lighthouse guard instructions tolerated by Path 1.
 * Phantom currently brackets the transfer with four guards: three inserted
 * before the TransferChecked and one appended after it (see #2097).
 */
const MAX_LIGHTHOUSE_INSTRUCTIONS = 4;

/**
 * Which verification path produced a successful result.
 * Returned by the internal _verify so settle() knows whether post-settlement
 * TOCTOU verification is required, without re-deriving it from the transaction.
 */
type VerificationPath = "static" | "smartWallet";

/**
 * Internal verify result that also reports which path succeeded.
 * verificationPath is null when verification failed.
 */
type VerifyResult = {
  response: VerifyResponse;
  verificationPath: VerificationPath | null;
  matchedTransfer?: TransferCheckedInfo;
};

/**
 * Path 1 failure reasons that indicate a transaction layout a standard-wallet
 * parser could not handle — extra/unknown instructions, unexpected counts, or
 * a missing positional transfer. These are the only cases where falling through
 * to Path 2 (simulation) can legitimately recover the payment, because the
 * transfer may simply be wrapped in a smart-wallet CPI.
 *
 * Reasons NOT in this set are semantic rejections (amount/mint/recipient/memo
 * mismatch, self-spend, failed simulation). Those describe a transaction that
 * is genuinely invalid for this payment, so Path 2 must not run — doing so would
 * mask the real reason behind a misleading smart_wallet_* error code.
 */
const LAYOUT_RECOVERABLE_REASONS = new Set<string>([
  Errors.ErrTransactionInstructionsLength,
  Errors.ErrNoTransferInstruction,
  Errors.ErrUnknownFourthInstruction,
  Errors.ErrUnknownFifthInstruction,
  Errors.ErrUnknownSixthInstruction,
  Errors.ErrUnknownOptionalInstruction,
  Errors.ErrComputeLimitInstruction,
  Errors.ErrComputePriceInstruction,
]);

/**
 * Configuration options for ExactSvmScheme.
 */
export type ExactSvmSchemeOptions = {
  /**
   * Enable simulation-based smart wallet verification.
   * When enabled, transactions rejected by the static validation path
   * (unknown programs, wrong instruction count) are re-verified using
   * simulation inner instruction analysis. Works for any smart wallet
   * program (Squads, Swig, SPL Governance, etc.) without per-wallet parsers.
   *
   * Default: false (only standard wallet transactions are accepted)
   */
  enableSmartWalletVerification?: boolean;

  /**
   * Maximum compute units allowed for smart wallet transactions.
   * Smart wallet programs need more CU for CPI overhead.
   * Only applies when enableSmartWalletVerification is true.
   * Invalid configured values throw when smart wallet verification is enabled.
   *
   * Default: 400,000
   */
  smartWalletMaxComputeUnits?: number;

  /**
   * Maximum priority fee in microlamports for smart wallet transactions.
   * Only applies when enableSmartWalletVerification is true.
   * Invalid configured values throw when smart wallet verification is enabled.
   *
   * Default: 50,000
   */
  smartWalletMaxPriorityFeeMicroLamports?: number;

  /**
   * Allowed smart wallet program addresses for Path 2 verification.
   * Only transactions whose top-level non-ComputeBudget instruction invokes
   * a program in this list will be accepted through the simulation path.
   * Prevents unknown/malicious programs from reaching CPI verification.
   *
   * Default: Squads Multisig v4, Squads Smart Account, Swig, SPL Governance, Metaplex Core
   */
  smartWalletAllowedPrograms?: string[];

  /**
   * Maximum compute unit price in microlamports accepted on the static path.
   * The facilitator is the fee payer, so the payer chooses a priority fee the
   * facilitator pays. Operators serving low-value payments will want this far
   * below the default.
   *
   * Default: MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS (5,000,000)
   */
  maxPriorityFeeMicroLamports?: number;

  /**
   * Maximum compute unit limit accepted on the static path. An SPL transfer
   * with a memo uses ~20k CU, so a low ceiling still leaves ample headroom for
   * wallet-injected instructions.
   *
   * Default: unset (no limit, preserving existing behavior)
   */
  maxComputeUnits?: number;

  /**
   * Maximum number of required signatures. Every signature adds 5,000 lamports
   * of base fee, paid by the facilitator. A typical x402 payment needs two
   * (payer + fee payer).
   *
   * Default: unset (no limit, preserving existing behavior)
   */
  maxRequiredSignatures?: number;

  /**
   * Lets a retried settle for the same transaction reconcile against an
   * already-broadcast signature instead of re-verifying and re-sending (see
   * {@link PendingSettlementStore}). Defaults to a fresh in-memory store
   * shared across all settle calls on this scheme instance. Inject a
   * shared, network-backed implementation (e.g. Redis) for a
   * multi-instance facilitator so a settle retry landing on a different
   * replica still reconciles correctly.
   */
  pendingSettlementStore?: PendingSettlementStore;
};

/**
 * Rejects a limit that cannot function as a limit. `NaN` and `Infinity` are the
 * dangerous cases: they arrive easily from `parseInt(process.env.X)` on an unset
 * variable, and each option degrades differently and silently — a `NaN` compute
 * unit or signature ceiling makes every comparison false (no limit at all),
 * while a `NaN` priority fee makes `BigInt()` throw and rejects every payment
 * under a misleading reason code. Failing at construction turns all of those
 * into one loud error.
 *
 * @param name - Option name, used in the error message
 * @param value - Configured value, or undefined when the option is unset
 * @param min - Smallest meaningful value for this option
 */
function assertLimit(name: string, value: number | undefined, min: number): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be a safe integer >= ${min}, received ${value}`);
  }
}

/**
 * SVM facilitator implementation for the Exact payment scheme.
 *
 * Dual-path verification:
 *
 * Path 1 (Static): Strict positional instruction validation for standard wallets.
 *   Fast, preserves existing behavior.
 *
 * Path 2 (Simulation): Outcome-based verification for smart wallets.
 *   When Path 1 rejects a transaction and smart wallet verification is enabled,
 *   falls back to simulation-based validation that inspects CPI inner instructions.
 *   Works for any wallet program that executes TransferChecked via CPI.
 */
export class ExactSvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "solana:*";

  private readonly settlementCache: SettlementCache;
  private readonly pendingStore: PendingSettlementStore;

  /**
   * Creates a new ExactSvmScheme instance.
   *
   * @param signer - The SVM signer for facilitator operations
   * @param settlementCache - Optional shared settlement cache (one is created if omitted)
   * @param options - Optional configuration for smart wallet verification
   */
  constructor(
    private readonly signer: FacilitatorSvmSigner,
    settlementCache?: SettlementCache,
    private readonly options?: ExactSvmSchemeOptions,
  ) {
    this.settlementCache = settlementCache ?? new SettlementCache();
    this.pendingStore =
      this.options?.pendingSettlementStore ?? new InMemoryPendingSettlementStore();

    // A limit that cannot be compared against is worse than no limit, so reject
    // it here rather than at verify time.
    assertLimit("maxPriorityFeeMicroLamports", this.options?.maxPriorityFeeMicroLamports, 0);
    assertLimit("maxComputeUnits", this.options?.maxComputeUnits, 1);
    // A ceiling below 1 would reject every transaction: the fee payer alone
    // always requires one signature.
    assertLimit("maxRequiredSignatures", this.options?.maxRequiredSignatures, 1);

    if (this.options?.enableSmartWalletVerification) {
      assertSmartWalletLimits({
        maxComputeUnits: this.options.smartWalletMaxComputeUnits,
        maxPriorityFeeMicroLamports: this.options.smartWalletMaxPriorityFeeMicroLamports,
      });
      assertSmartWalletVerifySigner(this.signer);
    }
  }

  /**
   * Get mechanism-specific extra data for the supported kinds endpoint.
   * For SVM, this includes a randomly selected fee payer address.
   * Random selection distributes load across multiple signers.
   *
   * @param _ - The network identifier (unused for SVM)
   * @returns Extra data with feePayer address
   */
  getExtra(_: string): Record<string, unknown> | undefined {
    // Randomly select from available signers to distribute load
    const addresses = this.signer.getAddresses();
    const randomIndex = Math.floor(Math.random() * addresses.length);

    const extra: Record<string, unknown> = { feePayer: addresses[randomIndex] };
    if (this.options?.enableSmartWalletVerification) {
      extra.features = { smartWalletSupported: true };
    }
    return extra;
  }

  /**
   * Get signer addresses used by this facilitator.
   * For SVM, returns all available fee payer addresses.
   *
   * @param _ - The network identifier (unused for SVM)
   * @returns Array of fee payer addresses
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Verifies a payment payload.
   *
   * @param payload - The payment payload to verify
   * @param requirements - The payment requirements
   * @returns Promise resolving to verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const { response } = await this._verify(payload, requirements);
    return response;
  }

  /**
   * Settles a payment by submitting the transaction.
   * Ensures the correct signer is used based on the feePayer specified in requirements.
   *
   * @param payload - The payment payload to settle
   * @param requirements - The payment requirements
   * @returns Promise resolving to settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const exactSvmPayload = payload.payload as ExactSvmPayloadV2;

    // Decode the transaction to compute the message hash used as the pending-
    // settlement/dedup key, up front (no RPC calls) so it's available before
    // any verify/sign/send work. A decode failure here just disables the fast
    // path — the normal verify call below still produces the correct
    // "could not be decoded" rejection.
    let txKey: string | undefined;
    let decodedTransaction: Transaction | undefined;
    try {
      decodedTransaction = decodeTransactionFromPayload(exactSvmPayload);
      txKey = transactionMessageHash(decodedTransaction);
    } catch {
      txKey = undefined;
    }

    // Duplicate settlement check keyed on message hash (immune to mutable fee-payer sig at slot
    // 0). Must remain synchronous (before any await) so concurrent settle calls for
    // the same payment are caught before any async work begins.
    const isCachedDuplicate = txKey ? this.settlementCache.isDuplicate(txKey) : false;

    // Pending-settlement fast path: a prior settle for this exact transaction
    // broadcast successfully but its confirmTransaction wait failed. Reconcile
    // against the already-broadcast signature instead of re-verifying and
    // re-sending: Solana transactions embed a recent blockhash that expires
    // (so a resend can fail even when the original is still perfectly valid),
    // and if the original actually did land, a second verify's balance-based
    // simulation could now spuriously fail (funds already moved).
    if (txKey) {
      const cachedSignature = await this.pendingStore.get(txKey);
      if (cachedSignature) {
        // Remove before reconciling (rather than after) so a concurrent
        // retry of the same payload misses here instead of also
        // reconciling: it falls through to the settlementCache dedup check
        // below, which independently rejects it as a duplicate.
        await this.pendingStore.delete(txKey);
        // Best-effort payer for the response; a decode/parse failure here
        // doesn't block reconciliation (the payload already broadcast
        // successfully).
        let payer = "";
        let isSmartWalletSettlement = false;
        try {
          payer = getTokenPayerFromTransaction(decodedTransaction!) ?? "";
          // Re-derive which verification path the original settle used;
          // verificationPath itself isn't available here.
          isSmartWalletSettlement =
            !!this.options?.enableSmartWalletVerification &&
            !this.hasStaticTransferLayout(decodedTransaction!);
        } catch {
          // Ignore; payer stays "" and isSmartWalletSettlement stays false.
        }
        return this.reconcilePendingSettlement(
          txKey,
          cachedSignature,
          payer,
          requirements.network,
          isSmartWalletSettlement,
          requirements,
        );
      }
    }

    if (isCachedDuplicate) {
      let payer = "";
      try {
        payer = getTokenPayerFromTransaction(decodedTransaction!) || "";
      } catch {
        payer = "";
      }
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: Errors.ErrDuplicateSettlement,
        payer,
      };
    }

    const {
      response: valid,
      verificationPath,
      matchedTransfer,
    } = await this._verify(payload, requirements);
    if (!valid.isValid) {
      if (txKey) {
        this.settlementCache.delete(txKey);
      }
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: valid.invalidReason ?? Errors.ErrVerificationFailed,
        payer: valid.payer || "",
      };
    }

    // Reuses the txKey decoded/hashed synchronously above instead of decoding a
    // third time: the transaction content is unchanged, and a decode failure here
    // would imply _verify's identical decode already failed and returned isValid:false,
    // so this point is unreachable with txKey undefined. The fallback recompute
    // only exists to satisfy the type checker without an unsafe non-null assertion.
    txKey ??= transactionMessageHash(decodeTransactionFromPayload(exactSvmPayload));

    // Settlements verified through Path 2 (smart wallet) require post-settlement
    // verification to defend against TOCTOU. _verify reports the path directly,
    // so we no longer re-decode the transaction to infer it.
    const isSmartWalletSettlement = verificationPath === "smartWallet";

    // For smart wallet settlements: record destination ATA balance before sending.
    // Used as fallback verification if getTransaction has indexing lag.
    let signature: string;
    let balanceBefore: bigint | null = null;
    let knownDestinationAta: string | null = matchedTransfer?.destination ?? null;
    let balanceBeforeTokenProgram: string | null = matchedTransfer?.programId ?? null;
    try {
      // Extract feePayer from requirements (already validated in verify)
      const feePayer = requirements.extra.feePayer as Address;

      // Sign transaction with the feePayer's signer
      const signPromise = this.signer.signTransaction(
        exactSvmPayload.transaction,
        feePayer,
        requirements.network,
      );
      const balancePromise =
        isSmartWalletSettlement &&
        knownDestinationAta &&
        typeof this.signer.getTokenAccountBalance === "function"
          ? this.signer
              .getTokenAccountBalance(knownDestinationAta, requirements.network)
              .catch(() => null)
          : Promise.resolve(null);

      const [fullySignedTransaction, preBalance] = await Promise.all([signPromise, balancePromise]);
      balanceBefore = preBalance;

      // Send transaction to network
      signature = await this.signer.sendTransaction(fullySignedTransaction, requirements.network);
    } catch (error) {
      // Never broadcast (or broadcast failed outright): allow retry before TTL;
      // blockhash may still be valid.
      this.settlementCache.delete(txKey);
      console.error("Failed to send transaction:", error);
      return {
        success: false,
        errorReason: Errors.ErrTransactionFailed,
        transaction: "",
        network: payload.accepted.network,
        payer: valid.payer || "",
      };
    }

    try {
      // Wait for confirmation
      await this.signer.confirmTransaction(signature, requirements.network);
    } catch (error) {
      if (error instanceof TransactionOnchainFailureError) {
        // Definite onchain rejection: safe to release the dedup lock so a
        // fresh broadcast (new blockhash) isn't blocked by this one.
        this.settlementCache.delete(txKey);
        console.error("Transaction failed onchain:", error);
        return {
          success: false,
          errorReason: Errors.ErrTransactionFailed,
          errorMessage: error.message,
          transaction: signature,
          network: payload.accepted.network,
          payer: valid.payer || "",
        };
      }
      // Broadcast succeeded but confirmation couldn't be observed in time.
      // Non-terminal: leave the dedup lock in place (a fresh broadcast would
      // double-spend) and record the signature so a retry reconciles via the
      // fast path above instead of re-verifying/re-sending.
      console.error("Failed to confirm transaction:", error);
      return recordPendingOrTerminal(
        this.pendingStore,
        txKey,
        signature,
        valid.payer || "",
        payload.accepted.network,
        Errors.ErrSettlementPending,
        Errors.ErrTransactionFailed,
        error,
      );
    }
    try {
      await this.pendingStore.delete(txKey);
    } catch {
      // Best-effort cleanup; the confirmed settlement below is correct
      // regardless and must not be masked by a storage hiccup. A stale entry
      // merely lingers until TTL expiry.
    }

    // Post-settlement verification for smart wallet transactions.
    // Confirms the TransferChecked actually executed on-chain (TOCTOU defense).
    if (isSmartWalletSettlement) {
      const signerAddresses = this.signer.getAddresses().map(a => a.toString());
      const postVerify = await verifyPostSettlement(
        this.signer,
        signature,
        requirements.network,
        requirements,
        signerAddresses,
        balanceBefore,
        balanceBeforeTokenProgram,
        knownDestinationAta,
      );

      if (!postVerify.verified) {
        return {
          success: false,
          errorReason: Errors.ErrPostSettlementTransferNotConfirmed,
          transaction: signature,
          network: payload.accepted.network,
          payer: valid.payer || "",
        };
      }
    }

    return {
      success: true,
      transaction: signature,
      network: payload.accepted.network,
      payer: valid.payer,
    };
  }

  /**
   * Handles a `PendingSettlementStore` cache hit: a prior `settle` call for
   * this transaction (keyed by `txKey`, the message hash) already broadcast
   * `cachedSignature` but couldn't confirm it before returning
   * `settlement_pending`. Re-awaits confirmation of that same signature
   * rather than re-verifying/re-signing/re-sending — see the fast-path
   * comment in {@link settle} for why re-sending is unsafe here.
   *
   * @param txKey - Message-hash key this transaction is cached under
   * @param cachedSignature - The previously broadcast signature
   * @param payer - Best-effort payer address for the response
   * @param network - The network the transaction was broadcast to
   * @param isSmartWalletSettlement - Whether the original settlement was verified via
   *   Path 2 (smart wallet), requiring the same post-settlement TOCTOU check {@link settle}
   *   runs on its non-cached path
   * @param requirements - Payment requirements, needed by {@link verifyPostSettlement}
   *   when isSmartWalletSettlement is true
   * @returns Promise resolving to the reconciled settlement response
   */
  private async reconcilePendingSettlement(
    txKey: string,
    cachedSignature: string,
    payer: string,
    network: PaymentRequirements["network"],
    isSmartWalletSettlement: boolean,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    try {
      await this.signer.confirmTransaction(cachedSignature, network);
    } catch (error) {
      if (error instanceof TransactionOnchainFailureError) {
        // Definite onchain rejection: release the dedup lock set by the
        // original (now-returned) settle call so a fresh broadcast isn't
        // blocked by this one.
        this.settlementCache.delete(txKey);
        console.error("Transaction failed onchain during reconciliation:", error);
        return {
          success: false,
          errorReason: Errors.ErrTransactionFailed,
          errorMessage: error.message,
          transaction: cachedSignature,
          network,
          payer,
        };
      }
      return recordPendingOrTerminal(
        this.pendingStore,
        txKey,
        cachedSignature,
        payer,
        network,
        Errors.ErrSettlementPending,
        Errors.ErrTransactionFailed,
        error,
      );
    }
    try {
      await this.pendingStore.delete(txKey);
    } catch {
      // Best-effort cleanup; see the confirmTransaction catch above for why
      // a storage hiccup must not mask a confirmed settlement.
    }

    if (isSmartWalletSettlement) {
      const signerAddresses = this.signer.getAddresses().map(a => a.toString());
      const postVerify = await verifyPostSettlement(
        this.signer,
        cachedSignature,
        network,
        requirements,
        signerAddresses,
        // No pre-broadcast balance snapshot is available here, so only the
        // innerInstructions method applies; the balance-delta fallback is skipped.
        null,
        null,
      );
      if (!postVerify.verified) {
        return {
          success: false,
          errorReason: Errors.ErrPostSettlementTransferNotConfirmed,
          transaction: cachedSignature,
          network,
          payer,
        };
      }
    }

    return {
      success: true,
      transaction: cachedSignature,
      network,
      payer,
    };
  }

  /**
   * Cheap, local structural check for whether a decoded transaction matches
   * Path 1's static positional layout (compute budget instructions followed
   * by a TransferChecked at index 2). Used to re-derive which verification
   * path a pending settlement originally used, without re-simulating.
   *
   * @param transaction - Decoded transaction to inspect
   * @returns Whether the transaction has Path 1's static transfer shape
   */
  private hasStaticTransferLayout(transaction: Transaction): boolean {
    const compiled = compiledMessageDecoder.decode(transaction.messageBytes);
    const rawInstructions = decompileTransactionMessage(compiled).instructions ?? [];
    const lighthouseCount = rawInstructions.filter(
      ix => ix.programAddress.toString() === LIGHTHOUSE_PROGRAM_ADDRESS,
    ).length;
    const instructions = rawInstructions.filter(
      ix => ix.programAddress.toString() !== LIGHTHOUSE_PROGRAM_ADDRESS,
    );
    if (
      instructions.length < 3 ||
      instructions.length > 4 ||
      lighthouseCount > MAX_LIGHTHOUSE_INSTRUCTIONS
    ) {
      return false;
    }
    const transferIx = instructions[2];
    const programAddress = transferIx.programAddress.toString();
    if (
      programAddress !== TOKEN_PROGRAM_ADDRESS.toString() &&
      programAddress !== TOKEN_2022_PROGRAM_ADDRESS.toString()
    ) {
      return false;
    }
    const ixData = transferIx.data;
    return !!ixData && ixData.length >= 10 && ixData[0] === IX_TOKEN_TRANSFER_CHECKED;
  }

  /**
   * Internal verification that also reports which path validated the payment.
   *
   * settle() consumes verificationPath to decide whether post-settlement TOCTOU
   * verification is required, instead of re-decoding the transaction and
   * inferring the path from a missing token payer.
   *
   * @param payload - The payment payload to verify
   * @param requirements - The payment requirements
   * @returns Verify response plus the path that succeeded (null on failure)
   */
  private async _verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResult> {
    const exactSvmPayload = payload.payload as ExactSvmPayloadV2;

    // Step 1: Validate Payment Requirements
    if (payload.accepted.scheme !== "exact" || requirements.scheme !== "exact") {
      return {
        response: { isValid: false, invalidReason: Errors.ErrUnsupportedScheme, payer: "" },
        verificationPath: null,
      };
    }

    if (payload.accepted.network !== requirements.network) {
      return {
        response: { isValid: false, invalidReason: Errors.ErrNetworkMismatch, payer: "" },
        verificationPath: null,
      };
    }

    if (!requirements.extra?.feePayer || typeof requirements.extra.feePayer !== "string") {
      return {
        response: {
          isValid: false,
          invalidReason: Errors.ErrMissingFeePayer,
          payer: "",
        },
        verificationPath: null,
      };
    }

    // Verify that the requested feePayer is managed by this facilitator
    const signerAddresses = this.signer.getAddresses().map(addr => addr.toString());
    if (!signerAddresses.includes(requirements.extra.feePayer)) {
      return {
        response: {
          isValid: false,
          invalidReason: Errors.ErrFeePayerNotManaged,
          payer: "",
        },
        verificationPath: null,
      };
    }

    // Step 2: Parse and Validate Transaction Structure
    let transaction;
    try {
      transaction = decodeTransactionFromPayload(exactSvmPayload);
    } catch {
      return {
        response: {
          isValid: false,
          invalidReason: Errors.ErrTransactionCouldNotBeDecoded,
          payer: "",
        },
        verificationPath: null,
      };
    }

    let compiled;
    try {
      compiled = compiledMessageDecoder.decode(transaction.messageBytes);
    } catch {
      return {
        response: {
          isValid: false,
          invalidReason: Errors.ErrTransactionCouldNotBeDecoded,
          payer: "",
        },
        verificationPath: null,
      };
    }

    // Signature count is a transaction-level property, so it is checked before
    // path dispatch: it bounds the base fee the facilitator pays regardless of
    // which verification strategy accepts the transaction, and it must not be
    // recoverable via the Path 2 fallthrough.
    const maxRequiredSignatures = this.options?.maxRequiredSignatures;
    if (maxRequiredSignatures !== undefined) {
      const numRequiredSignatures = compiled.header.numSignerAccounts;
      if (numRequiredSignatures > maxRequiredSignatures) {
        return {
          response: {
            isValid: false,
            invalidReason: Errors.ErrExcessiveSigners,
            payer: "",
          },
          verificationPath: null,
        };
      }
    }

    const signatureCheck = await verifyRequiredSignatures(
      transaction,
      compiled,
      requirements.extra.feePayer,
    );
    if (!signatureCheck.ok) {
      return {
        response: { isValid: false, invalidReason: signatureCheck.invalidReason, payer: "" },
        verificationPath: null,
      };
    }

    // Resolve address lookup tables once and reuse the map for every decompile.
    // Standard-wallet payments have no lookups and pay no extra RPC.
    let lookupMap: Record<string, Address[]> | undefined;
    const lookups =
      "addressTableLookups" in compiled && Array.isArray(compiled.addressTableLookups)
        ? compiled.addressTableLookups
        : [];
    if (lookups.length > 0) {
      if (typeof this.signer.fetchAddressLookupTables !== "function") {
        return {
          response: {
            isValid: false,
            invalidReason:
              `${Errors.ErrSmartWalletAltResolutionUnavailable}: transaction uses Address Lookup Tables ` +
              "but signer does not implement fetchAddressLookupTables",
            payer: "",
          },
          verificationPath: null,
        };
      }
      try {
        const altAddresses = lookups.map(l =>
          (l as { lookupTableAddress: { toString(): string } }).lookupTableAddress.toString(),
        );
        const resolved = await this.signer.fetchAddressLookupTables(
          altAddresses,
          requirements.network,
        );
        lookupMap = {};
        for (const [key, addresses] of Object.entries(resolved)) {
          lookupMap[key] = addresses.map(a => a as Address);
        }
      } catch (error) {
        return {
          response: {
            isValid: false,
            invalidReason:
              error instanceof Error ? error.message : Errors.ErrSmartWalletAltResolutionFailed,
            payer: "",
          },
          verificationPath: null,
        };
      }
    }

    let decompiled;
    try {
      decompiled = lookupMap
        ? decompileTransactionMessage(compiled, { addressesByLookupTableAddress: lookupMap })
        : decompileTransactionMessage(compiled);
    } catch {
      return {
        response: {
          isValid: false,
          invalidReason: Errors.ErrTransactionCouldNotBeDecoded,
          payer: "",
        },
        verificationPath: null,
      };
    }

    const decodedView: DecodedTransactionView = {
      transaction,
      compiled,
      decompiled,
      resolvedAccountKeys: resolveAccountKeys(compiled, lookupMap),
    };

    // ─── Path 1: Static validation (standard wallets) ───────────────────
    const staticResult = await this.verifyStaticPath(
      transaction,
      decompiled,
      exactSvmPayload,
      requirements,
      signerAddresses,
    );

    if (staticResult.isValid) {
      return { response: staticResult, verificationPath: "static" };
    }

    // ─── Path 2: Simulation-based verification (smart wallets) ──────────
    // Only fall through to Path 2 when Path 1 failed for a recoverable layout
    // reason (extra/unknown instructions, unexpected count, missing positional
    // transfer). A semantic rejection — wrong amount/mint/recipient/memo,
    // self-spend, or a genuinely failing simulation — describes a transaction
    // that is invalid for this payment regardless of wallet type, so Path 2 must
    // not run; doing so would mask the real reason behind a smart_wallet_* code.
    const staticReasonRecoverable =
      typeof staticResult.invalidReason === "string" &&
      LAYOUT_RECOVERABLE_REASONS.has(staticResult.invalidReason);

    if (this.options?.enableSmartWalletVerification && staticReasonRecoverable) {
      // Program allowlist: only known, audited smart wallet programs can reach Path 2.
      // This prevents custom malicious programs from exploiting the simulation path.
      const allowedPrograms = new Set(
        this.options.smartWalletAllowedPrograms ?? DEFAULT_SMART_WALLET_ALLOWED_PROGRAMS,
      );

      // ComputeBudget and Memo are category-exempt: compute budget is validated
      // by caps, and memo content is verified by Path 2's Step 4a. Neither is a
      // wallet program, so they must not be subject to the wallet-program
      // allowlist. Explicit for-loop instead of .map().filter() because strict
      // TypeScript inference on decompileTransactionMessage's return type is
      // sensitive to which @solana/kit version resolves across peer deps.
      const rawInstructions = (decompiled.instructions ?? []) as ReadonlyArray<{
        programAddress: { toString(): string };
      }>;
      const topLevelPrograms: string[] = [];
      for (const ix of rawInstructions) {
        const addr = ix.programAddress.toString();
        if (addr === COMPUTE_BUDGET_PROGRAM_ADDRESS.toString() || addr === MEMO_PROGRAM_ADDRESS) {
          continue;
        }
        topLevelPrograms.push(addr);
      }

      const disallowedProgram = topLevelPrograms.find(addr => !allowedPrograms.has(addr));
      if (disallowedProgram) {
        return {
          response: {
            isValid: false,
            invalidReason: `${Errors.ErrSmartWalletProgramNotAllowed}: ${disallowedProgram}`,
            payer: "",
          },
          verificationPath: null,
        };
      }

      const feePayer = requirements.extra.feePayer;
      const smartWalletResult = await verifySmartWalletTransaction(
        exactSvmPayload.transaction,
        requirements,
        this.signer as SmartWalletVerifySigner,
        feePayer,
        signerAddresses,
        {
          enabled: true,
          maxComputeUnits: this.options.smartWalletMaxComputeUnits,
          maxPriorityFeeMicroLamports: this.options.smartWalletMaxPriorityFeeMicroLamports,
        },
        decodedView,
      );
      const { matchedTransfer, ...response } = smartWalletResult;
      return {
        response,
        verificationPath: smartWalletResult.isValid ? "smartWallet" : null,
        matchedTransfer,
      };
    }

    return { response: staticResult, verificationPath: null };
  }

  /**
   * Path 1: Static instruction-layout verification for standard wallets.
   * Validates positional instruction structure, program allowlist, and
   * transfer details. Unchanged from the original implementation.
   *
   * @param transaction - Decoded transaction to verify
   * @param decompiled - Pre-decompiled message (lookups already resolved)
   * @param exactSvmPayload - The raw SVM payload containing the base64 transaction
   * @param requirements - Payment requirements to verify against
   * @param signerAddresses - Facilitator signer addresses (for self-spend protection)
   * @returns Verification result
   */
  private async verifyStaticPath(
    transaction: ReturnType<typeof decodeTransactionFromPayload>,
    decompiled: ReturnType<typeof decompileTransactionMessage>,
    exactSvmPayload: ExactSvmPayloadV2,
    requirements: PaymentRequirements,
    signerAddresses: string[],
  ): Promise<VerifyResponse> {
    const rawInstructions = decompiled.instructions ?? [];

    // Phantom brackets the transfer with its Lighthouse guards - some inserted
    // before the TransferChecked and some appended after it (see #2097), so
    // guard position cannot be assumed. Validate the payment instructions
    // positionally with the guards filtered out, and bound the guard count
    // separately.
    const lighthouseInstructions = rawInstructions.filter(
      ix => ix.programAddress.toString() === LIGHTHOUSE_PROGRAM_ADDRESS,
    );
    const instructions = rawInstructions.filter(
      ix => ix.programAddress.toString() !== LIGHTHOUSE_PROGRAM_ADDRESS,
    );

    // Allow 3-4 payment instructions:
    // - 3 instructions: ComputeLimit + ComputePrice + TransferChecked
    // - 4 instructions: ComputeLimit + ComputePrice + TransferChecked + Memo
    // plus up to MAX_LIGHTHOUSE_INSTRUCTIONS wallet-injected Lighthouse guards
    // at any position.
    // See: https://github.com/x402-foundation/x402/issues/828
    //  and: https://github.com/x402-foundation/x402/issues/2097
    if (
      instructions.length < 3 ||
      instructions.length > 4 ||
      lighthouseInstructions.length > MAX_LIGHTHOUSE_INSTRUCTIONS
    ) {
      return {
        isValid: false,
        invalidReason: Errors.ErrTransactionInstructionsLength,
        payer: "",
      };
    }

    // Step 3: Verify Compute Budget Instructions
    try {
      this.verifyComputeLimitInstruction(instructions[0] as never);
      this.verifyComputePriceInstruction(instructions[1] as never);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        isValid: false,
        invalidReason: errorMessage,
        payer: "",
      };
    }

    const payer = getTokenPayerFromTransaction(transaction);
    if (!payer) {
      return {
        isValid: false,
        invalidReason: Errors.ErrNoTransferInstruction,
        payer: "",
      };
    }

    // Step 4: Verify Transfer Instruction
    const transferIx = instructions[2];
    const programAddress = transferIx.programAddress.toString();

    if (
      programAddress !== TOKEN_PROGRAM_ADDRESS.toString() &&
      programAddress !== TOKEN_2022_PROGRAM_ADDRESS.toString()
    ) {
      return {
        isValid: false,
        invalidReason: Errors.ErrNoTransferInstruction,
        payer,
      };
    }

    // parseTransferCheckedInstruction does not assert discriminator 12.
    const ixData = transferIx.data;
    if (!ixData || ixData.length < 10 || ixData[0] !== IX_TOKEN_TRANSFER_CHECKED) {
      return {
        isValid: false,
        invalidReason: Errors.ErrNoTransferInstruction,
        payer,
      };
    }

    // Parse the transfer instruction using the appropriate library helper
    let parsedTransfer;
    try {
      if (programAddress === TOKEN_PROGRAM_ADDRESS.toString()) {
        parsedTransfer = parseTransferCheckedInstructionToken(transferIx as never);
      } else {
        parsedTransfer = parseTransferCheckedInstruction2022(transferIx as never);
      }
    } catch {
      return {
        isValid: false,
        invalidReason: Errors.ErrNoTransferInstruction,
        payer,
      };
    }

    // Verify that the facilitator's signers are not transferring their own funds
    // SECURITY: Prevent facilitator from signing away their own tokens
    const authorityAddress = parsedTransfer.accounts.authority.address.toString();
    if (signerAddresses.includes(authorityAddress)) {
      return {
        isValid: false,
        invalidReason: Errors.ErrFeePayerTransferringFunds,
        payer,
      };
    }

    // Verify mint address matches requirements
    const mintAddress = parsedTransfer.accounts.mint.address.toString();
    if (mintAddress !== requirements.asset) {
      return {
        isValid: false,
        invalidReason: Errors.ErrMintMismatch,
        payer,
      };
    }

    // Verify destination ATA matches expected ATA for payTo address
    const destATA = parsedTransfer.accounts.destination.address.toString();
    try {
      const [expectedDestATA] = await findAssociatedTokenPda({
        mint: requirements.asset as Address,
        owner: requirements.payTo as Address,
        tokenProgram:
          programAddress === TOKEN_PROGRAM_ADDRESS.toString()
            ? (TOKEN_PROGRAM_ADDRESS as Address)
            : (TOKEN_2022_PROGRAM_ADDRESS as Address),
      });

      if (destATA !== expectedDestATA.toString()) {
        return {
          isValid: false,
          invalidReason: Errors.ErrRecipientMismatch,
          payer,
        };
      }
    } catch {
      return {
        isValid: false,
        invalidReason: Errors.ErrRecipientMismatch,
        payer,
      };
    }

    // Verify transfer amount meets requirements
    const amount = parsedTransfer.data.amount;
    if (amount !== BigInt(requirements.amount)) {
      return {
        isValid: false,
        invalidReason: Errors.ErrAmountMismatch,
        payer,
      };
    }

    // Step 5: Verify optional instructions (if present)
    // Lighthouse guards were filtered out above, so the only allowed optional
    // payment instruction is Memo (uniqueness)
    const optionalInstructions = instructions.slice(3);
    const invalidReasonByIndex = [
      Errors.ErrUnknownFourthInstruction,
      Errors.ErrUnknownFifthInstruction,
      Errors.ErrUnknownSixthInstruction,
      Errors.ErrUnknownSeventhInstruction,
    ];

    for (let i = 0; i < optionalInstructions.length; i += 1) {
      const programAddress = optionalInstructions[i].programAddress.toString();
      if (
        programAddress === LIGHTHOUSE_PROGRAM_ADDRESS ||
        programAddress === MEMO_PROGRAM_ADDRESS
      ) {
        continue;
      }

      return {
        isValid: false,
        invalidReason: invalidReasonByIndex[i] ?? Errors.ErrUnknownOptionalInstruction,
        payer,
      };
    }

    // Step 5b: Verify memo content matches extra.memo when present
    const expectedMemo = requirements.extra?.memo as string | undefined;
    if (expectedMemo) {
      const memoInstructions = optionalInstructions.filter(
        ix => ix.programAddress.toString() === MEMO_PROGRAM_ADDRESS,
      );
      if (memoInstructions.length !== 1) {
        return {
          isValid: false,
          invalidReason: Errors.ErrMemoCount,
          payer,
        };
      }
      const memoData = memoInstructions[0].data;
      const actualMemo = memoData ? new TextDecoder().decode(new Uint8Array(memoData)) : "";
      if (actualMemo !== expectedMemo) {
        return {
          isValid: false,
          invalidReason: Errors.ErrMemoMismatch,
          payer,
        };
      }
    }

    // Step 6: Simulate Transaction
    // CRITICAL: Simulation proves transaction will succeed (catches insufficient balance, invalid accounts, etc)
    // Signatures are verified locally; the fee-payer slot is unsigned until settle.
    try {
      await this.signer.simulateTransaction(exactSvmPayload.transaction, requirements.network);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        isValid: false,
        invalidReason: Errors.ErrTransactionSimulationFailed,
        invalidMessage: errorMessage,
        payer,
      };
    }

    return {
      isValid: true,
      invalidReason: undefined,
      payer,
    };
  }

  /**
   * Verify that the compute limit instruction is valid.
   *
   * @param instruction - The compute limit instruction
   * @param instruction.programAddress - Program address
   * @param instruction.data - Instruction data bytes
   */
  private verifyComputeLimitInstruction(instruction: {
    programAddress: Address;
    data?: Readonly<Uint8Array>;
  }): void {
    const programAddress = instruction.programAddress.toString();

    if (
      programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS.toString() ||
      !instruction.data ||
      instruction.data[0] !== 2 // discriminator for SetComputeUnitLimit
    ) {
      throw new Error(Errors.ErrComputeLimitInstruction);
    }

    try {
      const parsedInstruction = parseSetComputeUnitLimitInstruction(instruction as never);

      const maxComputeUnits = this.options?.maxComputeUnits;
      if (maxComputeUnits !== undefined && parsedInstruction.data.units > maxComputeUnits) {
        throw new Error(Errors.ErrComputeLimitInstructionTooHigh);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("too_high")) {
        throw error;
      }
      throw new Error(Errors.ErrComputeLimitInstruction);
    }
  }

  /**
   * Verify that the compute price instruction is valid.
   *
   * @param instruction - The compute price instruction
   * @param instruction.programAddress - Program address
   * @param instruction.data - Instruction data bytes
   */
  private verifyComputePriceInstruction(instruction: {
    programAddress: Address;
    data?: Readonly<Uint8Array>;
  }): void {
    const programAddress = instruction.programAddress.toString();

    if (
      programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS.toString() ||
      !instruction.data ||
      instruction.data[0] !== 3 // discriminator for SetComputeUnitPrice
    ) {
      throw new Error(Errors.ErrComputePriceInstruction);
    }

    try {
      const parsedInstruction = parseSetComputeUnitPriceInstruction(instruction as never);

      // Check if price exceeds the operator-configured maximum (default 5 lamports per compute unit)
      const maxPriorityFee =
        this.options?.maxPriorityFeeMicroLamports ?? MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS;
      if (parsedInstruction.data.microLamports > BigInt(maxPriorityFee)) {
        throw new Error(Errors.ErrComputePriceInstructionTooHigh);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("too_high")) {
        throw error;
      }
      throw new Error(Errors.ErrComputePriceInstruction);
    }
  }
}
