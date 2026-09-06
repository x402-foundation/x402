import {
  CANONICAL_SIGNING_PUB_KEY_PATTERN,
  DEFAULT_MAX_FEE_DROPS,
  SETTLEMENT_TTL_MS,
  TF_PARTIAL_PAYMENT,
  XRPL_CAIP_FAMILY,
} from "../../constants";
import {
  compareDecimalStrings,
  decodeSignedTransactionBlob,
  getCurrentLedgerIndex,
  getExactXrplPayload,
  getMaxLastLedgerSequence,
  getSignedTransactionHash,
  getXrplAccountAuthorization,
  getXrplAccountSequence,
  invoiceIdToInvoiceIdField,
  isIssuedCurrencyAmount,
  isRecord,
  isValidDestinationTag,
  isXrplNetwork,
  isXrplTicketAvailable,
  parseXrplNetworkId,
  requireClassicAddress,
  resolveAssetTransferMethod,
  simulateSignedTransaction,
  submitSignedTransaction,
} from "../../utils";
import { SettlementCache } from "../../settlement-cache";
import type { XrplAssetTransferMethod, XrplFacilitatorOptions } from "../../types";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { deriveAddress, verifySignature, type Payment, type Transaction } from "xrpl";

/**
 * XRPL facilitator implementation for the exact payment scheme.
 */
export class ExactXrplScheme implements SchemeNetworkFacilitator {
  readonly caipFamily = XRPL_CAIP_FAMILY;
  readonly scheme = "exact";
  private readonly options: XrplFacilitatorOptions;
  private readonly settlementCache: SettlementCache;

  /**
   * Creates a new XRPL exact facilitator scheme.
   *
   * @param options - Facilitator configuration
   * @param settlementCache - Optional shared settlement cache; a private one is created by default
   */
  constructor(options: XrplFacilitatorOptions = {}, settlementCache?: SettlementCache) {
    this.options = options;
    this.settlementCache = settlementCache ?? new SettlementCache();
  }

  /**
   * Gets XRPL mechanism-specific supported metadata.
   *
   * @param _network - Network identifier
   * @returns Extra metadata advertising that fees are never sponsored
   */
  getExtra(_network: Network): Record<string, unknown> | undefined {
    return { areFeesSponsored: false };
  }

  /**
   * Gets XRPL facilitator signer addresses.
   *
   * @param _network - Network identifier
   * @returns Empty signer list because payer signs and pays XRPL transaction fees
   */
  getSigners(_network: string): string[] {
    return [];
  }

