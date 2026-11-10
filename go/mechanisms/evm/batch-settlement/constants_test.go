package batchsettlement

import (
	"strings"
	"testing"
)

func TestContractAddresses(t *testing.T) {
	if !strings.HasPrefix(BatchSettlementAddress, "0x") || len(BatchSettlementAddress) != 42 {
		t.Fatalf("BatchSettlementAddress malformed: %q", BatchSettlementAddress)
	}
	if !strings.HasPrefix(ERC3009DepositCollectorAddress, "0x") || len(ERC3009DepositCollectorAddress) != 42 {
		t.Fatalf("ERC3009DepositCollectorAddress malformed: %q", ERC3009DepositCollectorAddress)
	}
}

func TestWithdrawDelayBounds(t *testing.T) {
	if MinWithdrawDelay >= MaxWithdrawDelay {
		t.Fatal("min must be less than max")
	}
}

// TestErrorCodes pins the canonical wire prefix `invalid_batch_settlement_evm_`
// for every error reason exported from this package. Both facilitator-mirrored
// constants and resource-server abort reasons share the same envelope —
// renaming or dropping the prefix here breaks cdp-facilitator's substring
// classifier and the `x402VerifyInvalidReason` / `x402SettleErrorReason`
// CDP Accounts API enums.
func TestErrorCodes(t *testing.T) {
	const wirePrefix = "invalid_batch_settlement_evm_"
	for _, code := range []string{
		ErrCumulativeBelowClaimed,
		ErrCumulativeAmountMismatch,
		ErrChannelBusy,
		ErrMissingChannel,
		ErrChargeExceedsSignedCumulative,
		ErrRefundNoBalance,
		ErrRefundAmountInvalid,
		ErrRefundAmountExceedsBalance,
		ErrDepositBelowMinDeposit,
		ErrRefundAuthorizerMismatch,
		ErrRefundAuthorizerSignature,
		ErrVoucherStoreUnavailable,
		ErrVoucherStoreModeMismatch,
		ErrUnexpectedPendingId,
		ErrUnexpectedCancel,
		ErrPendingIdMismatch,
		ErrReceiverMismatch,
		ErrReceiverAuthorizerMismatch,
		ErrTokenMismatch,
		ErrWithdrawDelayMismatch,
		ErrWithdrawDelayOutOfRange,
		ErrCumulativeExceedsBalance,
	} {
		if !strings.HasPrefix(code, wirePrefix) {
			t.Fatalf("error reason must start with %q, got %q", wirePrefix, code)
		}
	}
}
