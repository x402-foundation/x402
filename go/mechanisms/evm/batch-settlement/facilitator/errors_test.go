package facilitator

import (
	"strings"
	"testing"
)

// TestExportedErrorReasonsAreStable pins the wire format and naming
// invariants for the exported error-reason constants in errors.go.
//
// These tokens are consumed by downstream classifiers (notably
// cdp-facilitator) that map facilitator output 1:1 into the
// `x402VerifyInvalidReason` / `x402SettleErrorReason` CDP Accounts API enums
// (`invalid_batch_settlement_evm_*`). Renaming or silently dropping any
// token breaks the mapping at the wire level, so this test asserts:
//
//  1. every constant is non-empty
//  2. every constant carries the canonical `invalid_batch_settlement_evm_`
//     prefix — mirroring the `invalid_exact_evm_*` discipline already in
//     `go/mechanisms/evm/exact/facilitator/errors.go`
//  3. no two constants share the same string value (uniqueness, since the
//     downstream classifier's identity passthrough would otherwise silently
//     collapse two distinct failure causes into one CDP enum)
//
// Add new constants to `errors.go` and also append them here so future
// renames trip this test instead of leaking through to wire consumers.
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
			t.Errorf("duplicate value %q shared by %v — downstream classifiers (cdp-facilitator) match by string contains and would silently collapse these", value, names)
		}
	}
}

// TestRequiredCdpFacilitatorContract pins the exact wire values the CDP
// Accounts API enums (`x402VerifyInvalidReason` / `x402SettleErrorReason`)
// expect for the Permit2 / EIP-2612 / ERC-20 approval families. cdp-facilitator
// after this revision does identity passthrough on these tokens, so any drift
// here surfaces as an undefined-enum error at the API boundary.
//
// `_invalid_*` suffixes are preserved verbatim (the leading `invalid_` envelope
// replaces the old `batch_settlement_evm_*` prefix and does NOT swallow inner
// `_invalid_*` segments). Earlier revisions collapsed these and produced
// abbreviated wire strings (e.g. `...permit2_spender`) that CDP had to
// denormalize, so we restored the full
// form here so the SDK can identity-map onto CDP's OpenAPI enum names.
func TestRequiredCdpFacilitatorContract(t *testing.T) {
	required := map[string]string{
		// Permit2
		"ErrPermit2AuthorizationRequired": "invalid_batch_settlement_evm_permit2_authorization_required",
		"ErrPermit2InvalidSpender":        "invalid_batch_settlement_evm_permit2_invalid_spender",
		"ErrPermit2AmountMismatch":        "invalid_batch_settlement_evm_permit2_amount_mismatch",
		"ErrPermit2DeadlineExpired":       "invalid_batch_settlement_evm_permit2_deadline_expired",
		"ErrPermit2InvalidSignature":      "invalid_batch_settlement_evm_permit2_invalid_signature",
		"ErrPermit2AllowanceRequired":     "invalid_batch_settlement_evm_permit2_allowance_required",
		// EIP-2612
		"ErrEip2612AmountMismatch":   "invalid_batch_settlement_evm_eip2612_amount_mismatch",
		"ErrEip2612OwnerMismatch":    "invalid_batch_settlement_evm_eip2612_owner_mismatch",
		"ErrEip2612AssetMismatch":    "invalid_batch_settlement_evm_eip2612_asset_mismatch",
		"ErrEip2612SpenderMismatch":  "invalid_batch_settlement_evm_eip2612_spender_mismatch",
		"ErrEip2612DeadlineExpired":  "invalid_batch_settlement_evm_eip2612_deadline_expired",
		"ErrEip2612InvalidFormat":    "invalid_batch_settlement_evm_eip2612_invalid_format",
		"ErrEip2612InvalidSignature": "invalid_batch_settlement_evm_eip2612_invalid_signature",
		// ERC-20 approval (gas-sponsored)
		"ErrErc20ApprovalUnavailable":     "invalid_batch_settlement_evm_erc20_approval_unavailable",
		"ErrErc20ApprovalInvalidFormat":   "invalid_batch_settlement_evm_erc20_approval_invalid_format",
		"ErrErc20ApprovalFromMismatch":    "invalid_batch_settlement_evm_erc20_approval_from_mismatch",
		"ErrErc20ApprovalAssetMismatch":   "invalid_batch_settlement_evm_erc20_approval_asset_mismatch",
		"ErrErc20ApprovalWrongSpender":    "invalid_batch_settlement_evm_erc20_approval_wrong_spender",
		"ErrErc20ApprovalBroadcastFailed": "invalid_batch_settlement_evm_erc20_approval_broadcast_failed",
	}

	// Map each symbol to its actual current value via a sibling table so the
	// test fails compilation if a constant is ever deleted.
	actual := map[string]string{
		"ErrPermit2AuthorizationRequired": ErrPermit2AuthorizationRequired,
		"ErrPermit2InvalidSpender":        ErrPermit2InvalidSpender,
		"ErrPermit2AmountMismatch":        ErrPermit2AmountMismatch,
		"ErrPermit2DeadlineExpired":       ErrPermit2DeadlineExpired,
		"ErrPermit2InvalidSignature":      ErrPermit2InvalidSignature,
		"ErrPermit2AllowanceRequired":     ErrPermit2AllowanceRequired,
		"ErrEip2612AmountMismatch":        ErrEip2612AmountMismatch,
		"ErrEip2612OwnerMismatch":         ErrEip2612OwnerMismatch,
		"ErrEip2612AssetMismatch":         ErrEip2612AssetMismatch,
		"ErrEip2612SpenderMismatch":       ErrEip2612SpenderMismatch,
		"ErrEip2612DeadlineExpired":       ErrEip2612DeadlineExpired,
		"ErrEip2612InvalidFormat":         ErrEip2612InvalidFormat,
		"ErrEip2612InvalidSignature":      ErrEip2612InvalidSignature,
		"ErrErc20ApprovalUnavailable":     ErrErc20ApprovalUnavailable,
		"ErrErc20ApprovalInvalidFormat":   ErrErc20ApprovalInvalidFormat,
		"ErrErc20ApprovalFromMismatch":    ErrErc20ApprovalFromMismatch,
		"ErrErc20ApprovalAssetMismatch":   ErrErc20ApprovalAssetMismatch,
		"ErrErc20ApprovalWrongSpender":    ErrErc20ApprovalWrongSpender,
		"ErrErc20ApprovalBroadcastFailed": ErrErc20ApprovalBroadcastFailed,
	}

	for name, want := range required {
		got, ok := actual[name]
		if !ok {
			t.Errorf("%s: missing from inventory", name)
			continue
		}
		if got != want {
			t.Errorf("%s = %q, want %q (cdp-facilitator wire contract)", name, got, want)
		}
	}
}

// TestNoLegacyBatchSettlementEvmPrefix guards against accidental reintroduction
// of the legacy `batch_settlement_evm_*` prefix on any facilitator constant.
// The new canonical form is `invalid_batch_settlement_evm_*`; legacy values
// would be silently translated by cdp-facilitator's deprecation shim during
// the migration window, masking real wire breaks. After the shim is removed
// from cdp-facilitator, any leak would surface as a 500 there.
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
		ErrAuthorizerAddressMismatch, ErrUnknownSettleAction,
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