  /**
   * Verifies an XRPL exact payment payload without submitting it.
   *
   * @param payload - x402 payment payload
   * @param requirements - Payment requirements
   * @returns Verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    let payer = "";
    try {
      const envelopeError = this.verifyEnvelope(payload, requirements);
      if (envelopeError) {
        return invalidVerify(envelopeError, payer);
      }

      const methodResolution = resolveAssetTransferMethod(payload, requirements);
      if ("error" in methodResolution) {
        return invalidVerify(methodResolution.error, payer);
      }

      const exactPayload = getExactXrplPayload(payload);
      const decoded = decodeSignedTransactionBlob(exactPayload.signedTxBlob);
      const signingPubKey = (decoded as { SigningPubKey?: unknown }).SigningPubKey;
      if (
        typeof signingPubKey !== "string" ||
        !CANONICAL_SIGNING_PUB_KEY_PATTERN.test(signingPubKey)
      ) {
        return invalidVerify("invalid_exact_xrpl_payload_signing_pub_key", payer);
      }
      if (!verifySignature(exactPayload.signedTxBlob)) {
        return invalidVerify("invalid_exact_xrpl_payload_signature", payer);
      }
      if (decoded.TransactionType !== "Payment") {
        return invalidVerify("invalid_exact_xrpl_payload_transaction_type", payer);
      }

      const transaction = decoded as Payment;
      payer = requireClassicAddress(transaction.Account, "Account");
      const structureError = this.verifyPaymentTransactionStructure(transaction, requirements);
      if (structureError) {
        return invalidVerify(structureError, payer);
      }

      const sequencingFieldsError = this.verifySequencingFields(
        transaction,
        methodResolution.method,
      );
      if (sequencingFieldsError) {
        return invalidVerify(sequencingFieldsError, payer);
      }

      const currentLedgerIndex = await getCurrentLedgerIndex(requirements.network, this.options);
      const expiryError = this.verifyLedgerExpiry(transaction, requirements, currentLedgerIndex);
      if (expiryError) {
        return invalidVerify(expiryError, payer);
      }

      const signerAuthorizationError = await this.verifySignerAuthorization(
        transaction,
        requirements.network,
      );
      if (signerAuthorizationError) {
        return invalidVerify(signerAuthorizationError, payer);
      }

      const sequencingStateError = await this.verifySequencingState(
        transaction,
        methodResolution.method,
        requirements.network,
      );
      if (sequencingStateError) {
        return invalidVerify(sequencingStateError, payer);
      }

      const simulationError = await this.verifySimulation(exactPayload.signedTxBlob, requirements);
      if (simulationError) {
        return invalidVerify(simulationError, payer);
      }

      return {
        isValid: true,
        payer,
      };
    } catch (error) {
      return invalidVerify(
        "invalid_exact_xrpl_facilitator_error",
        payer,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Settles an XRPL exact payment by submitting its signed transaction.
   *
   * @param payload - x402 payment payload
   * @param requirements - Payment requirements
   * @returns Settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const verification = await this.verify(payload, requirements);
    if (!verification.isValid) {
      return {
        success: false,
        transaction: "",
        network: payload.accepted.network,
        payer: verification.payer ?? "",
        errorReason: verification.invalidReason ?? "verification_failed",
        errorMessage: verification.invalidMessage,
      };
    }

    const exactPayload = getExactXrplPayload(payload);
    const transactionHash = getSignedTransactionHash(exactPayload.signedTxBlob);

    // XRPL submission is idempotent on the transaction hash: submitAndWait for
    // an already-submitted hash resolves tesSUCCESS again, so concurrent settle
    // calls carrying the same signed blob would each report success while only
    // one payment lands. The check + insert below is synchronous, so concurrent
    // calls that all passed verification are still serialized correctly. The
    // entry is retained for the transaction's landable window (its
    // LastLedgerSequence is derived from maxTimeoutSeconds) plus a margin, so it
    // cannot be evicted while a slow-to-validate duplicate could still pass
    // re-verification.
    const settlementTtlMs = requirements.maxTimeoutSeconds * 1000 + SETTLEMENT_TTL_MS;
    if (this.settlementCache.isDuplicate(transactionHash, settlementTtlMs)) {
      return {
        success: false,
        transaction: "",
        network: payload.accepted.network,
        payer: verification.payer ?? "",
        errorReason: "duplicate_settlement",
      };
    }

    try {
      const result = await submitSignedTransaction(
        exactPayload.signedTxBlob,
        requirements.network,
        this.options,
      );
      if (!result.validated || result.resultCode !== "tesSUCCESS") {
        return {
          success: false,
          transaction: result.hash || transactionHash,
          network: payload.accepted.network,
          payer: verification.payer ?? "",
          errorReason: `transaction_failed: ${result.resultCode}`,
        };
      }

      return {
        success: true,
        transaction: result.hash || transactionHash,
        network: payload.accepted.network,
        payer: verification.payer ?? "",
      };
    } catch (error) {
      return {
        success: false,
        transaction: transactionHash,
        network: payload.accepted.network,
        payer: verification.payer ?? "",
        errorReason: `transaction_failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Verifies the x402 envelope fields against the advertised requirements.
   *
   * @param payload - x402 payment payload
   * @param requirements - Payment requirements
   * @returns Invalid reason, if validation fails
   */
  private verifyEnvelope(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): string | undefined {
    if (payload.x402Version !== 2) {
      return "invalid_x402_version";
    }
    if (payload.accepted.scheme !== "exact" || requirements.scheme !== "exact") {
      return "unsupported_scheme";
    }
    if (!isXrplNetwork(requirements.network) || !isXrplNetwork(payload.accepted.network)) {
      return "invalid_network";
    }
    if (payload.accepted.network !== requirements.network) {
      return "invalid_exact_xrpl_network_mismatch";
    }
    if (payload.accepted.asset !== requirements.asset) {
      return "invalid_exact_xrpl_asset_mismatch";
    }
    if (payload.accepted.amount !== requirements.amount) {
      return "invalid_exact_xrpl_amount_mismatch";
    }
    if (payload.accepted.payTo !== requirements.payTo) {
      return "invalid_exact_xrpl_pay_to_mismatch";
    }
    if (payload.accepted.maxTimeoutSeconds !== requirements.maxTimeoutSeconds) {
      return "invalid_exact_xrpl_max_timeout_mismatch";
    }
    if (
      requirements.extra?.areFeesSponsored !== false ||
      payload.accepted.extra?.areFeesSponsored !== false
    ) {
      return "invalid_exact_xrpl_fees_sponsored_unsupported";
    }
    if (payload.accepted.extra?.invoiceId !== requirements.extra?.invoiceId) {
      return "invalid_exact_xrpl_invoice_mismatch";
    }
    if (payload.accepted.extra?.destinationTag !== requirements.extra?.destinationTag) {
      return "invalid_exact_xrpl_destination_tag_mismatch";
    }
    if (requirements.asset !== "XRP") {
      try {
        requireClassicAddress(requirements.extra?.issuer, "issuer");
        requireClassicAddress(payload.accepted.extra?.issuer, "issuer");
      } catch {
        return "invalid_exact_xrpl_iou_issuer_missing";
      }
      if (payload.accepted.extra?.issuer !== requirements.extra?.issuer) {
        return "invalid_exact_xrpl_iou_issuer_mismatch";
      }
    }
    return undefined;
  }

