package batchsettlement

import (
	"strings"
	"testing"
)

func TestSchemeIdentifier(t *testing.T) {
	if SchemeBatched != "batch-settlement" {
		t.Fatalf("SchemeBatched = %q", SchemeBatched)
	}
}

func TestContractAddresses(t *testing.T) {
	if !strings.HasPrefix(BatchSettlementAddress, "0x") || len(BatchSettlementAddress) != 42 {
		t.Fatalf("BatchSettlementAddress malformed: %q", BatchSettlementAddress)
	}
	if !strings.HasPrefix(ERC3009DepositCollectorAddress, "0x") || len(ERC3009DepositCollectorAddress) != 42 {
		t.Fatalf("ERC3009DepositCollectorAddress malformed: %q", ERC3009DepositCollectorAddress)
	}
}

func TestWithdrawDelayBounds(t *testing.T) {
	if MinWithdrawDelay != 900 {
		t.Fatalf("MinWithdrawDelay = %d", MinWithdrawDelay)
	}
	if MaxWithdrawDelay != 2_592_000 {
		t.Fatalf("MaxWithdrawDelay = %d", MaxWithdrawDelay)
	}
	if MinWithdrawDelay >= MaxWithdrawDelay {
		t.Fatal("min must be less than max")
	}
}

func TestBatchSettlementDomain(t *testing.T) {
	if BatchSettlementDomain.Name != "x402 Batch Settlement" {
		t.Fatalf("Name = %q", BatchSettlementDomain.Name)
	}
	if BatchSettlementDomain.Version != "1" {
		t.Fatalf("Version = %q", BatchSettlementDomain.Version)
	}
}

func TestVoucherTypes(t *testing.T) {
	v, ok := VoucherTypes["Voucher"]
	if !ok || len(v) != 2 {
		t.Fatalf("VoucherTypes shape = %+v", v)
	}
	if v[0].Name != "channelId" || v[0].Type != "bytes32" {
		t.Fatalf("Voucher[0] = %+v", v[0])
	}
	if v[1].Name != "maxClaimableAmount" || v[1].Type != "uint128" {
		t.Fatalf("Voucher[1] = %+v", v[1])
	}
}

func TestRefundTypes(t *testing.T) {
	r, ok := RefundTypes["Refund"]
	if !ok || len(r) != 3 {
		t.Fatalf("RefundTypes shape = %+v", r)
	}
}

func TestClaimBatchTypes(t *testing.T) {
	cb, ok := ClaimBatchTypes["ClaimBatch"]
	if !ok || len(cb) != 1 {
		t.Fatalf("ClaimBatchTypes shape = %+v", cb)
	}
	if cb[0].Type != "ClaimEntry[]" {
		t.Fatalf("ClaimBatch[0].Type = %q", cb[0].Type)
	}
	ce, ok := ClaimBatchTypes["ClaimEntry"]
	if !ok || len(ce) != 3 {
		t.Fatalf("ClaimEntry shape = %+v", ce)
	}
}

func TestReceiveAuthorizationTypes(t *testing.T) {
	r, ok := ReceiveAuthorizationTypes["ReceiveWithAuthorization"]
	if !ok || len(r) != 6 {
		t.Fatalf("ReceiveWithAuthorization shape = %+v", r)
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
	} {
		if !strings.HasPrefix(code, wirePrefix) {
			t.Fatalf("error reason must start with %q, got %q", wirePrefix, code)
		}
	}
}
