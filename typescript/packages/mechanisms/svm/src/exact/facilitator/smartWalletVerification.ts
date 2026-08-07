/**
 * Smart wallet verification via simulation-based outcome analysis.
 *
 * Instead of parsing proprietary smart wallet instruction formats, this module
 * verifies payment outcomes by inspecting the CPI trace from transaction simulation.
 * Works for any smart wallet program (Squads, Swig, SPL Governance, etc.) that
 * ultimately executes a TransferChecked via CPI.
 */

import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token-2022";
import {
  decompileTransactionMessage,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  type Address,
  type Transaction,
} from "@solana/kit";
import type { PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { MEMO_PROGRAM_ADDRESS } from "../../constants";
import type { FacilitatorSvmSigner, SvmInnerInstructionsResult } from "../../signer";
import { decodeTransactionFromPayload } from "../../utils";

const DEFAULT_SMART_WALLET_MAX_COMPUTE_UNITS = 400_000;
const DEFAULT_SMART_WALLET_MAX_PRIORITY_FEE_MICROLAMPORTS = 50_000;

const IX_SET_COMPUTE_UNIT_LIMIT = 2;
const IX_SET_COMPUTE_UNIT_PRICE = 3;
const IX_TOKEN_TRANSFER_CHECKED = 12;

const TOKEN_PROGRAMS = new Set([
  TOKEN_PROGRAM_ADDRESS.toString(),
  TOKEN_2022_PROGRAM_ADDRESS.toString(),
]);

export type TransferCheckedInfo = {
  programId: string;
  amount: bigint;
  mint: string;
  destination: string;
  authority: string;
};

/**
 * Asserts the fee payer does NOT appear in any instruction's accounts or as a
 * program ID. If the fee payer is never referenced in any instruction, the
 * Solana runtime cannot authorize it for token transfers, account creation,
 * approvals, or any operation that requires a signer in the accounts list.
 * The fee payer only pays the transaction fee automatically.
 *
 * @param transaction - Decoded transaction to inspect
 * @param feePayerAddress - Facilitator fee payer address that must remain isolated
 * @param signer - Optional facilitator signer for resolving Address Lookup Tables
 * @param network - Optional CAIP-2 network identifier for ALT resolution RPC calls
 */
export async function assertFeePayerIsolated(
  transaction: Transaction,
  feePayerAddress: string,
  signer?: FacilitatorSvmSigner,
  network?: string,
): Promise<void> {
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);

  // Check if transaction uses Address Lookup Tables
  const hasALTs =
    "addressTableLookups" in compiled &&
    Array.isArray(compiled.addressTableLookups) &&
    compiled.addressTableLookups.length > 0;

  let decompiled;
  if (hasALTs) {
    // Resolve ALTs before decompiling so all accounts are visible
    if (!signer || !network || typeof signer.fetchAddressLookupTables !== "function") {
      throw new Error(
        "smart_wallet_alt_resolution_not_available: transaction uses Address Lookup Tables " +
          "but signer does not implement fetchAddressLookupTables",
      );
    }

    const altAddresses = (
      compiled.addressTableLookups as Array<{ lookupTableAddress: string }>
    ).map(l => l.lookupTableAddress.toString());
    const resolved = await signer.fetchAddressLookupTables(altAddresses, network);

    // Convert to the format decompileTransactionMessage expects
    const addressesByLookupTableAddress: Record<string, Array<Address>> = {};
    for (const [key, addresses] of Object.entries(resolved)) {
      addressesByLookupTableAddress[key] = addresses.map(a => a as Address);
    }

    decompiled = decompileTransactionMessage(compiled, { addressesByLookupTableAddress });
  } else {
    decompiled = decompileTransactionMessage(compiled);
  }

  const instructions = decompiled.instructions ?? [];

  for (const ix of instructions) {
    if (ix.programAddress.toString() === feePayerAddress) {
      throw new Error(
        `smart_wallet_fee_payer_not_isolated: fee payer ${feePayerAddress} invoked as program`,
      );
    }

    const accounts = ix.accounts ?? [];
    for (const account of accounts) {
      if (account.address.toString() === feePayerAddress) {
        throw new Error(
          `smart_wallet_fee_payer_not_isolated: fee payer ${feePayerAddress} appears in instruction accounts (program: ${ix.programAddress})`,
        );
      }
    }
  }
}

