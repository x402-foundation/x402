import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { FacilitatorHederaSigner } from "../../signer";
import type {
  ExactHederaPayloadV2,
  HederaTransferEntry,
  InspectedHederaTransaction,
} from "../../types";
import {
  extractTransactionFromPayload,
  getPositiveReceivers,
  hederaAccountIdsEqual,
  inspectHederaTransaction,
  isHbarAsset,
  isValidHederaEntityId,
  sumTransfers,
} from "../../utils";
import type { HederaAliasPolicy } from "./config";
import { CRYPTO_TRANSFER_REQUIREMENT_CODES, validateExactRequirements } from "./requirements";

/**
 * Verify an exact Hedera payload.
 *
 * @param signer - Facilitator signer
 * @param payload - Payment payload
 * @param requirements - Matched payment requirements
 * @param aliasPolicy - Alias handling behavior for payTo checks
 * @returns Verification result
 */
export async function verifyCryptoTransfer(
  signer: FacilitatorHederaSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  aliasPolicy: HederaAliasPolicy,
): Promise<VerifyResponse> {
  // Phase 1: requirements and accepted parity checks
  const requirementsValidation = validateRequirements(signer, payload, requirements, aliasPolicy);
  if (requirementsValidation !== null) {
    return requirementsValidation;
  }
  const feePayer = requirements.extra.feePayer as string;

  // Phase 2: decode and inspect transaction
  const exactPayload = payload.payload as ExactHederaPayloadV2;
  let transactionBase64 = "";
  try {
    transactionBase64 = extractTransactionFromPayload(exactPayload);
  } catch {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hedera_payload_transaction_could_not_be_decoded",
      payer: "",
    };
  }

  let inspected;
  try {
    inspected = inspectHederaTransaction(transactionBase64);
  } catch {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hedera_payload_transaction_could_not_be_decoded",
      payer: "",
    };
  }
  const inspectedValidation = validateInspectedTransaction(inspected);
  if (inspectedValidation !== null) {
    return { isValid: false, invalidReason: inspectedValidation, payer: "" };
  }

  // Phase 3: structural and transfer checks
  const transferValidation = validateTransferSemantics(inspected, requirements, feePayer);
  if (transferValidation !== null) {
    return transferValidation;
  }
  const payerTransfers = getAssetTransfers(
    inspected.tokenTransfers,
    inspected.hbarTransfers,
    requirements,
  ) as HederaTransferEntry[];
  const payers = inferPayers(payerTransfers);
  const payer = payers[0]?.accountId ?? "";

  // Phase 4: alias policy check
  const payToValidation = await validatePayToPolicy(signer, requirements, aliasPolicy);
  if (payToValidation !== null) {
    return payToValidation;
  }

  // Phase 5: payer signature verification (fail-closed), checked before
  // preflight so an unsigned/wrong-key payload is rejected first.
  // Spec §4 allows multiple sending accounts, so every debited sender must
  // have signed. Precondition: Phase 3 transfer-semantics guarantees at
  // least one debited account for `asset`, so `payers` is non-empty.
  for (const sender of payers) {
    let signature: { ok: boolean; reason?: string; message?: string };
    try {
      signature = await signer.verifyPayerSignature({
        payer: sender.accountId,
        transaction: transactionBase64,
        network: requirements.network,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isValid: false,
        invalidReason: "invalid_exact_hedera_payload_signature_invalid",
        invalidMessage: message,
        payer,
      };
    }
    if (!signature.ok) {
      const invalidMessage = signature.reason
        ? `${signature.reason}${signature.message ? `: ${signature.message}` : ""}`
        : signature.message;
      return {
        isValid: false,
        invalidReason: "invalid_exact_hedera_payload_signature_invalid",
        invalidMessage,
        payer,
      };
    }
  }

  // Phase 6: onchain preflight (balance + token association), fail-closed.
  // Each sender only funds their own debited portion, so preflight runs per sender with that sender's amount.
  for (const sender of payers) {
    let preflight: { ok: boolean; reason?: string; message?: string };
    try {
      preflight = await signer.preflightTransfer({
        payer: sender.accountId,
        payTo: requirements.payTo,
        asset: requirements.asset,
        amount: sender.amount,
        network: requirements.network,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isValid: false,
        invalidReason: "invalid_exact_hedera_payload_preflight_failed",
        invalidMessage: message,
        payer,
      };
    }
    if (!preflight.ok) {
      const invalidMessage = preflight.reason
        ? `${preflight.reason}${preflight.message ? `: ${preflight.message}` : ""}`
        : preflight.message;
      return {
        isValid: false,
        invalidReason: "invalid_exact_hedera_payload_preflight_failed",
        invalidMessage,
        payer,
      };
    }
  }

  return {
    isValid: true,
    invalidReason: undefined,
    payer,
  };
}

/**
 * Settles a verified exact payment.
 *
 * @param signer - Facilitator signer
 * @param payload - Payment payload
 * @param requirements - Matched requirements
 * @param aliasPolicy - Alias handling behavior for payTo checks
 * @returns Settlement response
 */
export async function settleCryptoTransfer(
  signer: FacilitatorHederaSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  aliasPolicy: HederaAliasPolicy,
): Promise<SettleResponse> {
  const valid = await verifyCryptoTransfer(signer, payload, requirements, aliasPolicy);
  if (!valid.isValid) {
    return {
      success: false,
      network: requirements.network,
      transaction: "",
      errorReason: valid.invalidReason ?? "verification_failed",
      errorMessage: valid.invalidMessage,
      payer: valid.payer || "",
    };
  }

  const feePayer = requirements.extra?.feePayer as string;
  const exactPayload = payload.payload as ExactHederaPayloadV2;
  const transactionBase64 = extractTransactionFromPayload(exactPayload);
  try {
    const settled = await signer.signAndSubmitTransaction(
      transactionBase64,
      feePayer,
      requirements.network,
    );

    return {
      success: true,
      network: requirements.network,
      payer: valid.payer || feePayer,
      transaction: settled.transactionId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      network: requirements.network,
      transaction: "",
      errorReason: "transaction_failed",
      errorMessage: message,
      payer: valid.payer || feePayer,
    };
  }
}

/**
 * Returns the transfer list for requested asset.
 *
 * @param tokenTransfers - Token transfers grouped by token id
 * @param hbarTransfers - Native hbar transfers
 * @param requirements - Payment requirements
 * @returns Transfer list or null when invalid
 */
function getAssetTransfers(
  tokenTransfers: Record<string, HederaTransferEntry[]>,
  hbarTransfers: HederaTransferEntry[],
  requirements: PaymentRequirements,
): HederaTransferEntry[] | null {
  if (isHbarAsset(requirements.asset)) {
    if (Object.keys(tokenTransfers).length > 0) {
      return null;
    }
    return hbarTransfers;
  }

  const tokenIds = Object.keys(tokenTransfers);
  if (tokenIds.length !== 1 || tokenIds[0] !== requirements.asset) {
    return null;
  }

  return tokenTransfers[requirements.asset] ?? null;
}

/**
 * Returns true when account has a negative transfer entry.
 *
 * @param transfers - Transfer list
 * @param accountId - Account id
 * @returns Whether account is debited
 */
function hasNegativeTransfer(transfers: HederaTransferEntry[], accountId: string): boolean {
  return transfers.some(
    entry => hederaAccountIdsEqual(entry.accountId, accountId) && BigInt(entry.amount) < 0n,
  );
}

/**
 * Infers every debited sender from the asset transfers, summing each
 * account's debited magnitude. Spec §4 permits multiple sending accounts,
 * so all of them are returned (each funds only their own portion).
 *
 * @param transfers - Asset transfers
 * @returns Distinct debited accounts with their absolute debited amount
 */
function inferPayers(
  transfers: HederaTransferEntry[],
): Array<{ accountId: string; amount: string }> {
  const debited = new Map<string, bigint>();
  for (const entry of transfers) {
    const amount = BigInt(entry.amount);
    if (amount < 0n) {
      debited.set(entry.accountId, (debited.get(entry.accountId) ?? 0n) + amount);
    }
  }
  return [...debited.entries()].map(([accountId, amount]) => ({
    accountId,
    amount: (-amount).toString(),
  }));
}

/**
 * Validates the basic structure returned by transaction inspection.
 *
 * @param inspected - Parsed transaction details
 * @returns Null when valid, otherwise invalid reason code
 */
function validateInspectedTransaction(inspected: unknown): string | null {
  if (!inspected || typeof inspected !== "object") {
    return "invalid_exact_hedera_payload_transaction_invalid_shape";
  }
  const candidate = inspected as Partial<InspectedHederaTransaction>;
  if (
    typeof candidate.transactionType !== "string" ||
    typeof candidate.transactionId !== "string" ||
    typeof candidate.transactionIdAccountId !== "string" ||
    typeof candidate.hasNonTransferOperations !== "boolean" ||
    !Array.isArray(candidate.hbarTransfers) ||
    !candidate.tokenTransfers ||
    typeof candidate.tokenTransfers !== "object"
  ) {
    return "invalid_exact_hedera_payload_transaction_invalid_shape";
  }
  if (candidate.transactionId.length === 0 || candidate.transactionIdAccountId.length === 0) {
    return "invalid_exact_hedera_payload_transaction_invalid_shape";
  }
  if (!isValidHederaEntityId(candidate.transactionIdAccountId)) {
    return "invalid_exact_hedera_payload_transaction_invalid_shape";
  }

  const allTransferLists = [
    candidate.hbarTransfers,
    ...Object.values(candidate.tokenTransfers as Record<string, HederaTransferEntry[]>),
  ];
  for (const transferList of allTransferLists) {
    if (!Array.isArray(transferList)) {
      return "invalid_exact_hedera_payload_transaction_invalid_shape";
    }
    for (const transfer of transferList) {
      if (
        !transfer ||
        typeof transfer.accountId !== "string" ||
        typeof transfer.amount !== "string" ||
        transfer.accountId.trim().length === 0
      ) {
        return "invalid_exact_hedera_payload_transaction_invalid_shape";
      }
      try {
        BigInt(transfer.amount);
      } catch {
        return "invalid_exact_hedera_payload_transaction_invalid_shape";
      }
    }
  }

  return null;
}

/**
 * Validates request requirements and parity with payload.accepted.
 *
 * @param signer - Facilitator signer
 * @param payload - Payment payload
 * @param requirements - Matched requirements
 * @param aliasPolicy - Alias handling behavior for payTo checks
 * @returns Failed verify response or null
 */
function validateRequirements(
  signer: FacilitatorHederaSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  aliasPolicy: HederaAliasPolicy,
): VerifyResponse | null {
  const exactValidation = validateExactRequirements(payload, requirements, {
    aliasPolicy,
    checkFeePayerParity: true,
    codes: CRYPTO_TRANSFER_REQUIREMENT_CODES,
  });
  if (exactValidation !== null) {
    return exactValidation;
  }

  const feePayer = requirements.extra?.feePayer;
  if (typeof feePayer !== "string" || !isValidHederaEntityId(feePayer)) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hedera_payload_missing_fee_payer",
      payer: "",
    };
  }
  const managedSigners = signer.getAddresses();
  if (!managedSigners.includes(feePayer)) {
    return { isValid: false, invalidReason: "fee_payer_not_managed_by_facilitator", payer: "" };
  }

  return null;
}

