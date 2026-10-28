import { describe, expect, it } from "vitest";
import * as facilitator from "../../src/exact/facilitator";

describe("exact Hedera facilitator error codes", () => {
  it("match the method-specific literals in the scheme spec error table", () => {
    expect({
      ErrInvalidAssetTransferMethod: facilitator.ErrInvalidAssetTransferMethod,
      ErrUnsupportedAssetTransferMethod: facilitator.ErrUnsupportedAssetTransferMethod,
      ErrExecutorNotAdmitted: facilitator.ErrExecutorNotAdmitted,
      ErrInvalidTransferExecutorPayload: facilitator.ErrInvalidTransferExecutorPayload,
      ErrInvalidPayloadPayer: facilitator.ErrInvalidPayloadPayer,
      ErrInvalidPayloadExecutor: facilitator.ErrInvalidPayloadExecutor,
      ErrInvalidPayloadAuthorization: facilitator.ErrInvalidPayloadAuthorization,
      ErrCustomFeeAsset: facilitator.ErrCustomFeeAsset,
      ErrAddressResolutionFailed: facilitator.ErrAddressResolutionFailed,
      ErrSimulationReverted: facilitator.ErrSimulationReverted,
      ErrSimulationGasExceeded: facilitator.ErrSimulationGasExceeded,
      ErrSettlementStatusNotSuccess: facilitator.ErrSettlementStatusNotSuccess,
      ErrSettlementPayeeCreditMismatch: facilitator.ErrSettlementPayeeCreditMismatch,
      ErrSettlementPayerDebitMismatch: facilitator.ErrSettlementPayerDebitMismatch,
      ErrSettlementFeePayerDebitMismatch: facilitator.ErrSettlementFeePayerDebitMismatch,
      ErrSettlementUnexpectedDebit: facilitator.ErrSettlementUnexpectedDebit,
      ErrSettlementUnexpectedTransfer: facilitator.ErrSettlementUnexpectedTransfer,
      ErrSettlementCheckFailed: facilitator.ErrSettlementCheckFailed,
    }).toEqual({
      ErrInvalidAssetTransferMethod: "invalid_exact_hedera_asset_transfer_method",
      ErrUnsupportedAssetTransferMethod: "invalid_exact_hedera_unsupported_asset_transfer_method",
      ErrExecutorNotAdmitted: "invalid_exact_hedera_executor_not_admitted",
      ErrInvalidTransferExecutorPayload: "invalid_exact_hedera_payload_transfer_executor",
      ErrInvalidPayloadPayer: "invalid_exact_hedera_payload_payer",
      ErrInvalidPayloadExecutor: "invalid_exact_hedera_payload_executor",
      ErrInvalidPayloadAuthorization: "invalid_exact_hedera_payload_authorization",
      ErrCustomFeeAsset: "invalid_exact_hedera_custom_fee_asset",
      ErrAddressResolutionFailed: "address_resolution_failed",
      ErrSimulationReverted: "simulation_reverted",
      ErrSimulationGasExceeded: "simulation_gas_exceeded",
      ErrSettlementStatusNotSuccess: "settlement_status_not_success",
      ErrSettlementPayeeCreditMismatch: "settlement_payee_credit_mismatch",
      ErrSettlementPayerDebitMismatch: "settlement_payer_debit_mismatch",
      ErrSettlementFeePayerDebitMismatch: "settlement_fee_payer_debit_mismatch",
      ErrSettlementUnexpectedDebit: "settlement_unexpected_debit",
      ErrSettlementUnexpectedTransfer: "settlement_unexpected_transfer",
      ErrSettlementCheckFailed: "settlement_check_failed",
    });
  });

  it("match the standard x402 v2 literals", () => {
    expect({
      ErrInvalidPayload: facilitator.ErrInvalidPayload,
      ErrInvalidPaymentRequirements: facilitator.ErrInvalidPaymentRequirements,
      ErrInvalidNetwork: facilitator.ErrInvalidNetwork,
      ErrInvalidScheme: facilitator.ErrInvalidScheme,
      ErrUnexpectedVerifyError: facilitator.ErrUnexpectedVerifyError,
      ErrUnexpectedSettleError: facilitator.ErrUnexpectedSettleError,
      ErrSettlementPending: facilitator.ErrSettlementPending,
    }).toEqual({
      ErrInvalidPayload: "invalid_payload",
      ErrInvalidPaymentRequirements: "invalid_payment_requirements",
      ErrInvalidNetwork: "invalid_network",
      ErrInvalidScheme: "invalid_scheme",
      ErrUnexpectedVerifyError: "unexpected_verify_error",
      ErrUnexpectedSettleError: "unexpected_settle_error",
      ErrSettlementPending: "settlement_pending",
    });
  });
});