/**
 * Validates ComputeBudget instructions without enforcing a program allowlist.
 * Caps compute units and priority fees to bound the facilitator's fee exposure.
 *
 * @param transaction - Decoded transaction to inspect
 * @param limits - Optional operator-provided overrides for compute budget caps
 * @param limits.maxComputeUnits - Maximum allowed compute units
 * @param limits.maxPriorityFeeMicroLamports - Maximum allowed priority fee in microlamports
 */
export function validateComputeBudgetLimits(
  transaction: Transaction,
  limits?: { maxComputeUnits?: number; maxPriorityFeeMicroLamports?: number },
): void {
  const maxCU = limits?.maxComputeUnits ?? DEFAULT_SMART_WALLET_MAX_COMPUTE_UNITS;
  const maxPriorityFee =
    limits?.maxPriorityFeeMicroLamports ?? DEFAULT_SMART_WALLET_MAX_PRIORITY_FEE_MICROLAMPORTS;

  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const decompiled = decompileTransactionMessage(compiled);
  const instructions = decompiled.instructions ?? [];

  for (const ix of instructions) {
    if (ix.programAddress.toString() !== COMPUTE_BUDGET_PROGRAM_ADDRESS.toString()) continue;
    const data = ix.data;
    if (!data || data.length === 0) {
      throw new Error("smart_wallet_malformed_compute_budget: empty instruction data");
    }

    if (data[0] === IX_SET_COMPUTE_UNIT_LIMIT) {
      if (data.length < 5) {
        throw new Error("smart_wallet_malformed_compute_limit");
      }
      const units = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, true);
      if (units > maxCU) {
        throw new Error(`smart_wallet_compute_units_too_high: ${units} exceeds max ${maxCU}`);
      }
      continue;
    }

    if (data[0] === IX_SET_COMPUTE_UNIT_PRICE) {
      if (data.length < 9) {
        throw new Error("smart_wallet_malformed_compute_price");
      }
      const microLamports = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      ).getBigUint64(1, true);
      if (microLamports > BigInt(maxPriorityFee)) {
        throw new Error(
          `smart_wallet_priority_fee_too_high: ${microLamports} exceeds max ${maxPriorityFee}`,
        );
      }
      continue;
    }

    // Only SetComputeUnitLimit (2) and SetComputeUnitPrice (3) are accepted.
    // Other ComputeBudget types (RequestHeapFrame, SetLoadedAccountsDataSizeLimit, etc.)
    // are rejected because they expand execution surface without being necessary
    // for payment outcome verification.
    throw new Error(`smart_wallet_unsupported_compute_budget_instruction: type ${data[0]}`);
  }
}

/**
 * Extracts TransferChecked instructions from simulation inner instructions
 * (CPI trace). Handles both parsed and compiled formats from the Solana RPC.
 *
 * @param innerInstructions - Inner instructions from simulation result
 * @param accountKeys - Static account keys from the compiled transaction message
 * @returns Array of extracted TransferChecked instructions
 */
export function extractTransfersFromInnerInstructions(
  innerInstructions: SvmInnerInstructionsResult["innerInstructions"],
  accountKeys: readonly string[],
): TransferCheckedInfo[] {
  if (!innerInstructions) return [];

  const transfers: TransferCheckedInfo[] = [];

  for (const group of innerInstructions) {
    for (const ix of group.instructions) {
      const ixAny = ix as Record<string, unknown>;

      // Parsed format (jsonParsed encoding)
      const parsed = ixAny.parsed as { type?: string; info?: Record<string, unknown> } | undefined;
      if (parsed && parsed.type === "transferChecked" && parsed.info) {
        const programId = String(ixAny.programId ?? "");
        if (!TOKEN_PROGRAMS.has(programId)) continue;

        const info = parsed.info;
        const tokenAmount = info.tokenAmount as { amount?: string } | undefined;
        const amountStr = tokenAmount?.amount ?? String(info.amount ?? "0");

        transfers.push({
          programId,
          amount: BigInt(amountStr),
          mint: String(info.mint ?? ""),
          destination: String(info.destination ?? ""),
          authority: String(info.authority ?? info.owner ?? ""),
        });
        continue;
      }

      // Compiled format (programIdIndex + accounts + data as base58)
      const programIdIndex = ixAny.programIdIndex as number | undefined;
      const accounts = ixAny.accounts as number[] | undefined;
      const dataStr = ixAny.data as string | undefined;
      if (programIdIndex == null || !accounts || !dataStr) continue;

      const programId = accountKeys[programIdIndex];
      if (!programId || !TOKEN_PROGRAMS.has(programId)) continue;

      let data: Uint8Array;
      try {
        data = getBase58Encoder().encode(dataStr) as Uint8Array;
      } catch {
        continue;
      }

      if (data[0] !== IX_TOKEN_TRANSFER_CHECKED) continue;
      if (data.length < 9 || accounts.length < 4) continue;

      const amount = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(
        1,
        true,
      );
      const mint = accountKeys[accounts[1]];
      const destination = accountKeys[accounts[2]];
      const authority = accountKeys[accounts[3]];
      if (!mint || !destination || !authority) continue;

      transfers.push({ programId, amount, mint, destination, authority });
    }
  }

  return transfers;
}