/**
 * Validates transfer semantics from inspected transaction details.
 *
 * @param inspected - Parsed transaction details
 * @param requirements - Matched requirements
 * @param feePayer - Fee payer account id
 * @returns Failed verify response or null
 */
function validateTransferSemantics(
  inspected: InspectedHederaTransaction,
  requirements: PaymentRequirements,
  feePayer: string,
): VerifyResponse | null {
  if (inspected.transactionIdAccountId !== feePayer) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hedera_payload_fee_payer_mismatch",
      payer: "",
    };
  }
  if (inspected.hasNonTransferOperations) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hedera_payload_contains_non_transfer_ops",
      payer: "",
    };
  }
  if (sumTransfers(inspected.hbarTransfers) !== 0n) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hedera_payload_hbar_sum_non_zero",
      payer: "",
    };
  }
  if (hasNegativeTransfer(inspected.hbarTransfers, feePayer)) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hedera_payload_fee_payer_transferring_hbar",
      payer: "",
    };
  }
  if (!isHbarAsset(requirements.asset) && inspected.hbarTransfers.length > 0) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hedera_payload_unexpected_hbar_transfers",
      payer: "",
    };
  }

  const payerTransfers = getAssetTransfers(
    inspected.tokenTransfers,
    inspected.hbarTransfers,
    requirements,
  );
  if (payerTransfers === null) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hedera_payload_asset_mismatch",
      payer: "",
    };
  }

  if (sumTransfers(payerTransfers) !== 0n) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hedera_payload_asset_sum_non_zero",
      payer: "",
    };
  }
  if (hasNegativeTransfer(payerTransfers, feePayer)) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hedera_payload_fee_payer_transferring_funds",
      payer: "",
    };
  }

  const requiredAmount = BigInt(requirements.amount);
  const netToPayTo = payerTransfers
    .filter(entry => hederaAccountIdsEqual(entry.accountId, requirements.payTo))
    .reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
  if (netToPayTo !== requiredAmount) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hedera_payload_amount_mismatch",
      payer: "",
    };
  }

  const positiveReceivers = getPositiveReceivers(payerTransfers);
  if (positiveReceivers.some(accountId => !hederaAccountIdsEqual(accountId, requirements.payTo))) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hedera_payload_extra_positive_transfers",
      payer: "",
    };
  }

  return null;
}

/**
 * Validates payTo destination based on alias policy and optional resolver.
 *
 * @param signer - Facilitator signer
 * @param requirements - Matched requirements
 * @param aliasPolicy - Alias handling behavior for payTo checks
 * @returns Failed verify response or null
 */
async function validatePayToPolicy(
  signer: FacilitatorHederaSigner,
  requirements: PaymentRequirements,
  aliasPolicy: HederaAliasPolicy,
): Promise<VerifyResponse | null> {
  if (aliasPolicy === "allow") {
    return null;
  }
  if (!isValidHederaEntityId(requirements.payTo)) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hedera_payload_pay_to_alias_not_allowed",
      payer: "",
    };
  }
  if (typeof signer.resolveAccount !== "function") {
    return null;
  }
  const resolved = await signer.resolveAccount(requirements.payTo, requirements.network);
  if (!resolved.exists || resolved.isAlias) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hedera_payload_pay_to_alias_not_allowed",
      payer: "",
    };
  }
  return null;
}
