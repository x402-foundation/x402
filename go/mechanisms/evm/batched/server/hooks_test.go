package server

import (
	"context"
	"math/big"
	"testing"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
)

// stubPayload satisfies types.PaymentPayloadView with a mutable underlying map.
type stubPayload struct{ data map[string]interface{} }

func (s *stubPayload) GetVersion() int                    { return 2 }
func (s *stubPayload) GetScheme() string                  { return batched.SchemeBatched }
func (s *stubPayload) GetNetwork() string                 { return "eip155:8453" }
func (s *stubPayload) GetPayload() map[string]interface{} { return s.data }

type stubRequirements struct {
	scheme  string
	network string
	asset   string
	amount  string
}

func (s stubRequirements) GetScheme() string                { return s.scheme }
func (s stubRequirements) GetNetwork() string               { return s.network }
func (s stubRequirements) GetAsset() string                 { return s.asset }
func (s stubRequirements) GetAmount() string                { return s.amount }
func (s stubRequirements) GetPayTo() string                 { return "" }
func (s stubRequirements) GetMaxTimeoutSeconds() int        { return 60 }
func (s stubRequirements) GetExtra() map[string]interface{} { return nil }

func batchedReqs() stubRequirements {
	return stubRequirements{scheme: batched.SchemeBatched, network: "eip155:8453", amount: "10"}
}

func voucherPayload(channelId, maxClaimable, sig string) map[string]interface{} {
	return map[string]interface{}{
		"type":               "voucher",
		"channelConfig":      batched.ChannelConfigToMap(testConfig()),
		"channelId":          channelId,
		"maxClaimableAmount": maxClaimable,
		"signature":          sig,
	}
}

func depositPayloadFor(channelId, maxClaimable, sig string) map[string]interface{} {
	cfg := testConfig()
	return map[string]interface{}{
		"type": "deposit",
		"deposit": map[string]interface{}{
			"channelConfig": batched.ChannelConfigToMap(cfg),
			"amount":        "1000",
		},
		"voucher": map[string]interface{}{
			"channelId":          channelId,
			"maxClaimableAmount": maxClaimable,
			"signature":          sig,
		},
	}
}

func testConfig() batched.ChannelConfig {
	return batched.ChannelConfig{
		Payer:              "0x1111111111111111111111111111111111111111",
		PayerAuthorizer:    "0x2222222222222222222222222222222222222222",
		Receiver:           "0x3333333333333333333333333333333333333333",
		ReceiverAuthorizer: "0xauth",
		Token:              "0x5555555555555555555555555555555555555555",
		WithdrawDelay:      900,
		Salt:               "0x01",
	}
}

// ----- BeforeVerifyHook -----

func TestBeforeVerifyHook_NonBatchedSchemeIgnored(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	req := batchedReqs()
	req.scheme = "exact"
	res, err := s.BeforeVerifyHook()(x402.VerifyContext{
		Payload:      &stubPayload{data: map[string]interface{}{}},
		Requirements: req,
	})
	if err != nil || res != nil {
		t.Fatalf("expected pass-through, got %v / %v", res, err)
	}
}

func TestBeforeVerifyHook_NonVoucherIgnored(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	res, err := s.BeforeVerifyHook()(x402.VerifyContext{
		Payload:      &stubPayload{data: map[string]interface{}{"type": "deposit"}},
		Requirements: batchedReqs(),
	})
	if err != nil || res != nil {
		t.Fatalf("expected pass-through, got %v / %v", res, err)
	}
}

func TestBeforeVerifyHook_RefundWithoutSessionPassesThrough(t *testing.T) {
	// When no local session exists for a refund voucher, BeforeVerify must
	// pass through so the facilitator can verify against on-chain state and
	// AfterVerify can rebuild the session.
	s := NewBatchedEvmScheme("0xreceiver", nil)
	payload := voucherPayload("0xabcd", "0", "0xsig")
	payload["refund"] = true
	res, err := s.BeforeVerifyHook()(x402.VerifyContext{
		Payload:      &stubPayload{data: payload},
		Requirements: batchedReqs(),
	})
	if err != nil || res != nil {
		t.Fatalf("expected pass-through, got %+v / %v", res, err)
	}
}

