/**
 * Named error reason constants for the exact Hedera facilitator.
 *
 * The values match the error table in specs/schemes/exact/scheme_exact_hedera.md
 * ("Error codes" under `transferExecutor`). They are returned as `invalidReason`
 * from verify and `errorReason` from settle.
 */

// Method selection

/** `extra.assetTransferMethod` is not a value this mechanism defines. */
export const ErrInvalidAssetTransferMethod = "invalid_exact_hedera_asset_transfer_method";
/** The method is defined but this facilitator does not implement it on `network`. */
export const ErrUnsupportedAssetTransferMethod =
  "invalid_exact_hedera_unsupported_asset_transfer_method";

// transferExecutor verification

/** `payload.executor` is not an executor this facilitator admits on `network`. */
export const ErrExecutorNotAdmitted = "invalid_exact_hedera_executor_not_admitted";
/** `payload` is absent or not an object. */
export const ErrInvalidTransferExecutorPayload = "invalid_exact_hedera_payload_transfer_executor";
/** `payload.payer` is missing or not a Hedera account id. */
export const ErrInvalidPayloadPayer = "invalid_exact_hedera_payload_payer";
/** `payload.executor` is missing or not a Hedera contract id. */
export const ErrInvalidPayloadExecutor = "invalid_exact_hedera_payload_executor";
/** `payload.authorization` is not `0x`-prefixed hex. */
export const ErrInvalidPayloadAuthorization = "invalid_exact_hedera_payload_authorization";
/** `asset` has a custom fee schedule, so `exact` cannot hold. */
export const ErrCustomFeeAsset = "invalid_exact_hedera_custom_fee_asset";
/** `payer` or `payTo` could not be resolved to an EVM address. */
export const ErrAddressResolutionFailed = "address_resolution_failed";
/** `executeTransfer` reverted in simulation. */
export const ErrSimulationReverted = "simulation_reverted";
/** Simulated gas is above the facilitator's configured ceiling. */
export const ErrSimulationGasExceeded = "simulation_gas_exceeded";

// transferExecutor settlement

/** The record's status is not `SUCCESS`. */
export const ErrSettlementStatusNotSuccess = "settlement_status_not_success";
/** The record shows a net credit to `payTo` that is not `amount`. */
export const ErrSettlementPayeeCreditMismatch = "settlement_payee_credit_mismatch";
/** The payer's net debit is not the expected figure. */
export const ErrSettlementPayerDebitMismatch = "settlement_payer_debit_mismatch";
/** The fee payer's net debit is not the transaction fee. */
export const ErrSettlementFeePayerDebitMismatch = "settlement_fee_payer_debit_mismatch";
/** An account other than `payer` and the fee payer lost funds. */
export const ErrSettlementUnexpectedDebit = "settlement_unexpected_debit";
/** The record carries a movement the payment does not account for. */
export const ErrSettlementUnexpectedTransfer = "settlement_unexpected_transfer";
/** The settlement checks failed for a reason with no more specific code. */
export const ErrSettlementCheckFailed = "settlement_check_failed";

// Standard x402 v2 codes emitted by transferExecutor

/** The payload is malformed, differs from the requirements it accepted, or is already in flight. */
export const ErrInvalidPayload = "invalid_payload";
/** The requirements' `asset`, `payTo` or `amount` is malformed. */
export const ErrInvalidPaymentRequirements = "invalid_payment_requirements";
/** The network is not supported, or `accepted` names another one. */
export const ErrInvalidNetwork = "invalid_network";
/** The scheme is not `exact`. */
export const ErrInvalidScheme = "invalid_scheme";
/** Verification failed on an infrastructure error not attributable to the payer. */
export const ErrUnexpectedVerifyError = "unexpected_verify_error";
/** Settlement failed on an infrastructure error not attributable to the payer. */
export const ErrUnexpectedSettleError = "unexpected_settle_error";
/** The transaction was submitted but its outcome is not yet known. */
export const ErrSettlementPending = "settlement_pending";