  /**
   * Verifies XRPL transaction fields that must match payment requirements.
   *
   * @param transaction - Decoded XRPL payment transaction
   * @param requirements - Payment requirements
   * @returns Invalid reason, if validation fails
   */
  private verifyPaymentTransactionStructure(
    transaction: Payment,
    requirements: PaymentRequirements,
  ): string | undefined {
    const expectedDestination = requireClassicAddress(requirements.payTo, "payTo");
    if (transaction.Destination !== expectedDestination) {
      return "invalid_exact_xrpl_payload_destination_mismatch";
    }
    const requiredDestinationTag = requirements.extra?.destinationTag;
    if (requiredDestinationTag !== undefined) {
      if (!isValidDestinationTag(requiredDestinationTag)) {
        return "invalid_exact_xrpl_destination_tag_malformed";
      }
      if (transaction.DestinationTag !== requiredDestinationTag) {
        return "invalid_exact_xrpl_payload_destination_tag_mismatch";
      }
    }
    if (hasDelegateField(transaction)) {
      return "invalid_exact_xrpl_payload_delegate_not_allowed";
    }
    if (transaction.Signers !== undefined) {
      return "invalid_exact_xrpl_payload_multisig_not_supported";
    }

    const networkError = this.verifyNetworkBinding(transaction, requirements.network);
    if (networkError) return networkError;

    const amountError =
      requirements.asset === "XRP"
        ? this.verifyXrpAmount(transaction, requirements)
        : this.verifyIouAmount(transaction, requirements);
    if (amountError) return amountError;

    const invoiceError = this.verifyInvoiceBinding(transaction, requirements);
    if (invoiceError) return invoiceError;

    const feeError = this.verifyFee(transaction);
    if (feeError) return feeError;

    return undefined;
  }

  /**
   * Verifies XRPL NetworkID replay protection.
   *
   * @param transaction - Decoded XRPL transaction
   * @param network - x402 XRPL network id
   * @returns Invalid reason, if validation fails
   */
  private verifyNetworkBinding(transaction: Transaction, network: Network): string | undefined {
    const networkId = parseXrplNetworkId(network);
    if (networkId <= 1024 && transaction.NetworkID !== undefined) {
      return "invalid_exact_xrpl_payload_network_id_for_standard_network";
    }
    if (networkId > 1024 && transaction.NetworkID !== networkId) {
      return "invalid_exact_xrpl_payload_network_id_mismatch";
    }
    return undefined;
  }

