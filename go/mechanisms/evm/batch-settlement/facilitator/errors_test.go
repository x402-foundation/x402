package facilitator

import (
	"strings"
	"testing"
)

// TestExportedErrorReasonsAreStable pins the wire format of the exported
// error-reason constants in errors.go:
//
//  1. every constant is non-empty
//  2. every constant carries the canonical `invalid_batch_settlement_evm_`
//     prefix, the same discipline as `invalid_exact_evm_*` in
//     `go/mechanisms/evm/exact/facilitator/errors.go`
//  3. no two constants share the same string value, so two failure causes
//     cannot collapse into one wire token
//
// Add new constants to `errors.go` and append them here.
func TestExportedErrorReasonsAreStable(t *testing.T) {
	const wirePrefix = "invalid_batch_settlement_evm_"

	// Inventory of every exported error-reason constant in this package.
	// Keep alphabetical-ish order grouped by section to ease review.
	cases := map[string]string{
		// Payload parsing errors
		"ErrInvalidPayload":        ErrInvalidPayload,
		"ErrInvalidDepositPayload": ErrInvalidDepositPayload,
		"ErrInvalidVoucherPayload": ErrInvalidVoucherPayload,
		"ErrInvalidClaimPayload":   ErrInvalidClaimPayload,
		"ErrInvalidSettlePayload":  ErrInvalidSettlePayload,
		"ErrInvalidRefundPayload":  ErrInvalidRefundPayload,
		"ErrInvalidScheme":         ErrInvalidScheme,
		"ErrNetworkMismatch":       ErrNetworkMismatch,

		// Channel config validation errors
		"ErrReceiverMismatch":           ErrReceiverMismatch,
		"ErrReceiverAuthorizerMismatch": ErrReceiverAuthorizerMismatch,
		"ErrTokenMismatch":              ErrTokenMismatch,
		"ErrWithdrawDelayOutOfRange":    ErrWithdrawDelayOutOfRange,
		"ErrWithdrawDelayMismatch":      ErrWithdrawDelayMismatch,
		"ErrChannelIdMismatch":          ErrChannelIdMismatch,

		// ERC-3009 authorization errors
		"ErrValidBeforeExpired":           ErrValidBeforeExpired,
		"ErrValidAfterInFuture":           ErrValidAfterInFuture,
		"ErrErc3009SignatureInvalid":      ErrErc3009SignatureInvalid,
		"ErrErc3009AuthorizationRequired": ErrErc3009AuthorizationRequired,
		"ErrMissingEip712Domain":          ErrMissingEip712Domain,

		// Voucher errors
		"ErrVoucherSignatureInvalid": ErrVoucherSignatureInvalid,
		"ErrMaxClaimableTooLow":      ErrMaxClaimableTooLow,
		"ErrMaxClaimableExceedsBal":  ErrMaxClaimableExceedsBal,
		"ErrInsufficientBalance":     ErrInsufficientBalance,

		// Channel state errors
		"ErrChannelStateReadFailed": ErrChannelStateReadFailed,
		"ErrChannelNotFound":        ErrChannelNotFound,
		"ErrRpcReadFailed":          ErrRpcReadFailed,

		// Transaction errors
		"ErrDepositTransactionFailed": ErrDepositTransactionFailed,
		"ErrClaimTransactionFailed":   ErrClaimTransactionFailed,
		"ErrSettleTransactionFailed":  ErrSettleTransactionFailed,
		"ErrRefundTransactionFailed":  ErrRefundTransactionFailed,
		"ErrTransactionReverted":      ErrTransactionReverted,
		"ErrWaitForReceipt":           ErrWaitForReceipt,

		// Simulation errors
		"ErrDepositSimulationFailed": ErrDepositSimulationFailed,
		"ErrClaimSimulationFailed":   ErrClaimSimulationFailed,
		"ErrSettleSimulationFailed":  ErrSettleSimulationFailed,
		"ErrRefundSimulationFailed":  ErrRefundSimulationFailed,

		// Authorizer / settle-action errors
		"ErrAuthorizerAddressMismatch": ErrAuthorizerAddressMismatch,
		"ErrUnknownSettleAction":       ErrUnknownSettleAction,
		"ErrNothingToSettle":           ErrNothingToSettle,
		"ErrRefundedEventMismatch":     ErrRefundedEventMismatch,
		"ErrRefundNoBalance":           ErrRefundNoBalance,

		// Permit2 deposit authorization errors
		"ErrPermit2AuthorizationRequired": ErrPermit2AuthorizationRequired,
		"ErrPermit2InvalidSpender":        ErrPermit2InvalidSpender,
		"ErrPermit2AmountMismatch":        ErrPermit2AmountMismatch,
		"ErrPermit2DeadlineExpired":       ErrPermit2DeadlineExpired,
		"ErrPermit2InvalidSignature":      ErrPermit2InvalidSignature,
		"ErrPermit2AllowanceRequired":     ErrPermit2AllowanceRequired,

		// EIP-2612 permit segment errors
		"ErrEip2612AmountMismatch":   ErrEip2612AmountMismatch,
		"ErrEip2612OwnerMismatch":    ErrEip2612OwnerMismatch,
		"ErrEip2612AssetMismatch":    ErrEip2612AssetMismatch,
		"ErrEip2612SpenderMismatch":  ErrEip2612SpenderMismatch,
		"ErrEip2612DeadlineExpired":  ErrEip2612DeadlineExpired,
		"ErrEip2612InvalidFormat":    ErrEip2612InvalidFormat,
		"ErrEip2612InvalidSignature": ErrEip2612InvalidSignature,

		// ERC-20 approval gas-sponsoring errors
		"ErrErc20ApprovalUnavailable":     ErrErc20ApprovalUnavailable,
		"ErrErc20ApprovalInvalidFormat":   ErrErc20ApprovalInvalidFormat,
		"ErrErc20ApprovalFromMismatch":    ErrErc20ApprovalFromMismatch,
		"ErrErc20ApprovalAssetMismatch":   ErrErc20ApprovalAssetMismatch,
		"ErrErc20ApprovalWrongSpender":    ErrErc20ApprovalWrongSpender,
		"ErrErc20ApprovalBroadcastFailed": ErrErc20ApprovalBroadcastFailed,
	}

	// 1. Non-empty + 2. Prefix
	for name, value := range cases {
		if value == "" {
			t.Errorf("%s is empty", name)
			continue
		}
		if !strings.HasPrefix(value, wirePrefix) {
			t.Errorf("%s = %q does not start with wire prefix %q", name, value, wirePrefix)
		}
	}

	// 3. Uniqueness — surface the duplicate names so the failure points at
	// the rename / typo, not just "two constants collided".
	bySymbol := make(map[string][]string, len(cases))
	for name, value := range cases {
		bySymbol[value] = append(bySymbol[value], name)
	}
	for value, names := range bySymbol {
		if len(names) > 1 {
			t.Errorf("duplicate value %q shared by %v", value, names)
		}
	}
}