/**
 * Operator-configurable options for smart wallet verification.
 * Passed through from the ExactSvmScheme constructor.
 */
export type SmartWalletOptions = {
  enabled: boolean;
  maxComputeUnits?: number;
  maxPriorityFeeMicroLamports?: number;
};

/**
 * Full smart wallet verification pipeline.
 * Called when static verification rejects a transaction due to unknown programs.
 *
 * 1. Assert fee payer isolation
 * 2. Validate compute budget caps
 * 3. Simulate with inner instructions
 * 4. Extract and match TransferChecked from CPI trace
 *
 * @param transactionBase64 - Base64 encoded transaction
 * @param requirements - Payment requirements to verify against
 * @param signer - Facilitator signer (must implement simulateTransactionWithInnerInstructions)
 * @param feePayerAddress - Facilitator fee payer address
 * @param signerAddresses - All facilitator signer addresses (for self-spend protection)
 * @param options - Optional operator-configurable limits
 * @returns Verification result
 */
export async function verifySmartWalletTransaction(
  transactionBase64: string,
  requirements: PaymentRequirements,
  signer: FacilitatorSvmSigner,
  feePayerAddress: string,
  signerAddresses: readonly string[],
  options?: SmartWalletOptions,
): Promise<VerifyResponse> {
  const transaction = decodeTransactionFromPayload({ transaction: transactionBase64 });

  // 1. Fee payer must not appear in any instruction's accounts.
  try {
    await assertFeePayerIsolated(transaction, feePayerAddress, signer, requirements.network);
  } catch (error) {
    return {
      isValid: false,
      invalidReason: error instanceof Error ? error.message : "smart_wallet_fee_payer_not_isolated",
      payer: "",
    };
  }

  // 2. Compute budget caps still apply (operator-configurable).
  try {
    validateComputeBudgetLimits(transaction, {
      maxComputeUnits: options?.maxComputeUnits,
      maxPriorityFeeMicroLamports: options?.maxPriorityFeeMicroLamports,
    });
  } catch (error) {
    return {
      isValid: false,
      invalidReason:
        error instanceof Error ? error.message : "smart_wallet_compute_budget_violation",
      payer: "",
    };
  }

  // 3. Simulate with inner instructions.
  if (typeof signer.simulateTransactionWithInnerInstructions !== "function") {
    return {
      isValid: false,
      invalidReason: "smart_wallet_verification_not_available",
      payer: "",
    };
  }

  let simResult: SvmInnerInstructionsResult;
  try {
    simResult = await signer.simulateTransactionWithInnerInstructions(
      transactionBase64,
      feePayerAddress as Address,
      requirements.network,
    );
  } catch (error) {
    return {
      isValid: false,
      invalidReason: `smart_wallet_simulation_failed: ${error instanceof Error ? error.message : String(error)}`,
      payer: "",
    };
  }

  // 4. Extract TransferChecked from top-level instructions and CPI inner instructions.
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const decompiled = decompileTransactionMessage(compiled);
  const accountKeys = (compiled.staticAccounts ?? []).map(String);

  // 4a. Verify memo content matches extra.memo when present.
  // Mirrors Path 1's Step 5b enforcement so a seller-required memo cannot be
  // bypassed by routing through a smart wallet. The memo program is a standalone
  // top-level instruction in both paths; wallet programs do not wrap it via CPI.
  const expectedMemo = requirements.extra?.memo as string | undefined;
  if (expectedMemo) {
    const memoInstructions = (decompiled.instructions ?? []).filter(
      ix => ix.programAddress.toString() === MEMO_PROGRAM_ADDRESS,
    );
    if (memoInstructions.length !== 1) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_memo_count",
        payer: "",
      };
    }
    const memoData = memoInstructions[0].data;
    const actualMemo = memoData ? new TextDecoder().decode(new Uint8Array(memoData)) : "";
    if (actualMemo !== expectedMemo) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_memo_mismatch",
        payer: "",
      };
    }
  }

  const allTransfers: TransferCheckedInfo[] = [];

  for (const ix of decompiled.instructions ?? []) {
    const progId = ix.programAddress.toString();
    if (!TOKEN_PROGRAMS.has(progId)) continue;
    const data = ix.data;
    if (!data || data[0] !== IX_TOKEN_TRANSFER_CHECKED || data.length < 9) continue;
    const accts = ix.accounts ?? [];
    if (accts.length < 4) continue;
    const amount = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(
      1,
      true,
    );
    allTransfers.push({
      programId: progId,
      amount,
      mint: accts[1].address.toString(),
      destination: accts[2].address.toString(),
      authority: accts[3].address.toString(),
    });
  }

  allTransfers.push(
    ...extractTransfersFromInnerInstructions(simResult.innerInstructions, accountKeys),
  );

  // Fee payer must not be the authority on any transfer.
  for (const t of allTransfers) {
    if (signerAddresses.includes(t.authority)) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_transaction_fee_payer_transferring_funds",
        payer: t.authority,
      };
    }
  }

  // Derive expected destination ATAs for both token programs.
  // ATA derivation is a pure local PDA computation (no RPC), so both always succeed.
  // A transfer matches if its destination equals the ATA for its token program.
  const expectedATAs = new Set<string>();
  for (const tokenProgram of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
    try {
      const [ata] = await findAssociatedTokenPda({
        mint: requirements.asset as Address,
        owner: requirements.payTo as Address,
        tokenProgram: tokenProgram as unknown as Address,
      });
      expectedATAs.add(ata.toString());
    } catch {
      // Invalid address format — skip this program
    }
  }

  if (expectedATAs.size === 0) {
    return {
      isValid: false,
      invalidReason: "smart_wallet_cannot_derive_destination_ata",
      payer: "",
    };
  }

  const requiredAmount = BigInt(requirements.amount);
  const matchingTransfers = allTransfers.filter(
    t =>
      t.mint === requirements.asset &&
      expectedATAs.has(t.destination) &&
      t.amount >= requiredAmount,
  );

  if (matchingTransfers.length === 0) {
    if (allTransfers.length === 0) {
      return { isValid: false, invalidReason: "smart_wallet_no_transfer_in_simulation", payer: "" };
    }
    return {
      isValid: false,
      invalidReason: "smart_wallet_transfer_mismatch",
      payer: allTransfers[0].authority,
    };
  }

  if (matchingTransfers.length > 1) {
    return {
      isValid: false,
      invalidReason: "smart_wallet_multiple_matching_transfers",
      payer: matchingTransfers[0].authority,
    };
  }

  return { isValid: true, payer: matchingTransfers[0].authority };
}

