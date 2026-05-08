package server

import (
	"context"
	"testing"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/types"
)

// stubPayload satisfies types.PaymentPayloadView with a mutable underlying map.
type stubPayload struct{ data map[string]interface{} }

func (s *stubPayload) GetVersion() int                    { return 2 }
func (s *stubPayload) GetScheme() string                  { return batchsettlement.SchemeBatched }
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
	return stubRequirements{scheme: batchsettlement.SchemeBatched, network: "eip155:8453", amount: "10"}
}

func voucherPayload(channelId, maxClaimable, sig string) map[string]interface{} {
	return map[string]interface{}{
		"type":          "voucher",
		"channelConfig": batchsettlement.ChannelConfigToMap(testConfig()),
		"voucher": map[string]interface{}{
			"channelId":          channelId,
			"maxClaimableAmount": maxClaimable,
			"signature":          sig,
		},
	}
}

func refundPayload(channelId, maxClaimable, sig string) map[string]interface{} {
	return map[string]interface{}{
		"type":          "refund",
		"channelConfig": batchsettlement.ChannelConfigToMap(testConfig()),
		"voucher": map[string]interface{}{
			"channelId":          channelId,
			"maxClaimableAmount": maxClaimable,
			"signature":          sig,
		},
	}
}

func depositPayloadFor(channelId, maxClaimable, sig string) map[string]interface{} {
	cfg := testConfig()
	return map[string]interface{}{
		"type":          "deposit",
		"channelConfig": batchsettlement.ChannelConfigToMap(cfg),
		"deposit": map[string]interface{}{
			"amount":        "1000",
			"authorization": map[string]interface{}{},
		},
		"voucher": map[string]interface{}{
			"channelId":          channelId,
			"maxClaimableAmount": maxClaimable,
			"signature":          sig,
		},
	}
}

