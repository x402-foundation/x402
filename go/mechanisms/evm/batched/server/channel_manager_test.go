package server

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	x402 "github.com/x402-foundation/x402/go"
)

// fakeFacilitator records Settle/Verify calls and returns canned responses.
type fakeFacilitator struct {
	mu             sync.Mutex
	settleCalls    int
	settlePayloads []map[string]interface{}
	settleResp     *x402.SettleResponse
	settleErr      error
	verifyCalls    int
	verifyResp     *x402.VerifyResponse
	verifyErr      error
}

func (f *fakeFacilitator) Verify(_ context.Context, _ []byte, _ []byte) (*x402.VerifyResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.verifyCalls++
	if f.verifyResp != nil {
		return f.verifyResp, f.verifyErr
	}
	return &x402.VerifyResponse{IsValid: true}, f.verifyErr
}

func (f *fakeFacilitator) Settle(_ context.Context, payloadBytes []byte, _ []byte) (*x402.SettleResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.settleCalls++
	var env map[string]interface{}
	if json.Unmarshal(payloadBytes, &env) == nil {
		if p, ok := env["payload"].(map[string]interface{}); ok {
			f.settlePayloads = append(f.settlePayloads, p)
		}
	}
	if f.settleErr != nil {
		return nil, f.settleErr
	}
	if f.settleResp != nil {
		return f.settleResp, nil
	}
	return &x402.SettleResponse{Success: true, Transaction: "0xtx"}, nil
}

func (f *fakeFacilitator) GetSupported(_ context.Context) (x402.SupportedResponse, error) {
	return x402.SupportedResponse{}, nil
}

func newManager(s *BatchedEvmScheme, f *fakeFacilitator) *BatchedChannelManager {
	return NewBatchedChannelManager(ChannelManagerConfig{
		Scheme:      s,
		Facilitator: f,
		Network:     x402.Network("eip155:8453"),
	})
}

func TestNewBatchedChannelManager(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{}
	m := newManager(s, f)
	if m == nil {
		t.Fatal("expected non-nil manager")
	}
}