// TestNoLegacyBatchSettlementEvmPrefix guards against accidental reintroduction
// of the legacy `batch_settlement_evm_*` prefix on any facilitator constant.
// The canonical form is `invalid_batch_settlement_evm_*`.
func TestNoLegacyBatchSettlementEvmPrefix(t *testing.T) {
	all := []string{
		ErrInvalidPayload, ErrInvalidDepositPayload, ErrInvalidVoucherPayload,
		ErrInvalidClaimPayload, ErrInvalidSettlePayload, ErrInvalidRefundPayload,
		ErrInvalidScheme, ErrNetworkMismatch,
		ErrReceiverMismatch, ErrReceiverAuthorizerMismatch, ErrTokenMismatch,
		ErrWithdrawDelayOutOfRange, ErrWithdrawDelayMismatch, ErrChannelIdMismatch,
		ErrValidBeforeExpired, ErrValidAfterInFuture, ErrErc3009SignatureInvalid,
		ErrErc3009AuthorizationRequired, ErrMissingEip712Domain,
		ErrVoucherSignatureInvalid, ErrMaxClaimableTooLow, ErrMaxClaimableExceedsBal,
		ErrInsufficientBalance,
		ErrChannelStateReadFailed, ErrChannelNotFound, ErrRpcReadFailed,
		ErrDepositTransactionFailed, ErrClaimTransactionFailed,
		ErrSettleTransactionFailed, ErrRefundTransactionFailed,
		ErrTransactionReverted, ErrWaitForReceipt,
		ErrDepositSimulationFailed, ErrClaimSimulationFailed,
		ErrSettleSimulationFailed, ErrRefundSimulationFailed,
		ErrAuthorizerAddressMismatch, ErrUnknownSettleAction, ErrNothingToSettle,
		ErrRefundedEventMismatch, ErrRefundNoBalance,
		ErrPermit2AuthorizationRequired, ErrPermit2InvalidSpender,
		ErrPermit2AmountMismatch, ErrPermit2DeadlineExpired,
		ErrPermit2InvalidSignature, ErrPermit2AllowanceRequired,
		ErrEip2612AmountMismatch, ErrEip2612OwnerMismatch, ErrEip2612AssetMismatch,
		ErrEip2612SpenderMismatch, ErrEip2612DeadlineExpired,
		ErrEip2612InvalidFormat, ErrEip2612InvalidSignature,
		ErrErc20ApprovalUnavailable, ErrErc20ApprovalInvalidFormat,
		ErrErc20ApprovalFromMismatch, ErrErc20ApprovalAssetMismatch,
		ErrErc20ApprovalWrongSpender, ErrErc20ApprovalBroadcastFailed,
	}
	for _, v := range all {
		if strings.HasPrefix(v, "batch_settlement_evm_") {
			t.Errorf("legacy prefix detected: %q — must use `invalid_batch_settlement_evm_*`", v)
		}
	}
}