/**
 * Post-settlement verification for smart wallet transactions.
 *
 * After a transaction confirms on-chain, verifies the TransferChecked actually
 * executed by inspecting the confirmed transaction's inner instructions.
 * Falls back to balance-delta checking if the RPC's transaction index has lag.
 *
 * This closes the TOCTOU gap where a malicious program could pass simulation
 * but skip the transfer during on-chain execution.
 *
 * @param signer - Facilitator signer with optional getConfirmedTransactionInnerInstructions
 * @param signature - Confirmed transaction signature
 * @param network - CAIP-2 network identifier
 * @param requirements - Payment requirements (asset, payTo, amount)
 * @param signerAddresses - Facilitator signer addresses
 * @param balanceBefore - Destination ATA balance before settlement (for fallback)
 * @param balanceBeforeTokenProgram - Which token program the balanceBefore was captured from (SPL Token or Token-2022)
 * @returns Whether the transfer was verified on-chain
 */
export async function verifyPostSettlement(
  signer: FacilitatorSvmSigner,
  signature: string,
  network: string,
  requirements: PaymentRequirements,
  signerAddresses: string[],
  balanceBefore: bigint | null,
  balanceBeforeTokenProgram?: string | null,
): Promise<{ verified: boolean; method: "innerInstructions" | "balanceDelta" | "unverified" }> {
  const requiredAmount = BigInt(requirements.amount);

  // Primary path: fetch confirmed transaction and inspect inner instructions.
  // Retry with backoff to handle RPC indexing lag (transaction confirmed but
  // not yet indexed). Same polling pattern as confirmTransaction in the SVM signer.
  if (typeof signer.getConfirmedTransactionInnerInstructions === "function") {
    let confirmed: SvmInnerInstructionsResult | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        confirmed = await signer.getConfirmedTransactionInnerInstructions(signature, network);
        if (confirmed?.innerInstructions) break;
      } catch {
        // RPC error — retry
      }
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }

    try {
      if (confirmed?.innerInstructions) {
        // Reuse the same extraction logic used for simulation results.
        // We pass an empty accountKeys array because the confirmed transaction's
        // inner instructions from jsonParsed encoding are already in parsed format
        // (programId as string, not index), so index-based resolution isn't needed.
        const transfers = extractTransfersFromInnerInstructions(confirmed.innerInstructions, []);

        // Derive expected destination ATAs (same logic as in verifySmartWalletTransaction).
        const expectedATAs = new Set<string>();
        for (const tokenProgram of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
          try {
            const [ata] = await findAssociatedTokenPda({
              mint: requirements.asset as Address,
              owner: requirements.payTo as Address,
              tokenProgram: tokenProgram as unknown as Address,
            });
            expectedATAs.add(ata.toString());
          } catch {
            // Skip invalid address combinations
          }
        }

        const matching = transfers.filter(
          t =>
            t.mint === requirements.asset &&
            expectedATAs.has(t.destination) &&
            t.amount >= requiredAmount &&
            !signerAddresses.includes(t.authority),
        );

        if (matching.length >= 1) {
          return { verified: true, method: "innerInstructions" };
        }

        // Inner instructions fetched but no matching transfer found.
        // The malicious program skipped the CPI. TOCTOU caught.
        return { verified: false, method: "innerInstructions" };
      }
    } catch {
      // getTransaction failed or returned null (indexing lag). Fall through to balance delta.
    }
  }

  // Fallback: balance-delta check.
  // If we recorded balanceBefore and the signer supports getTokenAccountBalance,
  // check whether the destination ATA balance increased by at least the required amount.
  // Try both SPL Token and Token-2022 programs — the payment may use either.
  if (balanceBefore !== null && typeof signer.getTokenAccountBalance === "function") {
    // If we know which token program was used for balanceBefore, check that one first.
    // Otherwise try both (SPL Token first, then Token-2022).
    const tokenProgramsToCheck = balanceBeforeTokenProgram
      ? [
          balanceBeforeTokenProgram as Address,
          ...(balanceBeforeTokenProgram === TOKEN_PROGRAM_ADDRESS.toString()
            ? [TOKEN_2022_PROGRAM_ADDRESS as unknown as Address]
            : [TOKEN_PROGRAM_ADDRESS as unknown as Address]),
        ]
      : [
          TOKEN_PROGRAM_ADDRESS as unknown as Address,
          TOKEN_2022_PROGRAM_ADDRESS as unknown as Address,
        ];

    let anyBalanceChecked = false;
    for (const tokenProgram of tokenProgramsToCheck) {
      try {
        const [destinationAta] = await findAssociatedTokenPda({
          mint: requirements.asset as Address,
          owner: requirements.payTo as Address,
          tokenProgram,
        });

        const balanceAfter = await signer.getTokenAccountBalance(
          destinationAta.toString(),
          network,
        );

        if (balanceAfter !== null) {
          anyBalanceChecked = true;
          if (balanceAfter - balanceBefore >= requiredAmount) {
            return { verified: true, method: "balanceDelta" };
          }
        }
      } catch {
        // ATA doesn't exist or balance check failed for this token program. Try next.
      }
    }

    if (anyBalanceChecked) {
      // We got balance data but it didn't show sufficient increase.
      return { verified: false, method: "balanceDelta" };
    }
    // All balance checks threw — fall through to unverified.
  }

  // Neither verification method available or both failed.
  // Return unverified — caller decides policy.
  return { verified: false, method: "unverified" };
}
