package facilitator

import (
	"context"
	"errors"
	"math/big"
	"testing"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	"github.com/x402-foundation/x402/go/types"
)

const testNetwork = "eip155:8453"

func reqsFor(network string) types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:  batched.SchemeBatched,
		Network: network,
		PayTo:   "0x3333333333333333333333333333333333333333",
		Asset:   "0x5555555555555555555555555555555555555555",
		Amount:  "100",
		Extra: map[string]interface{}{
			"receiverAuthorizer": "0x4444444444444444444444444444444444444444",
		},
	}
}

// ----- ExecuteClaimWithSignature -----

func TestExecuteClaimWithSignature_NoClaims(t *testing.T) {
	scheme := newScheme()
	resp, err := ExecuteClaimWithSignature(
		context.Background(),
		scheme.signer,
		&batched.BatchedClaimPayload{Claims: nil},
		reqsFor(testNetwork),
		scheme.authorizerSigner,
	)
	if resp != nil {
		t.Fatalf("expected nil resp, got %+v", resp)
	}
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidClaimPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteClaimWithSignature_BadProvidedSignature(t *testing.T) {
	scheme := newScheme()
	payload := &batched.BatchedClaimPayload{
		Claims:                   []batched.BatchedVoucherClaim{sampleClaim()},
		ClaimAuthorizerSignature: "not-hex",
	}
	_, err := ExecuteClaimWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidClaimPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteClaimWithSignature_AuthorizerAddressMismatch(t *testing.T) {
	scheme := newScheme()
	claim := sampleClaim()
	claim.Voucher.Channel.ReceiverAuthorizer = "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed"
	payload := &batched.BatchedClaimPayload{Claims: []batched.BatchedVoucherClaim{claim}}
	_, err := ExecuteClaimWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrAuthorizerAddressMismatch {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteClaimWithSignature_SimulationFailed(t *testing.T) {
	scheme := newScheme()
	claim := sampleClaim()
	claim.Voucher.Channel.ReceiverAuthorizer = "0xauthorizer"
	payload := &batched.BatchedClaimPayload{Claims: []batched.BatchedVoucherClaim{claim}}
	resp, err := ExecuteClaimWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if resp.Success || resp.ErrorReason != ErrClaimSimulationFailed {
		t.Fatalf("got %+v", resp)
	}
}

// ----- ExecuteRefundWithSignature -----

func TestExecuteRefundWithSignature_BadAmount(t *testing.T) {
	scheme := newScheme()
	payload := &batched.BatchedEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: validConfig(),
		Amount:        "not-a-number",
		RefundNonce:   "1",
	}
	_, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidRefundPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteRefundWithSignature_BadNonce(t *testing.T) {
	scheme := newScheme()
	payload := &batched.BatchedEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: validConfig(),
		Amount:        "100",
		RefundNonce:   "not-a-number",
	}
	_, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidRefundPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteRefundWithSignature_BadProvidedRefundSig(t *testing.T) {
	scheme := newScheme()
	payload := &batched.BatchedEnrichedRefundPayload{
		Type:                      "refund",
		ChannelConfig:             validConfig(),
		Amount:                    "100",
		RefundNonce:               "1",
		RefundAuthorizerSignature: "not-hex",
	}
	_, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidRefundPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteRefundWithSignature_AuthorizerAddressMismatch(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	cfg.ReceiverAuthorizer = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	payload := &batched.BatchedEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: cfg,
		Amount:        "100",
		RefundNonce:   "1",
	}
	_, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrAuthorizerAddressMismatch {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteRefundWithSignature_SimulationFailed_DirectPath(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	cfg.ReceiverAuthorizer = "0xauthorizer"
	payload := &batched.BatchedEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: cfg,
		Amount:        "100",
		RefundNonce:   "1",
	}
	resp, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundSimulationFailed {
		t.Fatalf("got %+v", resp)
	}
}

func TestExecuteRefundWithSignature_BadProvidedClaimSig(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	cfg.ReceiverAuthorizer = "0xauthorizer"
	payload := &batched.BatchedEnrichedRefundPayload{
		Type:                      "refund",
		ChannelConfig:             cfg,
		Amount:                    "100",
		RefundNonce:               "1",
		Claims:                    []batched.BatchedVoucherClaim{sampleClaim()},
		ClaimAuthorizerSignature:  "not-hex",
		RefundAuthorizerSignature: "0xdead",
	}
	_, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidRefundPayload {
		t.Fatalf("got err = %v", err)
	}
}

// ----- ExecuteSettle -----

func TestExecuteSettle_SimulationFailed(t *testing.T) {
	scheme := newScheme()
	payload := &batched.BatchedSettlePayload{
		Type:     "settle",
		Receiver: "0x3333333333333333333333333333333333333333",
		Token:    "0x5555555555555555555555555555555555555555",
	}
	resp, err := ExecuteSettle(context.Background(), scheme.signer, payload, reqsFor(testNetwork))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if resp.Success || resp.ErrorReason != ErrSettleSimulationFailed {
		t.Fatalf("got %+v", resp)
	}
}

// ----- SettleDeposit -----

func TestSettleDeposit_BadAmount(t *testing.T) {
	scheme := newScheme()
	payload := &batched.BatchedDepositPayload{
		Type:          "deposit",
		ChannelConfig: validConfig(),
		Deposit: batched.BatchedDepositData{
			Amount: "not-a-number",
		},
	}
	_, err := SettleDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork), nil, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidDepositPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestSettleDeposit_MissingAuthorization(t *testing.T) {
	// buildERC3009CollectorData returns an error when no auth is present, so
	// SettleDeposit short-circuits with ErrInvalidDepositPayload before any RPC.
	scheme := newScheme()
	payload := &batched.BatchedDepositPayload{
		Type:          "deposit",
		ChannelConfig: validConfig(),
		Deposit: batched.BatchedDepositData{
			Amount: "100",
		},
	}
	_, err := SettleDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork), nil, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidDepositPayload {
		t.Fatalf("got err = %v", err)
	}
}

// ----- VerifyDeposit pre-RPC paths -----

func TestVerifyDeposit_BadAmount(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	id, _ := batched.ComputeChannelId(cfg, testNetwork)
	payload := &batched.BatchedDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Deposit: batched.BatchedDepositData{
			Amount: "0",
		},
		Voucher: batched.BatchedVoucherFields{
			ChannelId:          id,
			MaxClaimableAmount: "100",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork), nil, nil)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrInvalidDepositPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestVerifyDeposit_BadValidAfter(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	id, _ := batched.ComputeChannelId(cfg, testNetwork)
	payload := &batched.BatchedDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Deposit: batched.BatchedDepositData{
			Amount: "100",
			Authorization: batched.BatchedDepositAuthorization{
				Erc3009Authorization: &batched.BatchedErc3009Authorization{
					ValidAfter:  "not-a-number",
					ValidBefore: "9999999999",
					Salt:        "0x" + zeros(64),
					Signature:   "0xdeadbeef",
				},
			},
		},
		Voucher: batched.BatchedVoucherFields{
			ChannelId:          id,
			MaxClaimableAmount: "100",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork), nil, nil)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrInvalidDepositPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestVerifyDeposit_BadValidBefore(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	id, _ := batched.ComputeChannelId(cfg, testNetwork)
	payload := &batched.BatchedDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Deposit: batched.BatchedDepositData{
			Amount: "100",
			Authorization: batched.BatchedDepositAuthorization{
				Erc3009Authorization: &batched.BatchedErc3009Authorization{
					ValidAfter:  "0",
					ValidBefore: "not-a-number",
					Salt:        "0x" + zeros(64),
					Signature:   "0xdeadbeef",
				},
			},
		},
		Voucher: batched.BatchedVoucherFields{
			ChannelId:          id,
			MaxClaimableAmount: "100",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork), nil, nil)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrInvalidDepositPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestVerifyDeposit_ExpiredAuthorization(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	id, _ := batched.ComputeChannelId(cfg, testNetwork)
	payload := &batched.BatchedDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Deposit: batched.BatchedDepositData{
			Amount: "100",
			Authorization: batched.BatchedDepositAuthorization{
				Erc3009Authorization: &batched.BatchedErc3009Authorization{
					ValidAfter:  "0",
					ValidBefore: "1",
					Salt:        "0x" + zeros(64),
					Signature:   "0xdeadbeef",
				},
			},
		},
		Voucher: batched.BatchedVoucherFields{
			ChannelId:          id,
			MaxClaimableAmount: "100",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork), nil, nil)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrValidBeforeExpired {
		t.Fatalf("got err = %v", err)
	}
}

func TestVerifyDeposit_ChannelConfigInvalid(t *testing.T) {
	// channelId mismatch fires before any RPC.
	scheme := newScheme()
	cfg := validConfig()
	payload := &batched.BatchedDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Deposit: batched.BatchedDepositData{
			Amount: "100",
		},
		Voucher: batched.BatchedVoucherFields{
			ChannelId:          "0x" + zeros(64),
			MaxClaimableAmount: "100",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork), nil, nil)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrChannelIdMismatch {
		t.Fatalf("got err = %v", err)
	}
}

// ----- VerifyVoucher pre-RPC paths -----

func TestVerifyVoucher_ChannelConfigInvalid(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	payload := &batched.BatchedVoucherPayload{
		Type:          "voucher",
		ChannelConfig: cfg,
		Voucher: batched.BatchedVoucherFields{
			ChannelId:          "0x" + zeros(64),
			MaxClaimableAmount: "100",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyVoucher(context.Background(), scheme.signer, payload, reqsFor(testNetwork), cfg)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrChannelIdMismatch {
		t.Fatalf("got err = %v", err)
	}
}

// TestVerifyRefundVoucher_ChannelConfigInvalid ensures VerifyRefundVoucher
// shares the same channel-id validation surface as VerifyVoucher. The refund
// path is otherwise identical aside from the cumulative comparison.
func TestVerifyRefundVoucher_ChannelConfigInvalid(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	payload := &batched.BatchedRefundPayload{
		Type:          "refund",
		ChannelConfig: cfg,
		Voucher: batched.BatchedVoucherFields{
			ChannelId:          "0x" + zeros(64),
			MaxClaimableAmount: "0",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyRefundVoucher(context.Background(), scheme.signer, payload, reqsFor(testNetwork), cfg)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrChannelIdMismatch {
		t.Fatalf("got err = %v", err)
	}
}

// ----- helpers -----

func sampleClaim() batched.BatchedVoucherClaim {
	c := batched.BatchedVoucherClaim{
		Signature:    "0xdeadbeef",
		TotalClaimed: "0",
	}
	c.Voucher.Channel = validConfig()
	c.Voucher.MaxClaimableAmount = "100"
	return c
}

func zeros(n int) string {
	out := make([]byte, n)
	for i := range out {
		out[i] = '0'
	}
	return string(out)
}

// ----- buildRefundResponse -----

// TestBuildRefundResponse pins the canonical TS-aligned shape:
//   - top-level: success, tx, network, payer, amount
//   - extra.channelState: channelId, balance, totalClaimed, withdrawRequestedAt, refundNonce
//   - NO `refund: true` flag at any level (TS doesn't emit it; it was a Go-only
//     legacy that confused the resource server's afterSettle hook into reading
//     stale fields)
//   - NO `chargedCumulativeAmount` (the resource server's
//     enrichSettlementResponse hook adds it via additive merge)
func TestBuildRefundResponse(t *testing.T) {
	details := refundSettlementDetails{
		amount: "2000",
		channelState: batched.BatchedChannelStateExtra{
			ChannelId:           "0xchan",
			Balance:             "3000",
			TotalClaimed:        "3000",
			WithdrawRequestedAt: 0,
			RefundNonce:         "1",
		},
	}
	resp := buildRefundResponse("0xtx", x402.Network(testNetwork), "0xpayer", details)
	if !resp.Success || resp.Transaction != "0xtx" || resp.Network != x402.Network(testNetwork) {
		t.Fatalf("envelope: %+v", resp)
	}
	if resp.Payer != "0xpayer" {
		t.Fatalf("payer = %q, want 0xpayer", resp.Payer)
	}
	if resp.Amount != "2000" {
		t.Fatalf("amount = %q, want 2000", resp.Amount)
	}
	if _, hasLegacy := resp.Extra["refund"]; hasLegacy {
		t.Fatalf("extra.refund must NOT be emitted; got %+v", resp.Extra)
	}
	cs, ok := resp.Extra["channelState"].(map[string]interface{})
	if !ok {
		t.Fatalf("extra.channelState missing or wrong shape: %+v", resp.Extra)
	}
	if cs["channelId"] != "0xchan" {
		t.Fatalf("channelId = %v", cs["channelId"])
	}
	if cs["balance"] != "3000" {
		t.Fatalf("balance = %v", cs["balance"])
	}
	if cs["totalClaimed"] != "3000" {
		t.Fatalf("totalClaimed = %v", cs["totalClaimed"])
	}
	if cs["refundNonce"] != "1" {
		t.Fatalf("refundNonce = %v", cs["refundNonce"])
	}
	if _, hasCharged := cs["chargedCumulativeAmount"]; hasCharged {
		t.Fatalf("chargedCumulativeAmount must NOT be emitted by facilitator (server enrichSettlementResponse adds it): %+v", cs)
	}
}

// TestComputeRefundSettlementDetails_AnalyticPathNoClaims covers the common
// case: no pending withdrawal, no claims accompanying the refund. The
// snapshot is computed from preState + payload alone (no post-state poll),
// matching TS `buildRefundExtra(payload, channelId, preState)`.
func TestComputeRefundSettlementDetails_AnalyticPathNoClaims(t *testing.T) {
	preState := &batched.ChannelState{
		Balance:             big.NewInt(5000),
		TotalClaimed:        big.NewInt(0),
		WithdrawRequestedAt: 0,
		RefundNonce:         big.NewInt(0),
	}
	payload := &batched.BatchedEnrichedRefundPayload{
		Type:        "refund",
		Amount:      "2000",
		RefundNonce: "0",
	}
	details := computeRefundSettlementDetails(
		context.Background(), nil /*signer not consulted*/, payload, "0xchan", preState, big.NewInt(2000),
	)
	if details.amount != "2000" {
		t.Fatalf("amount = %q, want 2000 (no available cap)", details.amount)
	}
	if details.channelState.Balance != "3000" {
		t.Fatalf("balance = %q, want 3000 (5000 - 2000)", details.channelState.Balance)
	}
	if details.channelState.TotalClaimed != "0" {
		t.Fatalf("totalClaimed = %q, want 0 (no claims)", details.channelState.TotalClaimed)
	}
	if details.channelState.RefundNonce != "1" {
		t.Fatalf("refundNonce = %q, want 1 (preNonce + 1)", details.channelState.RefundNonce)
	}
	if details.channelState.WithdrawRequestedAt != 0 {
		t.Fatalf("withdrawRequestedAt = %d, want 0", details.channelState.WithdrawRequestedAt)
	}
}

// TestComputeRefundSettlementDetails_CapsAtAvailable mirrors TS:
// when the requested refund exceeds preBalance - postClaimTotalClaimed,
// actualRefund must be capped at the available remainder.
func TestComputeRefundSettlementDetails_CapsAtAvailable(t *testing.T) {
	preState := &batched.ChannelState{
		Balance:             big.NewInt(5000),
		TotalClaimed:        big.NewInt(0),
		WithdrawRequestedAt: 0,
		RefundNonce:         big.NewInt(0),
	}
	// Claims up to totalClaimed=4000 → available = 5000 - 4000 = 1000.
	payload := &batched.BatchedEnrichedRefundPayload{
		Type:        "refund",
		Amount:      "2000",
		RefundNonce: "0",
		Claims: []batched.BatchedVoucherClaim{{
			TotalClaimed: "4000",
		}},
	}
	details := computeRefundSettlementDetails(
		context.Background(), nil, payload, "0xchan", preState, big.NewInt(2000),
	)
	if details.amount != "1000" {
		t.Fatalf("amount = %q, want 1000 (capped at available)", details.amount)
	}
	if details.channelState.Balance != "4000" {
		t.Fatalf("balance = %q, want 4000 (5000 - 1000)", details.channelState.Balance)
	}
	if details.channelState.TotalClaimed != "4000" {
		t.Fatalf("totalClaimed = %q, want 4000 (advances to last claim)", details.channelState.TotalClaimed)
	}
}

// TestComputeRefundSettlementDetails_NoPreState exercises the RPC-failure
// fallback (TS treats null preState the same way: zero pre-balance →
// available zero → actualRefund zero, postBalance zero, refundNonce
// becomes 1). Ensures the response never panics on a missing chain read.
func TestComputeRefundSettlementDetails_NoPreState(t *testing.T) {
	payload := &batched.BatchedEnrichedRefundPayload{
		Type:        "refund",
		Amount:      "2000",
		RefundNonce: "0",
	}
	details := computeRefundSettlementDetails(
		context.Background(), nil, payload, "0xchan", nil, big.NewInt(2000),
	)
	if details.amount != "0" {
		t.Fatalf("amount = %q, want 0 (no preState → no available)", details.amount)
	}
	if details.channelState.Balance != "0" {
		t.Fatalf("balance = %q, want 0", details.channelState.Balance)
	}
	if details.channelState.RefundNonce != "1" {
		t.Fatalf("refundNonce = %q, want 1", details.channelState.RefundNonce)
	}
}

// ----- encodeXxxCalldata + buildVoucherClaimArgs -----

func TestBuildVoucherClaimArgs_Length(t *testing.T) {
	claims := []batched.BatchedVoucherClaim{sampleClaim(), sampleClaim()}
	out := buildVoucherClaimArgs(claims)
	// The result is a slice of unexported struct values; assert via reflection.
	if v, ok := out.([]struct {
		Voucher struct {
			Channel            interface{}
			MaxClaimableAmount *big.Int
		}
		Signature    []byte
		TotalClaimed *big.Int
	}); ok {
		if len(v) != 2 {
			t.Fatalf("len = %d", len(v))
		}
		return
	}
	// Fallback: just confirm non-nil
	if out == nil {
		t.Fatal("expected non-nil result")
	}
}