func testConfig() batchsettlement.ChannelConfig {
	return batchsettlement.ChannelConfig{
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	// pass through so the facilitator can verify against onchain state and
	// AfterVerify can rebuild the session.
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	res, err := s.BeforeVerifyHook()(x402.VerifyContext{
		Payload:      &stubPayload{data: refundPayload("0xabcd", "0", "0xsig")},
		Requirements: batchedReqs(),
	})
	if err != nil || res != nil {
		t.Fatalf("expected pass-through, got %+v / %v", res, err)
	}
}

func TestBeforeVerifyHook_NoSessionNonRefundPasses(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	res, err := s.BeforeVerifyHook()(x402.VerifyContext{
		Payload:      &stubPayload{data: voucherPayload("0xabcd", "10", "0xsig")},
		Requirements: batchedReqs(),
	})
	if err != nil || res != nil {
		t.Fatalf("expected pass-through, got %v / %v", res, err)
	}
}

func TestBeforeVerifyHook_StaleCumulativeAborts(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xabcd", "10")
	_ = s.UpdateSession("0xabcd", sess)
	res, err := s.BeforeVerifyHook()(x402.VerifyContext{
		Payload:      &stubPayload{data: voucherPayload("0xabcd", "999", "0xsig")},
		Requirements: batchedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Abort || res.Reason != batchsettlement.ErrCumulativeAmountMismatch {
		t.Fatalf("got %+v", res)
	}
}

func TestBeforeVerifyHook_StaleCumulativeCapturesSnapshot(t *testing.T) {
	// When the payload is a real *types.PaymentPayload (not a stub), aborting
	// must also stash the current session as a snapshot so the resource server
	// can echo ChannelState in the corrective 402.
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xabcd", "10")
	_ = s.UpdateSession("0xabcd", sess)

	pp := &types.PaymentPayload{
		X402Version: 2,
		Payload:     voucherPayload("0xabcd", "999", "0xsig"),
		Accepted:    types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"},
	}
	res, err := s.BeforeVerifyHook()(x402.VerifyContext{
		Payload:      pp,
		Requirements: batchedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Abort {
		t.Fatalf("expected abort, got %+v", res)
	}
	got := s.TakeChannelSnapshot(pp)
	if got == nil || got.ChargedCumulativeAmount != "10" {
		t.Fatalf("expected snapshot for payload, got %+v", got)
	}
}

func TestBeforeVerifyHook_FreshCumulativePasses(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xabcd", "10")
	_ = s.UpdateSession("0xabcd", sess)
	// Refund: expected = prevCharged (10), no req amount added.
	res, err := s.BeforeVerifyHook()(x402.VerifyContext{
		Payload:      &stubPayload{data: refundPayload("0xabcd", "10", "0xsig")},
		Requirements: batchedReqs(),
	})
	if err != nil || res != nil {
		t.Fatalf("expected pass-through, got %v / %v", res, err)
	}
}

func TestBeforeVerifyHook_LivePendingRejectsSameChannel(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xabcd", "10")
	sess.PendingRequest = &PendingRequest{PendingId: "p-live", ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}
	_ = s.UpdateSession("0xabcd", sess)

	res, err := s.BeforeVerifyHook()(x402.VerifyContext{
		Payload:      &stubPayload{data: voucherPayload("0xabcd", "20", "0xsig")},
		Requirements: batchedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Abort || res.Reason != batchsettlement.ErrChannelBusy {
		t.Fatalf("got %+v", res)
	}
}

// ----- AfterVerifyHook -----

func TestAfterVerifyHook_NonBatchedIgnored(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	res, err := s.AfterVerifyHook()(x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{
			Payload:      &stubPayload{data: refundPayload("0xabcd", "10", "0xsig")},
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

func TestOnVerifyFailureHook_ClearsPendingRequest(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := "0xabcd"
	sess := sampleSession(id, "10")
	_ = s.UpdateSession(id, sess)
	reserveDepositPending(t, s, id, "p-verify")
	stub := &stubPayload{data: voucherPayload(id, "20", "0xsig")}
	s.MergeRequestContext(stub, BatchSettlementRequestContext{ChannelId: id, PendingId: "p-verify", ChannelSnapshot: sess})

	res, err := s.OnVerifyFailureHook()(x402.VerifyFailureContext{
		VerifyContext: x402.VerifyContext{Payload: stub, Requirements: batchedReqs()},
	})
	if err != nil || res != nil {
		t.Fatalf("got res=%+v err=%v", res, err)
	}
	got, _ := s.GetSession(id)
	if got == nil || got.PendingRequest != nil {
		t.Fatalf("pending not cleared: %+v", got)
	}
}

// ----- BeforeSettleHook -----

// TestBeforeSettleHook_DepositPassThrough pins the new BeforeSettleHook
// behavior for deposits: pass through to the facilitator with no payload
// mutation. Server-owned deposit enrichment lives in EnrichSettlementResponse
// (which adds chargedCumulativeAmount + chargedAmount additively post-settle).
func TestBeforeSettleHook_DepositPassThrough(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	_ = s.UpdateSession(id, sampleSession(id, "5"))
	payload := depositPayloadFor(id, "100", "0xsig")
	res, err := s.BeforeSettleHook()(x402.SettleContext{
		Payload:      &stubPayload{data: payload},
		Requirements: batchedReqs(),
	})
	if err != nil || res != nil {
		t.Fatalf("got %v / %v", res, err)
	}
	if _, ok := payload["responseExtra"]; ok {
		t.Fatalf("BeforeSettleHook must not annotate responseExtra anymore: %+v", payload)
	}
}

func TestBeforeSettleHook_VoucherWithoutSessionAborts(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	res, err := s.BeforeSettleHook()(x402.SettleContext{
		Payload:      &stubPayload{data: voucherPayload("0xabcd", "10", "0xsig")},
		Requirements: batchedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Abort || res.Reason != batchsettlement.ErrMissingChannel {
		t.Fatalf("got %+v", res)
	}
}

func TestBeforeSettleHook_VoucherSkipsAndUpdates(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	_ = s.UpdateSession("0xabcd", sampleSession("0xabcd", "10"))
	stub := &stubPayload{data: voucherPayload("0xabcd", "20", "0xsig")}
	if _, err := s.BeforeVerifyHook()(x402.VerifyContext{Payload: stub, Requirements: batchedReqs()}); err != nil {
		t.Fatalf("setup verify: %v", err)
	}
	res, err := s.BeforeSettleHook()(x402.SettleContext{
		Payload:      stub,
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
	// Simulate chargedCumulativeAmount changing after reservation.
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	_ = s.UpdateSession("0xabcd", sampleSession("0xabcd", "10"))
	stub := &stubPayload{data: voucherPayload("0xabcd", "20", "0xsig")}
	if _, err := s.BeforeVerifyHook()(x402.VerifyContext{Payload: stub, Requirements: batchedReqs()}); err != nil {
		t.Fatalf("setup verify: %v", err)
	}
	cur, _ := s.GetSession("0xabcd")
	cur.ChargedCumulativeAmount = "15"
	_ = s.UpdateSession("0xabcd", cur)
	res, err := s.BeforeSettleHook()(x402.SettleContext{
		Payload:      stub,
		Requirements: batchedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Abort || res.Reason != batchsettlement.ErrChargeExceedsSignedCumulative {
		t.Fatalf("got %+v", res)
	}
}

// reserveRefundPending sets a pending request on the session so
// EnrichSettlementPayload's pending-id guard passes. Mirrors the way
// BeforeVerifyHook normally provisions the reservation in production flows.
func reserveRefundPending(t *testing.T, s *BatchSettlementEvmScheme, id, pendingId, signedMax, sig string) {
	t.Helper()
	sess, _ := s.GetSession(id)
	if sess == nil {
		t.Fatalf("expected session for %s", id)
	}
	sess.SignedMaxClaimable = signedMax
	sess.Signature = sig
	sess.PendingRequest = &PendingRequest{PendingId: pendingId, ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}
	_ = s.UpdateSession(id, sess)
}

// TestEnrichSettlementPayload_RefundReturnsAdditiveFields pins the new
// EnrichSettlementPayload behavior for refund payloads: returns additive
// `{amount, refundNonce, claims}` (plus signatures when an authorizer signer
// is configured) and never mutates the input payload.
func TestEnrichSettlementPayload_RefundReturnsAdditiveFields(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	sess := sampleSession(id, "10")
	sess.ChannelConfig = testConfig()
	sess.Balance = "1000"
	_ = s.UpdateSession(id, sess)
	reserveRefundPending(t, s, id, "p-refund", "10", "0xsig")
	payload := refundPayload(id, "10", "0xsig")
	stub := &stubPayload{data: payload}
	s.MergeRequestContext(stub, BatchSettlementRequestContext{ChannelId: id, PendingId: "p-refund"})

	out, err := s.EnrichSettlementPayload(x402.SettleContext{
		Payload:      stub,
		Requirements: batchedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if out["refundNonce"] == nil || out["claims"] == nil {
		t.Fatalf("missing additive fields: %+v", out)
	}
	// Original payload must NOT be mutated by EnrichSettlementPayload.
	if _, exists := payload["claims"]; exists {
		t.Fatalf("EnrichSettlementPayload mutated input payload: %+v", payload)
	}
}

func TestEnrichSettlementPayload_RefundNoBalanceErrors(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	sess := sampleSession(id, "1000")
	sess.ChannelConfig = testConfig()
	sess.Balance = "1000"
	_ = s.UpdateSession(id, sess)
	reserveRefundPending(t, s, id, "p-refund", "1000", "0xsig")
	stub := &stubPayload{data: refundPayload(id, "1000", "0xsig")}
	s.MergeRequestContext(stub, BatchSettlementRequestContext{ChannelId: id, PendingId: "p-refund"})

	_, err := s.EnrichSettlementPayload(x402.SettleContext{Payload: stub, Requirements: batchedReqs()})
	if err == nil || err.Error() != batchsettlement.ErrRefundNoBalance {
		t.Fatalf("got %v", err)
	}
}

func TestEnrichSettlementPayload_RefundAmountInvalidErrors(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	sess := sampleSession(id, "10")
	sess.ChannelConfig = testConfig()
	sess.Balance = "1000"
	_ = s.UpdateSession(id, sess)
	reserveRefundPending(t, s, id, "p-refund", "10", "0xsig")
	payload := refundPayload(id, "10", "0xsig")
	payload["amount"] = "not-a-number"
	stub := &stubPayload{data: payload}
	s.MergeRequestContext(stub, BatchSettlementRequestContext{ChannelId: id, PendingId: "p-refund"})

	_, err := s.EnrichSettlementPayload(x402.SettleContext{Payload: stub, Requirements: batchedReqs()})
	if err == nil || err.Error() != batchsettlement.ErrRefundAmountInvalid {
		t.Fatalf("got %v", err)
	}
}

func TestEnrichSettlementPayload_RefundAmountExceedsRemainderErrors(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	sess := sampleSession(id, "10")
	sess.ChannelConfig = testConfig()
	sess.Balance = "1000"
	_ = s.UpdateSession(id, sess)
	reserveRefundPending(t, s, id, "p-refund", "10", "0xsig")
	payload := refundPayload(id, "10", "0xsig")
	payload["amount"] = "9999"
	stub := &stubPayload{data: payload}
	s.MergeRequestContext(stub, BatchSettlementRequestContext{ChannelId: id, PendingId: "p-refund"})

	_, err := s.EnrichSettlementPayload(x402.SettleContext{Payload: stub, Requirements: batchedReqs()})
	if err == nil || err.Error() != batchsettlement.ErrRefundAmountExceedsBalance {
		t.Fatalf("got %v", err)
	}
}

func TestOnSettleFailureHook_ClearsPendingRequest(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := "0xabcd"
	sess := sampleSession(id, "10")
	_ = s.UpdateSession(id, sess)
	reserveDepositPending(t, s, id, "p-settle")
	stub := &stubPayload{data: voucherPayload(id, "20", "0xsig")}
	s.MergeRequestContext(stub, BatchSettlementRequestContext{ChannelId: id, PendingId: "p-settle", ChannelSnapshot: sess})

	res, err := s.OnSettleFailureHook()(x402.SettleFailureContext{
		SettleContext: x402.SettleContext{Payload: stub, Requirements: batchedReqs()},
	})
	if err != nil || res != nil {
		t.Fatalf("got res=%+v err=%v", res, err)
	}
	got, _ := s.GetSession(id)
	if got == nil || got.PendingRequest != nil {
		t.Fatalf("pending not cleared: %+v", got)
	}
}

// ----- AfterSettleHook -----

func TestAfterSettleHook_NonBatchedIgnored(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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

// reserveDepositPending puts a pending reservation on the session so the
// new AfterSettleHook (which gates on matching pendingId before applying
// the on-chain snapshot) accepts the update.
func reserveDepositPending(t *testing.T, s *BatchSettlementEvmScheme, id, pendingId string) {
	t.Helper()
	sess, _ := s.GetSession(id)
	if sess == nil {
		t.Fatalf("expected session for %s", id)
	}
	sess.PendingRequest = &PendingRequest{PendingId: pendingId, ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}
	_ = s.UpdateSession(id, sess)
}

func TestAfterSettleHook_DepositUpdatesBalance(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	_ = s.UpdateSession(id, sampleSession(id, "0"))
	reserveDepositPending(t, s, id, "p-deposit")
	payload := depositPayloadFor(id, "100", "0xsig")
	stub := &stubPayload{data: payload}
	s.MergeRequestContext(stub, BatchSettlementRequestContext{ChannelId: id, PendingId: "p-deposit"})
	// reqAmount is 10 (from batchedReqs); current charged is 0 → expected 10.
	err := s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      stub,
			Requirements: batchedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"channelId":    id,
					"balance":      "2000",
					"totalClaimed": "0",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := s.GetSession(id)
	if got == nil || got.Balance != "2000" || got.ChargedCumulativeAmount != "10" {
		t.Fatalf("session = %+v", got)
	}
}

// Regression: after a successful deposit settle, the AfterSettleHook must
// clear PendingRequest. Otherwise the next voucher hits the 5s pending-TTL
// guard in BeforeVerifyHook and 402's with `invalid_batch_settlement_evm_channel_busy`.
func TestAfterSettleHook_DepositClearsPendingRequest(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	_ = s.UpdateSession(id, sampleSession(id, "0"))
	reserveDepositPending(t, s, id, "p-deposit")
	payload := depositPayloadFor(id, "100", "0xsig")
	stub := &stubPayload{data: payload}
	s.MergeRequestContext(stub, BatchSettlementRequestContext{ChannelId: id, PendingId: "p-deposit"})
	err := s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      stub,
			Requirements: batchedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"channelId":    id,
					"balance":      "2000",
					"totalClaimed": "0",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := s.GetSession(id)
	if got == nil {
		t.Fatal("session unexpectedly missing after deposit AfterSettle")
	}
	if got.PendingRequest != nil {
		t.Fatalf("PendingRequest not cleared after deposit settle: %+v", got.PendingRequest)
	}
}

func TestAfterSettleHook_RefundFullDeletes(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	sess := sampleSession(id, "100")
	sess.ChannelConfig = testConfig()
	sess.Balance = "1000"
	_ = s.UpdateSession(id, sess)
	reserveDepositPending(t, s, id, "p-refund")
	// Refund the full remainder: post-refund balance == chargedCumulative → delete.
	rp := map[string]interface{}{
		"type":          "refund",
		"channelConfig": batchsettlement.ChannelConfigToMap(testConfig()),
		"voucher": map[string]interface{}{
			"channelId":          id,
			"maxClaimableAmount": "100",
			"signature":          "0xsig",
		},
		"amount":      "900",
		"refundNonce": "0",
		"claims":      []interface{}{},
	}
	stub := &stubPayload{data: rp}
	s.MergeRequestContext(stub, BatchSettlementRequestContext{ChannelId: id, PendingId: "p-refund"})
	err := s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      stub,
			Requirements: batchedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"channelId":    id,
					"balance":      "100", // post-refund: equals chargedCumulative → delete
					"totalClaimed": "100",
					"refundNonce":  "1",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got, _ := s.GetSession(id); got != nil {
		t.Fatalf("expected nil after full refund, got %+v", got)
	}
}

func TestAfterSettleHook_RefundFullDeletesAfterPayloadEnrichment(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	sess := sampleSession(id, "100")
	sess.ChannelConfig = testConfig()
	sess.Balance = "1000"
	_ = s.UpdateSession(id, sess)
	pp := &types.PaymentPayload{
		X402Version: 2,
		Payload:     refundPayload(id, "100", "0xsig"),
		Accepted:    types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"},
	}

	res, err := s.BeforeVerifyHook()(x402.VerifyContext{Payload: pp, Requirements: batchedReqs()})
	if err != nil || res != nil {
		t.Fatalf("reserve got %+v / %v", res, err)
	}
	pp.Payload["amount"] = "900"
	pp.Payload["refundNonce"] = "0"
	pp.Payload["claims"] = []interface{}{}

	err = s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      pp,
			Requirements: batchedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"channelId":    id,
					"balance":      "100",
					"totalClaimed": "100",
					"refundNonce":  "1",
				},
			},
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	sess := sampleSession(id, "100")
	sess.ChannelConfig = testConfig()
	sess.Balance = "1000"
	sess.RefundNonce = 0
	_ = s.UpdateSession(id, sess)
	reserveDepositPending(t, s, id, "p-refund")
	rp := map[string]interface{}{
		"type":          "refund",
		"channelConfig": batchsettlement.ChannelConfigToMap(testConfig()),
		"voucher": map[string]interface{}{
			"channelId":          id,
			"maxClaimableAmount": "100",
			"signature":          "0xsig",
		},
		"amount":      "100",
		"refundNonce": "0",
		"claims":      []interface{}{},
	}
	stub := &stubPayload{data: rp}
	s.MergeRequestContext(stub, BatchSettlementRequestContext{ChannelId: id, PendingId: "p-refund"})
	err := s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      stub,
			Requirements: batchedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"channelId":    id,
					"balance":      "900", // post-partial-refund balance > chargedCumulative
					"totalClaimed": "100",
					"refundNonce":  "1",
				},
			},
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
	if got.PendingRequest != nil {
		t.Fatalf("PendingRequest not cleared after partial refund: %+v", got.PendingRequest)
	}
}

func TestAfterSettleHook_RefundPendingMismatchReturnsBusy(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	sess := sampleSession(id, "100")
	sess.ChannelConfig = testConfig()
	sess.Balance = "1000"
	_ = s.UpdateSession(id, sess)
	reserveDepositPending(t, s, id, "p-current")
	rp := map[string]interface{}{
		"type":          "refund",
		"channelConfig": batchsettlement.ChannelConfigToMap(testConfig()),
		"voucher": map[string]interface{}{
			"channelId":          id,
			"maxClaimableAmount": "100",
			"signature":          "0xsig",
		},
		"amount":      "100",
		"refundNonce": "0",
		"claims":      []interface{}{},
	}
	stub := &stubPayload{data: rp}
	s.MergeRequestContext(stub, BatchSettlementRequestContext{ChannelId: id, PendingId: "p-stale"})

	err := s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      stub,
			Requirements: batchedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"channelId":    id,
					"balance":      "900",
					"totalClaimed": "100",
					"refundNonce":  "1",
				},
			},
		},
	})
	if err == nil || err.Error() != batchsettlement.ErrChannelBusy {
		t.Fatalf("got %v", err)
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

// Avoid unused-import error from context import.
var _ = context.Background