func TestBeforeVerifyHook_NoSessionNonRefundPasses(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	res, err := s.BeforeVerifyHook()(x402.VerifyContext{
		Payload:      &stubPayload{data: voucherPayload("0xabcd", "10", "0xsig")},
		Requirements: batchedReqs(),
	})
	if err != nil || res != nil {
		t.Fatalf("expected pass-through, got %v / %v", res, err)
	}
}

func TestBeforeVerifyHook_StaleCumulativeAborts(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xabcd", "10")
	_ = s.UpdateSession("0xabcd", sess)
	res, err := s.BeforeVerifyHook()(x402.VerifyContext{
		Payload:      &stubPayload{data: voucherPayload("0xabcd", "999", "0xsig")},
		Requirements: batchedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Abort || res.Reason != "batch_settlement_stale_cumulative_amount" {
		t.Fatalf("got %+v", res)
	}
}

func TestBeforeVerifyHook_FreshCumulativePasses(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xabcd", "10")
	_ = s.UpdateSession("0xabcd", sess)
	// expected = 10 + 10 (req amount) = 20
	res, err := s.BeforeVerifyHook()(x402.VerifyContext{
		Payload:      &stubPayload{data: voucherPayload("0xabcd", "20", "0xsig")},
		Requirements: batchedReqs(),
	})
	if err != nil || res != nil {
		t.Fatalf("expected pass-through, got %v / %v", res, err)
	}
}

func TestBeforeVerifyHook_RefundFreshCumulativePasses(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xabcd", "10")
	_ = s.UpdateSession("0xabcd", sess)
	// Refund: expected = prevCharged (10), no req amount added.
	payload := voucherPayload("0xabcd", "10", "0xsig")
	payload["refund"] = true
	res, err := s.BeforeVerifyHook()(x402.VerifyContext{
		Payload:      &stubPayload{data: payload},
		Requirements: batchedReqs(),
	})
	if err != nil || res != nil {
		t.Fatalf("expected pass-through, got %v / %v", res, err)
	}
}

// ----- AfterVerifyHook -----

func TestAfterVerifyHook_NonBatchedIgnored(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	req := batchedReqs()
	req.scheme = "exact"
	res, err := s.AfterVerifyHook()(x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{
			Payload:      &stubPayload{data: voucherPayload("0xabcd", "10", "0xsig")},
			Requirements: req,
		},
		Result: &x402.VerifyResponse{IsValid: true, Payer: "0xpayer"},
	})
	if err != nil || res != nil {
		t.Fatalf("expected pass-through, got %v / %v", res, err)
	}
}

func TestAfterVerifyHook_InvalidResultIgnored(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	res, err := s.AfterVerifyHook()(x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{
			Payload:      &stubPayload{data: voucherPayload("0xabcd", "10", "0xsig")},
			Requirements: batchedReqs(),
		},
		Result: &x402.VerifyResponse{IsValid: false},
	})
	if err != nil || res != nil {
		t.Fatalf("expected pass-through, got %v / %v", res, err)
	}
}

func TestAfterVerifyHook_VoucherStoresSession(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	res, err := s.AfterVerifyHook()(x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{
			Payload:      &stubPayload{data: voucherPayload("0xabcd", "10", "0xsig")},
			Requirements: batchedReqs(),
		},
		Result: &x402.VerifyResponse{
			IsValid: true, Payer: "0xpayer",
			Extra: map[string]interface{}{"balance": "1000", "totalClaimed": "0"},
		},
	})
	if err != nil || res != nil {
		t.Fatalf("got res=%+v err=%v", res, err)
	}
	got, _ := s.GetSession("0xabcd")
	if got == nil || got.Balance != "1000" || got.SignedMaxClaimable != "10" {
		t.Fatalf("session = %+v", got)
	}
}

