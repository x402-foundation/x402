package batched

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
// for the single facilitator-mirroring constant exported from this package
// (`ErrCumulativeBelowClaimed` — see comment in errors.go), and the
// `batch_settlement_*` / `missing_*` sibling prefixes for the resource
// server's abort reasons. Renaming or dropping a prefix here breaks
// cdp-facilitator's substring classifier and the
// `x402VerifyInvalidReason` / `x402SettleErrorReason` CDP Accounts API
// enums (or their sibling group, when wired up).
func TestErrorCodes(t *testing.T) {
	const facilitatorPrefix = "invalid_batch_settlement_evm_"

	// Group 1: facilitator-mirroring constant (canonical CDP enum form).
	// Only one constant is shared with the facilitator package because
	// `client/scheme.go` needs to substring-match it during the corrective
	// 402 recovery handshake without importing facilitator.
	if !strings.HasPrefix(ErrCumulativeBelowClaimed, facilitatorPrefix) {
		t.Fatalf("ErrCumulativeBelowClaimed missing prefix %q: %q", facilitatorPrefix, ErrCumulativeBelowClaimed)
	}

	// Group 2: resource-server abort reasons. Two acceptable sibling
	// prefixes: `batch_settlement_*` (the family) and `missing_*` (one
	// special case for missing-channel that mirrors the TS resource server
	// byte-for-byte). None of these may carry the `invalid_` envelope —
	// that namespace is exclusively for facilitator output.
	for _, code := range []string{
		ErrCumulativeAmountMismatch,
		ErrChannelBusy,
		ErrChargeExceedsSignedCumulative,
		ErrRefundNoBalance,
		ErrRefundAmountInvalid,
		ErrRefundAmountExceedsBalance,
	} {
		if !strings.HasPrefix(code, "batch_settlement_") {
			t.Fatalf("server abort reason must start with `batch_settlement_`, got %q", code)
		}
		if strings.HasPrefix(code, "invalid_") {
			t.Fatalf("server abort reason must NOT carry `invalid_` envelope (reserved for facilitator output), got %q", code)
		}
	}

	// `missing_batch_settlement_channel` lives on its own envelope shape
	// for parity with TS; assert it explicitly so the inventory is complete.
	if !strings.HasPrefix(ErrMissingChannel, "missing_") {
		t.Fatalf("ErrMissingChannel expected `missing_*` envelope, got %q", ErrMissingChannel)
	}
	if strings.HasPrefix(ErrMissingChannel, "invalid_") {
		t.Fatalf("ErrMissingChannel must NOT carry `invalid_` envelope, got %q", ErrMissingChannel)
	}
}