func TestClaim_NoClaimableVouchers(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{}
	m := newManager(s, f)
	results, err := m.Claim(context.Background(), nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(results) != 0 || f.settleCalls != 0 {
		t.Fatalf("expected no settle calls, got %d", f.settleCalls)
	}
}

func TestClaim_SingleBatch(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	results, err := m.Claim(context.Background(), nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 || results[0].Transaction != "0xtx" {
		t.Fatalf("got %+v", results)
	}
	if f.settleCalls != 1 {
		t.Fatalf("settleCalls = %d", f.settleCalls)
	}
	if f.settlePayloads[0]["type"] != "claim" {
		t.Fatalf("payload = %+v", f.settlePayloads[0])
	}
}

func TestClaim_BatchesAcrossMaxClaimsPerBatch(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	for _, id := range []string{"0xa", "0xb", "0xc"} {
		sess := sampleSession(id, "100")
		sess.SignedMaxClaimable = "1000"
		sess.TotalClaimed = "100"
		sess.ChargedCumulativeAmount = "1000"
		_ = s.UpdateSession(id, sess)
	}

	f := &fakeFacilitator{}
	m := newManager(s, f)
	results, err := m.Claim(context.Background(), &ClaimOptions{MaxClaimsPerBatch: 2})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if f.settleCalls != 2 {
		t.Fatalf("expected 2 batches, got %d", f.settleCalls)
	}
	total := 0
	for _, r := range results {
		total += r.Vouchers
	}
	if total != 3 {
		t.Fatalf("expected 3 vouchers across batches, got %d", total)
	}
}

func TestClaim_FacilitatorError(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{settleErr: errors.New("boom")}
	m := newManager(s, f)
	_, err := m.Claim(context.Background(), nil)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSettle_Success(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.ChannelConfig.Token = "0xtoken"
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	res, err := m.Settle(context.Background())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || res.Transaction != "0xtx" {
		t.Fatalf("got %+v", res)
	}
	if f.settlePayloads[0]["type"] != "settle" {
		t.Fatalf("payload = %+v", f.settlePayloads[0])
	}
	if f.settlePayloads[0]["token"] != "0xtoken" {
		t.Fatalf("token = %v", f.settlePayloads[0]["token"])
	}
}

func TestSettle_FacilitatorError(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{settleErr: errors.New("boom")}
	m := newManager(s, f)
	if _, err := m.Settle(context.Background()); err == nil {
		t.Fatal("expected error")
	}
}

func TestRefund_EmptyChannelIds(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{}
	m := newManager(s, f)
	res, err := m.Refund(context.Background(), nil)
	if err != nil || res != nil {
		t.Fatalf("got res=%+v err=%v", res, err)
	}
	if f.settleCalls != 0 {
		t.Fatalf("settleCalls = %d", f.settleCalls)
	}
}

func TestRefund_SkipsMissingSession(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{}
	m := newManager(s, f)
	res, _ := m.Refund(context.Background(), []string{"0xnope"})
	if res != nil {
		t.Fatalf("expected nil, got %+v", res)
	}
	if f.settleCalls != 0 {
		t.Fatalf("settleCalls = %d", f.settleCalls)
	}
}

func TestRefund_SkipsZeroRefundAmount(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "500")
	sess.Balance = "500" // balance == charged → refund = 0
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	res, _ := m.Refund(context.Background(), []string{"0xa"})
	if res != nil {
		t.Fatalf("expected nil, got %+v", res)
	}
	if f.settleCalls != 0 {
		t.Fatalf("settleCalls = %d", f.settleCalls)
	}
}

func TestRefund_SkipsMalformedNumbers(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "not-a-number")
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	res, _ := m.Refund(context.Background(), []string{"0xa"})
	if res != nil {
		t.Fatalf("expected nil, got %+v", res)
	}
}

func TestRefund_SuccessDeletesSession(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.Balance = "1000"
	sess.ChargedCumulativeAmount = "100"
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	res, err := m.Refund(context.Background(), []string{"0xa"})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || len(res.Channels) != 1 || res.Channels[0] != "0xa" {
		t.Fatalf("got %+v", res)
	}
	if res.Transaction != "0xtx" {
		t.Fatalf("tx = %s", res.Transaction)
	}
	if f.settlePayloads[0]["type"] != "refund" {
		t.Fatalf("payload = %+v", f.settlePayloads[0])
	}
	// Session should be deleted.
	if got, _ := s.GetSession("0xa"); got != nil {
		t.Fatalf("expected session deleted, got %+v", got)
	}
}

func TestRefund_FacilitatorErrorIsReturned(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.Balance = "1000"
	sess.ChargedCumulativeAmount = "100"
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{settleErr: errors.New("boom")}
	m := newManager(s, f)
	res, err := m.Refund(context.Background(), []string{"0xa"})
	if err == nil {
		t.Fatal("expected error from facilitator failure")
	}
	if res != nil {
		t.Fatalf("expected nil result on facilitator error, got %+v", res)
	}
	// Session must NOT be deleted on failure.
	if got, _ := s.GetSession("0xa"); got == nil {
		t.Fatal("session unexpectedly deleted after refund error")
	}
}

func TestRefund_WithAuthorizerSignerAttachesSignatures(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", sig: []byte{0xde, 0xad}}
	s := NewBatchedEvmScheme("0xreceiver", &BatchedEvmSchemeConfig{
		ReceiverAuthorizerSigner: auth,
	})
	sess := sampleSession("0xab", "100")
	sess.Balance = "1000"
	sess.ChargedCumulativeAmount = "100"
	_ = s.UpdateSession("0xab", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	if _, err := m.Refund(context.Background(), []string{"0xab"}); err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(f.settlePayloads) == 0 {
		t.Fatalf("expected settle to be called, got %d calls", f.settleCalls)
	}
	p := f.settlePayloads[0]
	if p["refundAuthorizerSignature"] == nil || p["claimAuthorizerSignature"] == nil {
		t.Fatalf("missing pre-signed sigs in %+v", p)
	}
	if auth.calls < 2 {
		t.Fatalf("expected SignTypedData called for refund + claim, got %d", auth.calls)
	}
}

func TestClaimAndSettle_PropagatesClaimError(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{settleErr: errors.New("boom")}
	m := newManager(s, f)
	if _, err := m.ClaimAndSettle(context.Background(), nil); err == nil {
		t.Fatal("expected error")
	}
}

func TestClaimAndSettle_SettlesAfterClaim(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	res, err := m.ClaimAndSettle(context.Background(), nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || res.Transaction != "0xtx" {
		t.Fatalf("got %+v", res)
	}
	if f.settleCalls != 2 {
		t.Fatalf("expected claim + settle, got %d", f.settleCalls)
	}
	if f.settlePayloads[0]["type"] != "claim" {
		t.Fatalf("first payload = %+v", f.settlePayloads[0])
	}
	if f.settlePayloads[1]["type"] != "settle" {
		t.Fatalf("second payload = %+v", f.settlePayloads[1])
	}
}

func TestStop_NotRunningIsNoop(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{}
	m := newManager(s, f)
	if err := m.Stop(context.Background(), false); err != nil {
		t.Fatalf("err: %v", err)
	}
}

func TestStartStop_Idempotent(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{}
	m := newManager(s, f)

	// Use a long tick so the goroutine doesn't fire while we're testing.
	m.Start(AutoSettlementConfig{TickSecs: 3600})
	m.Start(AutoSettlementConfig{TickSecs: 3600}) // second Start is no-op

	if err := m.Stop(context.Background(), false); err != nil {
		t.Fatalf("stop: %v", err)
	}
	// Second Stop is no-op.
	if err := m.Stop(context.Background(), false); err != nil {
		t.Fatalf("second stop: %v", err)
	}
}

func TestStop_FlushTriggersClaimAndSettle(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	m.Start(AutoSettlementConfig{TickSecs: 3600})
	if err := m.Stop(context.Background(), true); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if f.settleCalls != 2 {
		t.Fatalf("expected claim + settle on flush, got %d", f.settleCalls)
	}
}

func TestTick_ClaimOnInterval(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)

	var claimResults []ClaimResult
	var mu sync.Mutex
	m.config = AutoSettlementConfig{
		ClaimIntervalSecs: 1,
		OnClaim: func(r ClaimResult) {
			mu.Lock()
			defer mu.Unlock()
			claimResults = append(claimResults, r)
		},
	}
	m.lastClaimTime = time.Now().Add(-2 * time.Second)
	m.tick()

	if f.settleCalls != 1 {
		t.Fatalf("expected 1 claim, got %d", f.settleCalls)
	}
	mu.Lock()
	if len(claimResults) != 1 {
		t.Fatalf("expected 1 OnClaim callback, got %d", len(claimResults))
	}
	mu.Unlock()
	if !m.pendingSettle {
		t.Fatal("expected pendingSettle = true after claim")
	}
}

func TestTick_SettleAfterClaimOnInterval(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{}
	m := newManager(s, f)

	var settleResults []SettleResult
	m.config = AutoSettlementConfig{
		SettleIntervalSecs: 1,
		OnSettle: func(r SettleResult) {
			settleResults = append(settleResults, r)
		},
	}
	m.lastSettleTime = time.Now().Add(-2 * time.Second)
	m.pendingSettle = true
	m.tick()

	if f.settleCalls != 1 {
		t.Fatalf("expected 1 settle, got %d", f.settleCalls)
	}
	if len(settleResults) != 1 {
		t.Fatalf("expected OnSettle callback, got %d", len(settleResults))
	}
	if m.pendingSettle {
		t.Fatal("expected pendingSettle = false after settle")
	}
}

func TestTick_SettleErrorTriggersOnError(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{settleErr: errors.New("boom")}
	m := newManager(s, f)

	var errs []error
	m.config = AutoSettlementConfig{
		SettleIntervalSecs: 1,
		OnError:            func(e error) { errs = append(errs, e) },
	}
	m.lastSettleTime = time.Now().Add(-2 * time.Second)
	m.pendingSettle = true
	m.tick()

	if len(errs) != 1 {
		t.Fatalf("expected OnError callback, got %d", len(errs))
	}
}

func TestTick_ClaimThresholdTriggers(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	m.config = AutoSettlementConfig{ClaimThreshold: "500"} // 1000-100 = 900 ≥ 500
	m.tick()

	if f.settleCalls != 1 {
		t.Fatalf("expected claim triggered by threshold, got %d", f.settleCalls)
	}
}

func TestTick_ClaimThresholdBelowDoesNotTrigger(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	m.config = AutoSettlementConfig{ClaimThreshold: "10000"} // 900 < 10000
	m.tick()

	if f.settleCalls != 0 {
		t.Fatalf("expected no claim, got %d", f.settleCalls)
	}
}

func TestTick_ClaimOnWithdrawalTriggers(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	// Session with pending withdrawal AND claimable amount.
	sess := sampleSession("0xa", "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	sess.WithdrawRequestedAt = 12345
	sess.ChannelConfig.Payer = "0xpayer"
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	m.config = AutoSettlementConfig{ClaimOnWithdrawal: true}
	m.tick()

	if f.settleCalls != 1 {
		t.Fatalf("expected claim, got %d", f.settleCalls)
	}
}

func TestTick_RefundOnIdleTriggers(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.Balance = "1000"
	sess.ChargedCumulativeAmount = "100"
	sess.LastRequestTimestamp = time.Now().Add(-1 * time.Hour).UnixMilli() // very idle
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)

	var refundResults []RefundResult
	m.config = AutoSettlementConfig{
		RefundOnIdleSecs: 1,
		OnRefund:         func(r RefundResult) { refundResults = append(refundResults, r) },
	}
	m.tick()

	if len(refundResults) != 1 {
		t.Fatalf("expected refund callback, got %d", len(refundResults))
	}
}

func TestTick_ConcurrentTicksAreSerialized(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	_ = s.UpdateSession("0xa", sess)

	// Slow facilitator so tick takes time.
	slow := &slowFacilitator{delay: 50 * time.Millisecond}
	m := NewBatchedChannelManager(ChannelManagerConfig{
		Scheme:      s,
		Facilitator: slow,
		Network:     x402.Network("eip155:8453"),
	})
	m.config = AutoSettlementConfig{ClaimIntervalSecs: 1}
	m.lastClaimTime = time.Now().Add(-2 * time.Second)

	var wg sync.WaitGroup
	for range 5 {
		wg.Add(1)
		go func() { defer wg.Done(); m.tick() }()
	}
	wg.Wait()

	// Only one tick should have run to completion; others bailed via CAS.
	if got := slow.settleCalls(); got != 1 {
		t.Fatalf("expected exactly 1 settle (CAS-serialized), got %d", got)
	}
}

// slowFacilitator sleeps inside Settle so concurrent tick() invocations contend.
type slowFacilitator struct {
	mu    sync.Mutex
	calls int
	delay time.Duration
}

func (s *slowFacilitator) Verify(_ context.Context, _ []byte, _ []byte) (*x402.VerifyResponse, error) {
	return &x402.VerifyResponse{IsValid: true}, nil
}
func (s *slowFacilitator) Settle(_ context.Context, _ []byte, _ []byte) (*x402.SettleResponse, error) {
	time.Sleep(s.delay)
	s.mu.Lock()
	s.calls++
	s.mu.Unlock()
	return &x402.SettleResponse{Success: true, Transaction: "0xtx"}, nil
}
func (s *slowFacilitator) GetSupported(_ context.Context) (x402.SupportedResponse, error) {
	return x402.SupportedResponse{}, nil
}
func (s *slowFacilitator) settleCalls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func TestGetClaimableVouchers_NoSessions(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	m := newManager(s, &fakeFacilitator{})
	got, err := m.GetClaimableVouchers(nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected zero claims, got %d", len(got))
	}
}

func TestGetClaimableVouchers_FiltersUnclaimed(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "10")
	sess.SignedMaxClaimable = "10"
	sess.TotalClaimed = "10"
	_ = s.UpdateSession("0xa", sess)
	m := newManager(s, &fakeFacilitator{})
	got, _ := m.GetClaimableVouchers(nil)
	if len(got) != 0 {
		t.Fatalf("expected 0, got %d", len(got))
	}
}

func TestGetClaimableVouchers_ReturnsClaimable(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	_ = s.UpdateSession("0xa", sess)
	m := newManager(s, &fakeFacilitator{})
	got, err := m.GetClaimableVouchers(nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(got) != 1 || got[0].Voucher.MaxClaimableAmount != "1000" {
		t.Fatalf("got %+v", got)
	}
}

func TestGetClaimableVouchers_FiltersByIdle(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	sess.LastRequestTimestamp = nowMs() // very recent
	_ = s.UpdateSession("0xa", sess)
	m := newManager(s, &fakeFacilitator{})
	got, _ := m.GetClaimableVouchers(&GetClaimableVouchersOpts{IdleSecs: 3600})
	if len(got) != 0 {
		t.Fatalf("expected idle filter to drop session, got %d", len(got))
	}
}

func TestGetWithdrawalPendingSessions(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	a := sampleSession("0xa", "10")
	b := sampleSession("0xb", "10")
	b.WithdrawRequestedAt = 12345
	_ = s.UpdateSession("0xa", a)
	_ = s.UpdateSession("0xb", b)
	m := newManager(s, &fakeFacilitator{})
	got, err := m.GetWithdrawalPendingSessions()
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(got) != 1 || got[0].ChannelId != "0xb" {
		t.Fatalf("got %+v", got)
	}
}