  /**
   * Verifies native XRP destination amount and disallowed path fields.
   *
   * @param transaction - Decoded XRPL payment transaction
   * @param requirements - Payment requirements
   * @returns Invalid reason, if validation fails
   */
  private verifyXrpAmount(
    transaction: Payment,
    requirements: PaymentRequirements,
  ): string | undefined {
    const destinationAmount = getDestinationAmount(transaction);
    if (typeof destinationAmount !== "string" || !/^\d+$/.test(destinationAmount)) {
      return "invalid_exact_xrpl_payload_amount_xrp";
    }
    if (BigInt(destinationAmount) !== BigInt(requirements.amount)) {
      return "invalid_exact_xrpl_payload_amount_mismatch";
    }
    if (transaction.SendMax !== undefined) {
      return "invalid_exact_xrpl_payload_sendmax_not_allowed";
    }
    if (transaction.Paths !== undefined) {
      return "invalid_exact_xrpl_payload_paths_not_allowed";
    }
    if (transaction.DeliverMin !== undefined) {
      return "invalid_exact_xrpl_payload_delivermin_not_allowed";
    }
    if (hasPartialPaymentFlag(transaction.Flags)) {
      return "invalid_exact_xrpl_payload_partial_payment_not_allowed";
    }
    return undefined;
  }

  /**
   * Verifies issued-currency amount, SendMax, and partial-payment controls.
   *
   * @param transaction - Decoded XRPL payment transaction
   * @param requirements - Payment requirements
   * @returns Invalid reason, if validation fails
   */
  private verifyIouAmount(
    transaction: Payment,
    requirements: PaymentRequirements,
  ): string | undefined {
    const destinationAmount = getDestinationAmount(transaction);
    if (!isIssuedCurrencyAmount(destinationAmount)) {
      return "invalid_exact_xrpl_payload_iou_amount";
    }
    if (destinationAmount.currency !== requirements.asset) {
      return "invalid_exact_xrpl_payload_iou_currency_mismatch";
    }
    if (destinationAmount.issuer !== requirements.extra?.issuer) {
      return "invalid_exact_xrpl_payload_iou_issuer_mismatch";
    }
    if (compareDecimalStrings(destinationAmount.value, requirements.amount) !== 0) {
      return "invalid_exact_xrpl_payload_iou_value_mismatch";
    }
    if (!isIssuedCurrencyAmount(transaction.SendMax)) {
      return "invalid_exact_xrpl_payload_sendmax_required";
    }
    if (
      transaction.SendMax.currency !== destinationAmount.currency ||
      transaction.SendMax.issuer !== destinationAmount.issuer
    ) {
      return "invalid_exact_xrpl_payload_sendmax_iou_mismatch";
    }
    if (compareDecimalStrings(transaction.SendMax.value, destinationAmount.value) < 0) {
      return "invalid_exact_xrpl_payload_sendmax_too_low";
    }
    if (transaction.Paths !== undefined) {
      return "invalid_exact_xrpl_payload_paths_not_allowed";
    }
    if (transaction.DeliverMin !== undefined) {
      return "invalid_exact_xrpl_payload_delivermin_not_allowed";
    }
    if (hasPartialPaymentFlag(transaction.Flags)) {
      return "invalid_exact_xrpl_payload_partial_payment_not_allowed";
    }
    return undefined;
  }

  /**
   * Verifies that the transaction is bound to the invoice id.
   *
   * @param transaction - Decoded XRPL payment transaction
   * @param requirements - Payment requirements
   * @returns Invalid reason, if validation fails
   */
  private verifyInvoiceBinding(
    transaction: Payment,
    requirements: PaymentRequirements,
  ): string | undefined {
    if (transaction.Memos !== undefined) {
      return "invalid_exact_xrpl_payload_memos_not_allowed";
    }

    const invoiceId = requirements.extra?.invoiceId;
    if (invoiceId === undefined) {
      return undefined;
    }
    if (typeof invoiceId !== "string" || invoiceId === "") {
      return "invalid_exact_xrpl_payload_invoice_missing";
    }
    const expectedInvoiceId = invoiceIdToInvoiceIdField(invoiceId);
    if (transaction.InvoiceID === undefined) {
      return "invalid_exact_xrpl_payload_invoice_missing";
    }
    if (transaction.InvoiceID.toUpperCase() !== expectedInvoiceId) {
      return "invalid_exact_xrpl_payload_invoice_id_mismatch";
    }
    return undefined;
  }

