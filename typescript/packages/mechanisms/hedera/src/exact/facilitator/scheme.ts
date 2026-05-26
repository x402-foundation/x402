import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
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
  assertSupportedHederaNetwork,
  extractTransactionFromPayload,
  getPositiveReceivers,
  hederaAccountIdsEqual,
  inspectHederaTransaction,
  isHbarAsset,
  isValidHederaAsset,
  isValidHederaEntityId,
  sumTransfers,
} from "../../utils";

/**
 * Alias handling behavior for payTo checks.
 */
export type HederaAliasPolicy = "reject" | "allow";

/**
 * Facilitator options for exact Hedera verification.
 */
export type HederaFacilitatorConfig = {
  aliasPolicy?: HederaAliasPolicy;
};

/**
 * Hedera facilitator implementation for the Exact payment scheme.
 */
export class ExactHederaScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "hedera:*";
  private readonly aliasPolicy: HederaAliasPolicy;

  /**
   * Creates a new facilitator scheme.
   *
   * @param signer - Facilitator signer implementation
   * @param config - Optional behavior config
   */
  constructor(
    private readonly signer: FacilitatorHederaSigner,
    config: HederaFacilitatorConfig = {},
  ) {
    this.aliasPolicy = config.aliasPolicy ?? "reject";
  }

  /**
   * Returns mechanism-specific `extra` data.
   *
   * @param _ - Network identifier
   * @returns Extra object with feePayer
   */
  getExtra(_: string): Record<string, unknown> | undefined {
    const addresses = this.signer.getAddresses();
    if (addresses.length === 0) {
      return undefined;
    }
    const randomIndex = Math.floor(Math.random() * addresses.length);
    return { feePayer: addresses[randomIndex] };
  }

  /**
   * Returns managed signer addresses for this facilitator.
   *
   * @param _ - Network identifier
   * @returns Signer account ids
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Verify an exact Hedera payload.
   *
   * @param payload - Payment payload
   * @param requirements - Matched payment requirements
   * @returns Verification result
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    // Phase 1: requirements and accepted parity checks
    const requirementsValidation = this.validateRequirements(payload, requirements);
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
    const inspectedValidation = this.validateInspectedTransaction(inspected);
    if (inspectedValidation !== null) {
      return { isValid: false, invalidReason: inspectedValidation, payer: "" };
    }

    // Phase 3: structural and transfer checks
    const transferValidation = this.validateTransferSemantics(inspected, requirements, feePayer);
    if (transferValidation !== null) {
      return transferValidation;
    }
    const payerTransfers = this.getAssetTransfers(
      inspected.tokenTransfers,
      inspected.hbarTransfers,
      requirements,
    ) as HederaTransferEntry[];
    const payer = this.inferPayer(payerTransfers);

    // Phase 4: alias policy check
    const payToValidation = await this.validatePayToPolicy(requirements);
    if (payToValidation !== null) {
      return payToValidation;
    }

    // Phase 5: optional onchain preflight (balance + token association).
    // Spec §6 — advisory, never throws out of verify.
    // Precondition: Phase 3 transfer-semantics guarantees `payer` is non-empty
    // (the payload must contain at least one debited account for `asset`).
    if (typeof this.signer.preflightTransfer === "function") {
      let preflight: { ok: boolean; reason?: string; message?: string };
      try {
        preflight = await this.signer.preflightTransfer({
          payer,
          payTo: requirements.payTo,
          asset: requirements.asset,
          amount: requirements.amount,
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
   * @param payload - Payment payload
   * @param requirements - Matched requirements
   * @returns Settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const valid = await this.verify(payload, requirements);
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
      const settled = await this.signer.signAndSubmitTransaction(
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
  private getAssetTransfers(
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
  private hasNegativeTransfer(transfers: HederaTransferEntry[], accountId: string): boolean {
    return transfers.some(
      entry => hederaAccountIdsEqual(entry.accountId, accountId) && BigInt(entry.amount) < 0n,
    );
  }

  /**
   * Best-effort payer inference from debited transfer entries.
   *
   * @param transfers - Asset transfers
   * @returns Payer account id
   */
  private inferPayer(transfers: HederaTransferEntry[]): string {
    return transfers.find(entry => BigInt(entry.amount) < 0n)?.accountId ?? "";
  }

  /**
   * Validates the basic structure returned by transaction inspection.
   *
   * @param inspected - Parsed transaction details
   * @returns Null when valid, otherwise invalid reason code
   */
  private validateInspectedTransaction(inspected: unknown): string | null {
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
   * @param payload - Payment payload
   * @param requirements - Matched requirements
   * @returns Failed verify response or null
   */
  private validateRequirements(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): VerifyResponse | null {
    if (payload.accepted.scheme !== "exact" || requirements.scheme !== "exact") {
      return { isValid: false, invalidReason: "unsupported_scheme", payer: "" };
    }
    if (payload.accepted.network !== requirements.network) {
      return { isValid: false, invalidReason: "network_mismatch", payer: "" };
    }
    if (
      payload.accepted.asset !== requirements.asset ||
      payload.accepted.amount !== requirements.amount ||
      payload.accepted.payTo !== requirements.payTo ||
      payload.accepted.maxTimeoutSeconds !== requirements.maxTimeoutSeconds ||
      payload.accepted.extra?.feePayer !== requirements.extra?.feePayer
    ) {
      return { isValid: false, invalidReason: "accepted_payment_requirements_mismatch", payer: "" };
    }

    try {
      assertSupportedHederaNetwork(requirements.network);
    } catch {
      return { isValid: false, invalidReason: "network_mismatch", payer: "" };
    }
    if (!isValidHederaAsset(requirements.asset)) {
      return { isValid: false, invalidReason: "invalid_asset", payer: "" };
    }
    if (!this.isValidPayToFormatForPolicy(requirements.payTo)) {
      return { isValid: false, invalidReason: "invalid_exact_hedera_payload_pay_to", payer: "" };
    }
    if (!/^\d+$/.test(requirements.amount)) {
      return { isValid: false, invalidReason: "invalid_amount", payer: "" };
    }

    const feePayer = requirements.extra?.feePayer;
    if (typeof feePayer !== "string" || !isValidHederaEntityId(feePayer)) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_hedera_payload_missing_fee_payer",
        payer: "",
      };
    }
    const managedSigners = this.signer.getAddresses();
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
  private validateTransferSemantics(
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
    if (this.hasNegativeTransfer(inspected.hbarTransfers, feePayer)) {
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

    const payerTransfers = this.getAssetTransfers(
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
    if (this.hasNegativeTransfer(payerTransfers, feePayer)) {
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
    if (
      positiveReceivers.some(accountId => !hederaAccountIdsEqual(accountId, requirements.payTo))
    ) {
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
   * @param requirements - Matched requirements
   * @returns Failed verify response or null
   */
  private async validatePayToPolicy(
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse | null> {
    if (this.aliasPolicy === "allow") {
      return null;
    }
    if (!isValidHederaEntityId(requirements.payTo)) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_hedera_payload_pay_to_alias_not_allowed",
        payer: "",
      };
    }
    if (typeof this.signer.resolveAccount !== "function") {
      return null;
    }
    const resolved = await this.signer.resolveAccount(requirements.payTo, requirements.network);
    if (!resolved.exists || resolved.isAlias) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_hedera_payload_pay_to_alias_not_allowed",
        payer: "",
      };
    }
    return null;
  }

  /**
   * Validates payTo format based on alias policy.
   *
   * @param payTo - Destination account/alias value
   * @returns True when payTo has acceptable format
   */
  private isValidPayToFormatForPolicy(payTo: string): boolean {
    if (typeof payTo !== "string" || payTo.trim().length === 0) {
      return false;
    }
    if (this.aliasPolicy === "allow") {
      return true;
    }
    return isValidHederaEntityId(payTo);
  }
}