func TestAfterVerifyHook_DepositStoresSession(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	id, _ := batched.ComputeChannelId(testConfig())
	_, err := s.AfterVerifyHook()(x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{
			Payload:      &stubPayload{data: depositPayloadFor(id, "100", "0xsig")},
			Requirements: batchedReqs(),
		},
		Result: &x402.VerifyResponse{
			IsValid: true, Payer: "0xpayer",
			Extra: map[string]interface{}{"balance": "1000", "totalClaimed": "0"},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := s.GetSession(id)
	if got == nil || got.SignedMaxClaimable != "100" {
		t.Fatalf("session = %+v", got)
	}
}

func TestAfterVerifyHook_RefundReturnsSkipHandler(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	payload := voucherPayload("0xabcd", "10", "0xsig")
	payload["refund"] = true
	res, err := s.AfterVerifyHook()(x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{
			Payload:      &stubPayload{data: payload},
			Requirements: batchedReqs(),
		},
		Result: &x402.VerifyResponse{
			IsValid: true, Payer: "0xpayer",
			Extra: map[string]interface{}{"balance": "1000", "totalClaimed": "0"},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.SkipHandler || res.Response == nil {
		t.Fatalf("got %+v", res)
	}
}

// ----- BeforeSettleHook -----

func TestBeforeSettleHook_DepositAnnotatesResponseExtra(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	id, _ := batched.ComputeChannelId(testConfig())
	sess := sampleSession(id, "5")
	_ = s.UpdateSession(id, sess)
	payload := depositPayloadFor(id, "100", "0xsig")
	res, err := s.BeforeSettleHook()(x402.SettleContext{
		Payload:      &stubPayload{data: payload},
		Requirements: batchedReqs(),
	})
	if err != nil || res != nil {
		t.Fatalf("got %v / %v", res, err)
	}
	rx, ok := payload["responseExtra"].(map[string]interface{})
	if !ok {
		t.Fatalf("responseExtra missing")
	}
	if rx["chargedCumulativeAmount"] != "15" {
		t.Fatalf("charged = %v", rx["chargedCumulativeAmount"])
	}
}

func TestBeforeSettleHook_VoucherWithoutSessionAborts(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	res, err := s.BeforeSettleHook()(x402.SettleContext{
		Payload:      &stubPayload{data: voucherPayload("0xabcd", "10", "0xsig")},
		Requirements: batchedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Abort || res.Reason != "missing_batched_session" {
		t.Fatalf("got %+v", res)
	}
}

func TestBeforeSettleHook_VoucherSkipsAndUpdates(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	_ = s.UpdateSession("0xabcd", sampleSession("0xabcd", "10"))
	res, err := s.BeforeSettleHook()(x402.SettleContext{
		Payload:      &stubPayload{data: voucherPayload("0xabcd", "20", "0xsig")},
		Requirements: batchedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Skip || res.SkipResult == nil || !res.SkipResult.Success {
		t.Fatalf("got %+v", res)
	}
	got, _ := s.GetSession("0xabcd")
	if got == nil || got.ChargedCumulativeAmount != "20" {
		t.Fatalf("session not updated: %+v", got)
	}
}

func TestBeforeSettleHook_VoucherExceedsSignedCapAborts(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	_ = s.UpdateSession("0xabcd", sampleSession("0xabcd", "10"))
	// Voucher signedCap=15 but charged 10+10=20 → exceeds cap.
	res, err := s.BeforeSettleHook()(x402.SettleContext{
		Payload:      &stubPayload{data: voucherPayload("0xabcd", "15", "0xsig")},
		Requirements: batchedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Abort || res.Reason != "batched_charge_exceeds_signed_cumulative" {
		t.Fatalf("got %+v", res)
	}
}

func TestBeforeSettleHook_RefundRewritesPayload(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	id, _ := batched.ComputeChannelId(testConfig())
	sess := sampleSession(id, "10")
	sess.ChannelConfig = testConfig()
	sess.Balance = "1000"
	_ = s.UpdateSession(id, sess)
	payload := voucherPayload(id, "10", "0xsig")
	payload["refund"] = true
	res, err := s.BeforeSettleHook()(x402.SettleContext{
		Payload:      &stubPayload{data: payload},
		Requirements: batchedReqs(),
	})
	if err != nil || res != nil {
		t.Fatalf("got %v / %v", res, err)
	}
	if payload["settleAction"] != "refundWithSignature" {
		t.Fatalf("not rewritten: %+v", payload)
	}
}

func TestBeforeSettleHook_RefundNoBalanceAborts(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	id, _ := batched.ComputeChannelId(testConfig())
	sess := sampleSession(id, "1000")
	sess.ChannelConfig = testConfig()
	sess.Balance = "1000"
	_ = s.UpdateSession(id, sess)
	payload := voucherPayload(id, "1000", "0xsig")
	payload["refund"] = true
	res, err := s.BeforeSettleHook()(x402.SettleContext{
		Payload:      &stubPayload{data: payload},
		Requirements: batchedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Abort || res.Reason != "batch_settlement_refund_no_balance" {
		t.Fatalf("got %+v", res)
	}
}

func TestBeforeSettleHook_RefundAmountInvalidAborts(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	id, _ := batched.ComputeChannelId(testConfig())
	sess := sampleSession(id, "10")
	sess.ChannelConfig = testConfig()
	sess.Balance = "1000"
	_ = s.UpdateSession(id, sess)
	payload := voucherPayload(id, "10", "0xsig")
	payload["refund"] = true
	payload["refundAmount"] = "not-a-number"
	res, err := s.BeforeSettleHook()(x402.SettleContext{
		Payload:      &stubPayload{data: payload},
		Requirements: batchedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Abort || res.Reason != "batch_settlement_refund_amount_invalid" {
		t.Fatalf("got %+v", res)
	}
}

func TestBeforeSettleHook_RefundAmountExceedsRemainderAborts(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	id, _ := batched.ComputeChannelId(testConfig())
	sess := sampleSession(id, "10")
	sess.ChannelConfig = testConfig()
	sess.Balance = "1000"
	_ = s.UpdateSession(id, sess)
	payload := voucherPayload(id, "10", "0xsig")
	payload["refund"] = true
	payload["refundAmount"] = "9999"
	res, err := s.BeforeSettleHook()(x402.SettleContext{
		Payload:      &stubPayload{data: payload},
		Requirements: batchedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Abort || res.Reason != "batch_settlement_refund_amount_exceeds_balance" {
		t.Fatalf("got %+v", res)
	}
}

// ----- AfterSettleHook -----

func TestAfterSettleHook_NonBatchedIgnored(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	req := batchedReqs()
	req.scheme = "exact"
	err := s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      &stubPayload{data: depositPayloadFor("0xabcd", "100", "0xsig")},
			Requirements: req,
		},
		Result: &x402.SettleResponse{Success: true},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
}

func TestAfterSettleHook_FailedResultIgnored(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	err := s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      &stubPayload{data: depositPayloadFor("0xabcd", "100", "0xsig")},
			Requirements: batchedReqs(),
		},
		Result: &x402.SettleResponse{Success: false},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
}

func TestAfterSettleHook_DepositUpdatesBalance(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	id, _ := batched.ComputeChannelId(testConfig())
	_ = s.UpdateSession(id, sampleSession(id, "0"))
	payload := depositPayloadFor(id, "100", "0xsig")
	payload["responseExtra"] = map[string]interface{}{"chargedCumulativeAmount": "55"}
	err := s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      &stubPayload{data: payload},
			Requirements: batchedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra: map[string]interface{}{
				"channelId":    id,
				"balance":      "2000",
				"totalClaimed": "55",
			},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := s.GetSession(id)
	if got == nil || got.Balance != "2000" || got.ChargedCumulativeAmount != "55" {
		t.Fatalf("session = %+v", got)
	}
}

func TestAfterSettleHook_RefundFullDeletes(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	id, _ := batched.ComputeChannelId(testConfig())
	sess := sampleSession(id, "100")
	sess.ChannelConfig = testConfig()
	sess.Balance = "1000"
	_ = s.UpdateSession(id, sess)
	// Refund the full remainder: balance 1000 - charged 100 = 900 to refund.
	refundPayload := map[string]interface{}{
		"settleAction": "refundWithSignature",
		"config":       batched.ChannelConfigToMap(testConfig()),
		"amount":       "900",
		"nonce":        "0",
	}
	err := s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      &stubPayload{data: refundPayload},
			Requirements: batchedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra:   map[string]interface{}{"refundedAmount": "900"},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got, _ := s.GetSession(id); got != nil {
		t.Fatalf("expected nil after full refund, got %+v", got)
	}
}

func TestAfterSettleHook_RefundPartialUpdates(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	id, _ := batched.ComputeChannelId(testConfig())
	sess := sampleSession(id, "100")
	sess.ChannelConfig = testConfig()
	sess.Balance = "1000"
	sess.RefundNonce = 0
	_ = s.UpdateSession(id, sess)
	refundPayload := map[string]interface{}{
		"settleAction": "refundWithSignature",
		"config":       batched.ChannelConfigToMap(testConfig()),
		"amount":       "100",
		"nonce":        "0",
	}
	err := s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      &stubPayload{data: refundPayload},
			Requirements: batchedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra:   map[string]interface{}{"refundedAmount": "100"},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := s.GetSession(id)
	if got == nil {
		t.Fatal("expected session preserved after partial refund")
	}
	if got.Balance != "900" {
		t.Fatalf("balance = %s", got.Balance)
	}
	if got.RefundNonce != 1 {
		t.Fatalf("nonce = %d", got.RefundNonce)
	}
}

// ----- helpers -----

func TestMapStringField(t *testing.T) {
	if got := mapStringField(nil, "k", "default"); got != "default" {
		t.Fatalf("nil = %s", got)
	}
	m := map[string]interface{}{"a": "x", "b": float64(42)}
	if got := mapStringField(m, "a", "d"); got != "x" {
		t.Fatalf("string = %s", got)
	}
	if got := mapStringField(m, "b", "d"); got != "42" {
		t.Fatalf("float = %s", got)
	}
	if got := mapStringField(m, "c", "d"); got != "d" {
		t.Fatalf("missing = %s", got)
	}
}

func TestMapIntField(t *testing.T) {
	if got := mapIntField(nil, "k", 7); got != 7 {
		t.Fatalf("nil = %d", got)
	}
	m := map[string]interface{}{"a": float64(1), "b": int(2), "c": "3", "d": "nope"}
	if got := mapIntField(m, "a", 0); got != 1 {
		t.Fatalf("float = %d", got)
	}
	if got := mapIntField(m, "b", 0); got != 2 {
		t.Fatalf("int = %d", got)
	}
	if got := mapIntField(m, "c", 0); got != 3 {
		t.Fatalf("string = %d", got)
	}
	if got := mapIntField(m, "d", 99); got != 99 {
		t.Fatalf("bad string fallback = %d", got)
	}
	if got := mapIntField(m, "missing", 5); got != 5 {
		t.Fatalf("missing = %d", got)
	}
}

func TestBuildRefundResponseSnapshot(t *testing.T) {
	sess := sampleSession("0xa", "100")
	sess.Balance = "1000"
	sess.RefundNonce = 3
	out := buildRefundResponseSnapshot(sess, "0xa", big.NewInt(200))
	if out.ChannelId != "0xa" || out.Balance != "800" || out.RefundedAmount != "200" {
		t.Fatalf("got %+v", out)
	}
	if out.RefundNonce != "4" {
		t.Fatalf("nonce = %s", out.RefundNonce)
	}
	if !out.Refund {
		t.Fatal("expected refund=true")
	}
}

// Avoid unused-import error from context import.
var _ = context.Background