  /**
   * Verifies the payer-controlled XRPL fee against facilitator policy.
   *
   * @param transaction - Decoded XRPL transaction
   * @returns Invalid reason, if validation fails
   */
  private verifyFee(transaction: Transaction): string | undefined {
    if (typeof transaction.Fee !== "string" || !/^\d+$/.test(transaction.Fee)) {
      return "invalid_exact_xrpl_payload_fee_missing";
    }
    if (BigInt(transaction.Fee) > BigInt(this.options.maxFeeDrops ?? DEFAULT_MAX_FEE_DROPS)) {
      return "invalid_exact_xrpl_payload_fee_too_high";
    }
    return undefined;
  }

  /**
   * Verifies LastLedgerSequence against current ledger and timeout policy.
   *
   * @param transaction - Decoded XRPL transaction
   * @param requirements - Payment requirements
   * @param currentLedgerIndex - Current validated ledger index
   * @returns Invalid reason, if validation fails
   */
  private verifyLedgerExpiry(
    transaction: Transaction,
    requirements: PaymentRequirements,
    currentLedgerIndex: number,
  ): string | undefined {
    if (typeof transaction.LastLedgerSequence !== "number") {
      return "invalid_exact_xrpl_payload_lastledgersequence_missing";
    }
    if (transaction.LastLedgerSequence <= currentLedgerIndex) {
      return "invalid_exact_xrpl_payload_expired";
    }
    if (
      transaction.LastLedgerSequence > getMaxLastLedgerSequence(currentLedgerIndex, requirements)
    ) {
      return "invalid_exact_xrpl_payload_lastledgersequence_too_large";
    }
    return undefined;
  }

  /**
   * Verifies sequencing fields decodable without ledger access.
   *
   * @param transaction - Decoded XRPL payment transaction
   * @param method - Selected asset transfer method
   * @returns Invalid reason, if validation fails
   */
  private verifySequencingFields(
    transaction: Payment,
    method: XrplAssetTransferMethod,
  ): string | undefined {
    if (method === "sequence") {
      if (transaction.TicketSequence !== undefined) {
        return "invalid_exact_xrpl_payload_ticket_sequence_not_allowed";
      }
      if (typeof transaction.Sequence !== "number" || transaction.Sequence === 0) {
        return "invalid_exact_xrpl_payload_sequence_missing";
      }
      return undefined;
    }

    if (transaction.Sequence !== 0) {
      return "invalid_exact_xrpl_payload_sequence_must_be_zero";
    }
    if (typeof transaction.TicketSequence !== "number") {
      return "invalid_exact_xrpl_payload_ticket_sequence_missing";
    }
    return undefined;
  }

  /**
   * Verifies that the embedded signing key is authorized for the payer account.
   *
   * `verifySignature` only proves the blob was signed by its embedded
   * `SigningPubKey`; this check binds that key to `Account` (master key pair,
   * unless disabled, or the configured regular key) so payments that would
   * deterministically fail authorization at settlement (`tefBAD_AUTH`,
   * `tefMASTER_DISABLED`) are rejected during verification. Simulation cannot
   * catch these because signature fields are stripped before `simulate`.
   *
   * @param transaction - Decoded XRPL payment transaction
   * @param network - XRPL network id
   * @returns Invalid reason, if validation fails
   */
  private async verifySignerAuthorization(
    transaction: Payment,
    network: Network,
  ): Promise<string | undefined> {
    const signingPubKey = transaction.SigningPubKey;
    if (typeof signingPubKey !== "string" || signingPubKey === "") {
      return "invalid_exact_xrpl_payload_signature";
    }
    const signerAddress = deriveAddress(signingPubKey);
    const authorization = await getXrplAccountAuthorization(
      transaction.Account,
      network,
      this.options,
    );
    // rippled (fixMasterKeyAsRegularKey) authorizes the configured regular key
    // first, then the master key pair unless it is disabled.
    if (authorization.regularKey === signerAddress) {
      return undefined;
    }
    if (signerAddress === transaction.Account && !authorization.isMasterKeyDisabled) {
      return undefined;
    }
    return "invalid_exact_xrpl_payload_signer_not_authorized";
  }

