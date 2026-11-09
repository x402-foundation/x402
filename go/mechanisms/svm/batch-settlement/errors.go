package batchsettlement

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

const errorPrefix = "invalid_batch_settlement_svm_"

// Machine-readable batch-settlement failure reasons.
const (
	ErrPayloadType                = errorPrefix + "payload_type"
	ErrPaymentFlow                = errorPrefix + "payment_flow"
	ErrTokenProgram               = errorPrefix + "token_program"
	ErrVoucherSignature           = errorPrefix + "voucher_signature"
	ErrChannelIDMismatch          = errorPrefix + "channel_id_mismatch"
	ErrFeePayerMismatch           = errorPrefix + "fee_payer_mismatch"
	ErrReceiverAuthorizerMismatch = errorPrefix + "receiver_authorizer_mismatch"
	ErrReceiverBindingUnavailable = errorPrefix + "receiver_binding_unavailable"
	ErrDelegatedUnauthenticated   = errorPrefix + "delegated_unauthenticated"
	ErrCloseAuthorization         = errorPrefix + "close_authorization"
	ErrCloseAmountUnsupported     = errorPrefix + "close_amount_unsupported"
	ErrCloseState                 = errorPrefix + "close_state"
	ErrChannelClosing             = errorPrefix + "channel_closing"
	ErrWithdrawDelayMismatch      = errorPrefix + "withdraw_delay_mismatch"
	ErrWithdrawDelayOutOfRange    = errorPrefix + "withdraw_delay_out_of_range"
	ErrCumulativeAmountMismatch   = errorPrefix + "cumulative_amount_mismatch"
	ErrCumulativeExceedsDeposit   = errorPrefix + "cumulative_exceeds_deposit"
	ErrVoucherExpiry              = errorPrefix + "voucher_expiry"
	ErrSetupTransaction           = errorPrefix + "setup_transaction"
	ErrSettlementSimulation       = errorPrefix + "settlement_simulation"
	ErrDepositBelowMinDeposit     = errorPrefix + "deposit_below_min_deposit"
	ErrChannelState               = errorPrefix + "channel_state"
	ErrRefundTransaction          = errorPrefix + "refund_transaction"
	ErrPayoutAttributionAmbiguous = errorPrefix + "payout_attribution_ambiguous"
	ErrOperationCeilingChanged    = errorPrefix + "operation_ceiling_changed"
)

// ErrorReasons is every batch-settlement machine reason, in declaration order.
func ErrorReasons() []string {
	return []string{
		ErrPayloadType,
		ErrPaymentFlow,
		ErrTokenProgram,
		ErrVoucherSignature,
		ErrChannelIDMismatch,
		ErrFeePayerMismatch,
		ErrReceiverAuthorizerMismatch,
		ErrReceiverBindingUnavailable,
		ErrDelegatedUnauthenticated,
		ErrCloseAuthorization,
		ErrCloseAmountUnsupported,
		ErrCloseState,
		ErrChannelClosing,
		ErrWithdrawDelayMismatch,
		ErrWithdrawDelayOutOfRange,
		ErrCumulativeAmountMismatch,
		ErrCumulativeExceedsDeposit,
		ErrVoucherExpiry,
		ErrSetupTransaction,
		ErrSettlementSimulation,
		ErrDepositBelowMinDeposit,
		ErrChannelState,
		ErrRefundTransaction,
		ErrPayoutAttributionAmbiguous,
		ErrOperationCeilingChanged,
	}
}

var gracePeriodPattern = regexp.MustCompile(`gracePeriod \d+ != expected withdrawDelay`)

// SetupTransactionError gives a failed open or top_up verification its spec
// code (spec 7): the binding Memo naming another receiver authorizer is
// receiver_authorizer_mismatch, a grace period other than extra.withdrawDelay
// is withdraw_delay_mismatch, an unaccepted message version keeps
// unsupported_transaction_version, and every other sponsor safety check
// (layout, signers, budget, size) is setup_transaction.
func SetupTransactionError(err error) error {
	message := err.Error()
	if strings.HasPrefix(message, svm.ErrUnsupportedTransactionVersion) {
		return err
	}
	reason := ErrSetupTransaction
	switch {
	case strings.Contains(message, "names another receiver authorizer"):
		reason = ErrReceiverAuthorizerMismatch
	case gracePeriodPattern.MatchString(message):
		reason = ErrWithdrawDelayMismatch
	}
	return fmt.Errorf("%s: %w", reason, err)
}
