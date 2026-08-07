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
} from "@solana/kit";
import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
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
  transactionMessageHash,
} from "../../utils";
import { verifySmartWalletTransaction, verifyPostSettlement } from "./smartWalletVerification";

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
  "invalid_exact_svm_payload_transaction_instructions_length",
  "invalid_exact_svm_payload_no_transfer_instruction",
  "invalid_exact_svm_payload_unknown_fourth_instruction",
  "invalid_exact_svm_payload_unknown_fifth_instruction",
  "invalid_exact_svm_payload_unknown_sixth_instruction",
  "invalid_exact_svm_payload_unknown_optional_instruction",
  "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction",
  "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction",
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
   *
   * Default: 400,000
   */
  smartWalletMaxComputeUnits?: number;

  /**
   * Maximum priority fee in microlamports for smart wallet transactions.
   * Only applies when enableSmartWalletVerification is true.
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
};

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

    if (this.options?.enableSmartWalletVerification) {
      // fetchAddressLookupTables is required too: assertFeePayerIsolated can't
      // inspect ALT-resolved accounts without it, so an ALT-using wallet would
      // otherwise fail at verify time rather than at construction.
      const required = [
        "simulateTransactionWithInnerInstructions",
        "getConfirmedTransactionInnerInstructions",
        "getTokenAccountBalance",
        "fetchAddressLookupTables",
      ] as const;

      for (const method of required) {
        if (typeof (this.signer as Record<string, unknown>)[method] !== "function") {
          throw new Error(
            `enableSmartWalletVerification requires ${method} on the signer. ` +
              `Use toFacilitatorSvmSigner() which provides all required methods.`,
          );
        }
      }
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

    const { response: valid, verificationPath } = await this._verify(payload, requirements);
    if (!valid.isValid) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: valid.invalidReason ?? "verification_failed",
        payer: valid.payer || "",
      };
    }

    // Decode the transaction to compute the message hash used as the cache key.
    // Must remain synchronous (before any await) so concurrent settle calls for
    // the same payment are caught before any async work begins.
    const decodedTx = decodeTransactionFromPayload(exactSvmPayload);

    // Duplicate settlement check keyed on message hash (immune to mutable fee-payer sig at slot 0).
    const txKey = transactionMessageHash(decodedTx);
    if (this.settlementCache.isDuplicate(txKey)) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "duplicate_settlement",
        payer: valid.payer || "",
      };
    }

    // Settlements verified through Path 2 (smart wallet) require post-settlement
    // verification to defend against TOCTOU. _verify reports the path directly,
    // so we no longer re-decode the transaction to infer it.
    const isSmartWalletSettlement = verificationPath === "smartWallet";

    // For smart wallet settlements: record destination ATA balance before sending.
    // Used as fallback verification if getTransaction has indexing lag.
    // Try both SPL Token and Token-2022 programs — the payment may use either.
    let balanceBefore: bigint | null = null;
    let balanceBeforeTokenProgram:
      | typeof TOKEN_PROGRAM_ADDRESS
      | typeof TOKEN_2022_PROGRAM_ADDRESS
      | null = null;
    if (isSmartWalletSettlement && typeof this.signer.getTokenAccountBalance === "function") {
      for (const tokenProgram of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
        try {
          const [destinationAta] = await findAssociatedTokenPda({
            mint: requirements.asset as Address,
            owner: requirements.payTo as Address,
            tokenProgram: tokenProgram as unknown as Address,
          });
          const balance = await this.signer.getTokenAccountBalance(
            destinationAta.toString(),
            requirements.network,
          );
          if (balance !== null) {
            balanceBefore = balance;
            balanceBeforeTokenProgram = tokenProgram;
            break; // Use whichever ATA has a balance (exists on-chain)
          }
        } catch {
          // ATA doesn't exist for this token program. Try the other.
        }
      }
    }

    try {
      // Extract feePayer from requirements (already validated in verify)
      const feePayer = requirements.extra.feePayer as Address;

      // Sign transaction with the feePayer's signer
      const fullySignedTransaction = await this.signer.signTransaction(
        exactSvmPayload.transaction,
        feePayer,
        requirements.network,
      );

      // Send transaction to network
      const signature = await this.signer.sendTransaction(
        fullySignedTransaction,
        requirements.network,
      );

      // Wait for confirmation
      await this.signer.confirmTransaction(signature, requirements.network);

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
          balanceBeforeTokenProgram?.toString() ?? null,
        );

        if (!postVerify.verified) {
          return {
            success: false,
            errorReason: "post_settlement_transfer_not_confirmed",
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
    } catch (error) {
      console.error("Failed to settle transaction:", error);
      return {
        success: false,
        errorReason: "transaction_failed",
        transaction: "",
        network: payload.accepted.network,
        payer: valid.payer || "",
      };
    }
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
        response: { isValid: false, invalidReason: "unsupported_scheme", payer: "" },
        verificationPath: null,
      };
    }

    if (payload.accepted.network !== requirements.network) {
      return {
        response: { isValid: false, invalidReason: "network_mismatch", payer: "" },
        verificationPath: null,
      };
    }

    if (!requirements.extra?.feePayer || typeof requirements.extra.feePayer !== "string") {
      return {
        response: {
          isValid: false,
          invalidReason: "invalid_exact_svm_payload_missing_fee_payer",
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
          invalidReason: "fee_payer_not_managed_by_facilitator",
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
          invalidReason: "invalid_exact_svm_payload_transaction_could_not_be_decoded",
          payer: "",
        },
        verificationPath: null,
      };
    }

    // ─── Path 1: Static validation (standard wallets) ───────────────────
    const staticResult = await this.verifyStaticPath(
      transaction,
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

      const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
      const decompiledForCheck = decompileTransactionMessage(compiled);
      // ComputeBudget and Memo are category-exempt: compute budget is validated
      // by caps, and memo content is verified by Path 2's Step 4a. Neither is a
      // wallet program, so they must not be subject to the wallet-program
      // allowlist. Explicit for-loop instead of .map().filter() because strict
      // TypeScript inference on decompileTransactionMessage's return type is
      // sensitive to which @solana/kit version resolves across peer deps.
      const rawInstructions = (decompiledForCheck.instructions ?? []) as ReadonlyArray<{
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
            invalidReason: `smart_wallet_program_not_allowed: ${disallowedProgram}`,
            payer: "",
          },
          verificationPath: null,
        };
      }

      const feePayer = requirements.extra.feePayer;
      const smartWalletResult = await verifySmartWalletTransaction(
        exactSvmPayload.transaction,
        requirements,
        this.signer,
        feePayer,
        signerAddresses,
        {
          enabled: true,
          maxComputeUnits: this.options.smartWalletMaxComputeUnits,
          maxPriorityFeeMicroLamports: this.options.smartWalletMaxPriorityFeeMicroLamports,
        },
      );
      return {
        response: smartWalletResult,
        verificationPath: smartWalletResult.isValid ? "smartWallet" : null,
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
   * @param exactSvmPayload - The raw SVM payload containing the base64 transaction
   * @param requirements - Payment requirements to verify against
   * @param signerAddresses - Facilitator signer addresses (for self-spend protection)
   * @returns Verification result
   */
  private async verifyStaticPath(
    transaction: ReturnType<typeof decodeTransactionFromPayload>,
    exactSvmPayload: ExactSvmPayloadV2,
    requirements: PaymentRequirements,
    signerAddresses: string[],
  ): Promise<VerifyResponse> {
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    const decompiled = decompileTransactionMessage(compiled);
    const instructions = decompiled.instructions ?? [];

    // Allow 3-7 instructions:
    // - 3 instructions: ComputeLimit + ComputePrice + TransferChecked
    // - 4 instructions: ComputeLimit + ComputePrice + TransferChecked + Lighthouse or Memo
    // - 5 instructions: ComputeLimit + ComputePrice + TransferChecked + Lighthouse + Lighthouse or Memo
    // - 6 instructions: ComputeLimit + ComputePrice + TransferChecked + Lighthouse + Lighthouse + Memo
    // - 7 instructions: + a third wallet-injected Lighthouse (Phantom, see #2097)
    // See: https://github.com/x402-foundation/x402/issues/828
    //  and: https://github.com/x402-foundation/x402/issues/2097
    if (instructions.length < 3 || instructions.length > 7) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_transaction_instructions_length",
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
        invalidReason: "invalid_exact_svm_payload_no_transfer_instruction",
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
        invalidReason: "invalid_exact_svm_payload_no_transfer_instruction",
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
        invalidReason: "invalid_exact_svm_payload_no_transfer_instruction",
        payer,
      };
    }

    // Verify that the facilitator's signers are not transferring their own funds
    // SECURITY: Prevent facilitator from signing away their own tokens
    const authorityAddress = parsedTransfer.accounts.authority.address.toString();
    if (signerAddresses.includes(authorityAddress)) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_transaction_fee_payer_transferring_funds",
        payer,
      };
    }

    // Verify mint address matches requirements
    const mintAddress = parsedTransfer.accounts.mint.address.toString();
    if (mintAddress !== requirements.asset) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_mint_mismatch",
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
          invalidReason: "invalid_exact_svm_payload_recipient_mismatch",
          payer,
        };
      }
    } catch {
      return {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_recipient_mismatch",
        payer,
      };
    }

    // Verify transfer amount meets requirements
    const amount = parsedTransfer.data.amount;
    if (amount !== BigInt(requirements.amount)) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_amount_mismatch",
        payer,
      };
    }

    // Step 5: Verify optional instructions (if present)
    // Allowed optional programs: Lighthouse (wallet protection) and Memo (uniqueness)
    const optionalInstructions = instructions.slice(3);
    const invalidReasonByIndex = [
      "invalid_exact_svm_payload_unknown_fourth_instruction",
      "invalid_exact_svm_payload_unknown_fifth_instruction",
      "invalid_exact_svm_payload_unknown_sixth_instruction",
      "invalid_exact_svm_payload_unknown_seventh_instruction",
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
        invalidReason:
          invalidReasonByIndex[i] ?? "invalid_exact_svm_payload_unknown_optional_instruction",
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
          invalidReason: "invalid_exact_svm_payload_memo_count",
          payer,
        };
      }
      const memoData = memoInstructions[0].data;
      const actualMemo = memoData ? new TextDecoder().decode(new Uint8Array(memoData)) : "";
      if (actualMemo !== expectedMemo) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_svm_payload_memo_mismatch",
          payer,
        };
      }
    }

    // Step 6: Sign and Simulate Transaction
    // CRITICAL: Simulation proves transaction will succeed (catches insufficient balance, invalid accounts, etc)
    try {
      const feePayer = requirements.extra!.feePayer as Address;

      const fullySignedTransaction = await this.signer.signTransaction(
        exactSvmPayload.transaction,
        feePayer,
        requirements.network,
      );

      await this.signer.simulateTransaction(fullySignedTransaction, requirements.network);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        isValid: false,
        invalidReason: "transaction_simulation_failed",
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
      throw new Error(
        "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction",
      );
    }

    try {
      parseSetComputeUnitLimitInstruction(instruction as never);
    } catch {
      throw new Error(
        "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction",
      );
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
      throw new Error(
        "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction",
      );
    }

    try {
      const parsedInstruction = parseSetComputeUnitPriceInstruction(instruction as never);

      // Check if price exceeds maximum (5 lamports per compute unit)
      if (parsedInstruction.data.microLamports > BigInt(MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS)) {
        throw new Error(
          "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high",
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("too_high")) {
        throw error;
      }
      throw new Error(
        "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction",
      );
    }
  }
}