  /**
   * Verifies account sequencing state on the target network.
   *
   * @param transaction - Decoded XRPL payment transaction
   * @param method - Selected asset transfer method
   * @param network - XRPL network id
   * @returns Invalid reason, if validation fails
   */
  private async verifySequencingState(
    transaction: Payment,
    method: XrplAssetTransferMethod,
    network: Network,
  ): Promise<string | undefined> {
    if (method === "sequence") {
      const accountSequence = await getXrplAccountSequence(
        transaction.Account,
        network,
        this.options,
      );
      if (transaction.Sequence !== accountSequence) {
        return "invalid_exact_xrpl_payload_sequence_not_current";
      }
      return undefined;
    }

    const ticketSequence = transaction.TicketSequence;
    if (typeof ticketSequence !== "number") {
      return "invalid_exact_xrpl_payload_ticket_sequence_missing";
    }
    const ticketAvailable = await isXrplTicketAvailable(
      transaction.Account,
      ticketSequence,
      network,
      this.options,
    );
    if (!ticketAvailable) {
      return "invalid_exact_xrpl_payload_ticket_not_available";
    }
    return undefined;
  }

  /**
   * Simulates the signed transaction against XRPL before verification succeeds.
   *
   * @param signedTxBlob - Hex-encoded signed transaction blob
   * @param requirements - Payment requirements
   * @returns Invalid reason, if simulation fails
   */
  private async verifySimulation(
    signedTxBlob: string,
    requirements: PaymentRequirements,
  ): Promise<string | undefined> {
    const result = await simulateSignedTransaction(
      signedTxBlob,
      requirements.network,
      this.options,
    );
    if (result.engineResult !== "tesSUCCESS") {
      return `invalid_exact_xrpl_payload_simulation_failed: ${result.engineResult}`;
    }
    return undefined;
  }
}

/**
 * Creates an invalid verification response.
 *
 * @param reason - Invalid reason
 * @param payer - Payer address, if known
 * @param message - Human-readable invalidation detail, if available
 * @returns Invalid verify response
 */
function invalidVerify(reason: string, payer: string, message?: string): VerifyResponse {
  return {
    isValid: false,
    invalidReason: reason,
    invalidMessage: message,
    payer,
  };
}

/**
 * Extracts the destination amount while rejecting ambiguous v1/v2 amount fields.
 *
 * @param transaction - Decoded XRPL payment transaction
 * @returns Destination amount
 */
function getDestinationAmount(transaction: Payment): unknown {
  if (transaction.Amount !== undefined && transaction.DeliverMax !== undefined) {
    throw new Error("ambiguous_amount_fields");
  }
  return transaction.DeliverMax ?? transaction.Amount;
}

/**
 * Checks whether XRPL Payment flags include tfPartialPayment.
 *
 * @param flags - XRPL payment flags
 * @returns Whether partial payment is enabled
 */
function hasPartialPaymentFlag(flags: Payment["Flags"]): boolean {
  if (typeof flags === "number") {
    return (flags & TF_PARTIAL_PAYMENT) !== 0;
  }
  return isRecord(flags) && flags.tfPartialPayment === true;
}

/**
 * Checks whether a decoded transaction carries a Delegate field.
 *
 * @param transaction - Decoded XRPL transaction
 * @returns Whether Delegate is present
 */
function hasDelegateField(transaction: Transaction): boolean {
  return (transaction as Transaction & { Delegate?: string }).Delegate !== undefined;
}
