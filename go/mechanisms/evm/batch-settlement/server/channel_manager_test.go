package server

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
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

func newManager(s *BatchSettlementEvmScheme, f *fakeFacilitator) *BatchSettlementChannelManager {
	return NewBatchSettlementChannelManager(ChannelManagerConfig{
		Scheme:      s,
		Facilitator: f,
		Receiver:    "0xreceiver",
		Token:       "0xtoken",
		Network:     x402.Network("eip155:8453"),
	})
}

func TestNewBatchSettlementChannelManager(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{}
	m := newManager(s, f)
	if m == nil {
		t.Fatal("expected non-nil manager")
	}
}

func TestClaim_NoClaimableVouchers(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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

// Regression: a successful claim must advance session.TotalClaimed in storage so
// that GetClaimableVouchers no longer returns the same channel until a fresh
// voucher pushes ChargedCumulativeAmount higher. Without this fix, every tick
// re-submits the same claim transaction.
func TestClaim_AdvancesTotalClaimedInStorageAfterSuccess(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	// Use a real ChannelConfig so the manager's post-claim storage lookup
	// (keyed by ComputeChannelId(claim.Voucher.Channel, network)) hits the
	// session we just stored.
	cfg := batchsettlement.ChannelConfig{
		Payer:              "0xabc1000000000000000000000000000000000001",
		PayerAuthorizer:    "0xabc1000000000000000000000000000000000001",
		Receiver:           "0xabc2000000000000000000000000000000000002",
		ReceiverAuthorizer: "0xabc3000000000000000000000000000000000003",
		Token:              "0xabc4000000000000000000000000000000000004",
		WithdrawDelay:      900,
		Salt:               "0x0000000000000000000000000000000000000000000000000000000000000000",
	}
	channelId, err := batchsettlement.ComputeChannelId(cfg, "eip155:8453")
	if err != nil {
		t.Fatalf("ComputeChannelId: %v", err)
	}
	channelId = batchsettlement.NormalizeChannelId(channelId)

	sess := sampleSession(channelId, "1000")
	sess.ChannelConfig = cfg
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	_ = s.UpdateSession(channelId, sess)

	f := &fakeFacilitator{}
	m := &BatchSettlementChannelManager{scheme: s, facilitator: f, network: "eip155:8453"}

	// First claim: storage advances from 100 -> 1000.
	if _, err := m.Claim(context.Background(), nil); err != nil {
		t.Fatalf("first claim: %v", err)
	}
	got, _ := s.GetSession(channelId)
	if got == nil || got.TotalClaimed != "1000" {
		t.Fatalf("expected TotalClaimed=1000 after claim, got %+v", got)
	}

	// Second tick should be a no-op — channel no longer claimable.
	if _, err := m.Claim(context.Background(), nil); err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if f.settleCalls != 1 {
		t.Fatalf("expected 1 facilitator settle call total, got %d (channel was re-claimed)", f.settleCalls)
	}
}

func TestClaim_BatchesAcrossMaxClaimsPerBatch(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{settleErr: errors.New("boom")}
	m := newManager(s, f)
	if _, err := m.Settle(context.Background()); err == nil {
		t.Fatal("expected error")
	}
}

func TestRefund_EmptyChannelIdsRefundsAll(t *testing.T) {
	// Passing nil/empty refunds every stored channel.
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{}
	m := newManager(s, f)
	res, _ := m.Refund(context.Background(), []string{"0xnope"})
	if len(res) != 0 {
		t.Fatalf("expected empty, got %+v", res)
	}
	if f.settleCalls != 0 {
		t.Fatalf("settleCalls = %d", f.settleCalls)
	}
}

func TestRefund_SkipsZeroRefundAmount(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "500")
	sess.Balance = "500" // balance == charged → refund = 0
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	res, _ := m.Refund(context.Background(), []string{"0xa"})
	if len(res) != 0 {
		t.Fatalf("expected empty, got %+v", res)
	}
	if f.settleCalls != 0 {
		t.Fatalf("settleCalls = %d", f.settleCalls)
	}
}

func TestRefund_SkipsMalformedNumbers(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "not-a-number")
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	res, _ := m.Refund(context.Background(), []string{"0xa"})
	if len(res) != 0 {
		t.Fatalf("expected empty, got %+v", res)
	}
}

func TestRefund_SuccessDeletesSession(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	if len(res) != 1 || res[0].Channel != "0xa" {
		t.Fatalf("got %+v", res)
	}
	if res[0].Transaction != "0xtx" {
		t.Fatalf("tx = %s", res[0].Transaction)
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	if len(res) != 0 {
		t.Fatalf("expected empty results on facilitator error, got %+v", res)
	}
	// Session must NOT be deleted on failure.
	if got, _ := s.GetSession("0xa"); got == nil {
		t.Fatal("session unexpectedly deleted after refund error")
	}
}

func TestRefund_WithAuthorizerSignerAttachesSignatures(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", sig: []byte{0xde, 0xad}}
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{
		ReceiverAuthorizerSigner: auth,
	})
	sess := sampleSession("0xab", "500")
	sess.Balance = "1000"
	sess.ChargedCumulativeAmount = "500" // > TotalClaimed (100) → claim batch is non-empty
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

func TestRefund_SkipsChannelWithLivePendingRequest(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.Balance = "1000"
	sess.ChargedCumulativeAmount = "100"
	sess.PendingRequest = &PendingRequest{
		PendingId: "p1",
		ExpiresAt: time.Now().Add(time.Minute).UnixMilli(),
	}
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	res, err := m.Refund(context.Background(), []string{"0xa"})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(res) != 0 {
		t.Fatalf("expected refund to skip in-flight channel, got %+v", res)
	}
}

func TestClaimAndSettle_PropagatesClaimError(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{settleErr: errors.New("boom")}
	m := newManager(s, f)
	if _, _, err := m.ClaimAndSettle(context.Background(), nil); err == nil {
		t.Fatal("expected error")
	}
}

func TestClaimAndSettle_SettlesAfterClaim(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	claims, settle, err := m.ClaimAndSettle(context.Background(), nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(claims) != 1 || claims[0].Transaction != "0xtx" {
		t.Fatalf("claims = %+v", claims)
	}
	if settle == nil || settle.Transaction != "0xtx" {
		t.Fatalf("settle = %+v", settle)
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

func TestClaimAndSettle_SkipsSettleWhenNothingClaimed(t *testing.T) {
	// No claimable vouchers → claim returns empty, settle should not run.
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{}
	m := newManager(s, f)
	claims, settle, err := m.ClaimAndSettle(context.Background(), nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(claims) != 0 {
		t.Fatalf("expected 0 claims, got %d", len(claims))
	}
	if settle != nil {
		t.Fatalf("expected nil settle, got %+v", settle)
	}
	if f.settleCalls != 0 {
		t.Fatalf("expected no facilitator calls, got %d", f.settleCalls)
	}
}

func TestStop_NotRunningIsNoop(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{}
	m := newManager(s, f)
	if err := m.Stop(context.Background(), nil); err != nil {
		t.Fatalf("err: %v", err)
	}
}

func TestStartStop_Idempotent(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{}
	m := newManager(s, f)

	// Long intervals so the goroutines never fire while we're testing.
	m.Start(AutoSettlementConfig{ClaimIntervalSecs: 3600, SettleIntervalSecs: 3600})
	m.Start(AutoSettlementConfig{ClaimIntervalSecs: 3600}) // second Start is a no-op

	if err := m.Stop(context.Background(), nil); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if err := m.Stop(context.Background(), nil); err != nil {
		t.Fatalf("second stop: %v", err)
	}
}

func TestStop_FlushTriggersClaimAndSettle(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	m.Start(AutoSettlementConfig{ClaimIntervalSecs: 3600})
	if err := m.Stop(context.Background(), &StopOptions{Flush: true}); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if f.settleCalls != 2 {
		t.Fatalf("expected claim + settle on flush, got %d", f.settleCalls)
	}
}

// runClaimJob, runSettleJob, runRefundJob are private but covered through the
// public auto-loop here. We seed lastClaimTime/pendingSettle directly via the
// runtime helpers to avoid needing a full timer dance.
func TestRunClaimJob_FiresOnClaim(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	var claims []ClaimResult
	m.autoSettleConfig = AutoSettlementConfig{
		OnClaim: func(r ClaimResult) { claims = append(claims, r) },
	}
	m.runClaimJob(context.Background())
	if f.settleCalls != 1 {
		t.Fatalf("expected 1 claim, got %d", f.settleCalls)
	}
	if len(claims) != 1 {
		t.Fatalf("expected 1 OnClaim, got %d", len(claims))
	}
	m.mu.Lock()
	pendingSettle := m.pendingSettle
	m.mu.Unlock()
	if !pendingSettle {
		t.Fatal("expected pendingSettle = true after claim")
	}
}

func TestRunSettleJob_NoOpUnlessPendingSettle(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{}
	m := newManager(s, f)
	m.autoSettleConfig = AutoSettlementConfig{}
	// pendingSettle = false → runSettleJob is a no-op.
	m.runSettleJob(context.Background())
	if f.settleCalls != 0 {
		t.Fatalf("expected no settle when nothing pending, got %d", f.settleCalls)
	}
}

func TestRunSettleJob_FiresOnSettle(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{}
	m := newManager(s, f)
	var settles []SettleResult
	m.autoSettleConfig = AutoSettlementConfig{
		OnSettle: func(r SettleResult) { settles = append(settles, r) },
	}
	m.mu.Lock()
	m.pendingSettle = true
	m.mu.Unlock()
	m.runSettleJob(context.Background())
	if f.settleCalls != 1 {
		t.Fatalf("expected 1 settle, got %d", f.settleCalls)
	}
	if len(settles) != 1 {
		t.Fatalf("expected OnSettle, got %d", len(settles))
	}
}

func TestRunSettleJob_ShouldSettleFalseSkips(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	f := &fakeFacilitator{}
	m := newManager(s, f)
	m.autoSettleConfig = AutoSettlementConfig{
		ShouldSettle: func(_ AutoSettlementContext) (bool, error) { return false, nil },
	}
	m.mu.Lock()
	m.pendingSettle = true
	m.mu.Unlock()
	m.runSettleJob(context.Background())
	if f.settleCalls != 0 {
		t.Fatalf("expected ShouldSettle=false to skip settle, got %d", f.settleCalls)
	}
}

func TestRunRefundJob_UsesSelectRefundChannels(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.Balance = "1000"
	sess.ChargedCumulativeAmount = "100"
	sess.LastRequestTimestamp = time.Now().Add(-1 * time.Hour).UnixMilli()
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	var refunds []RefundResult
	m.autoSettleConfig = AutoSettlementConfig{
		SelectRefundChannels: func(channels []*ChannelSession, _ AutoSettlementContext) ([]*ChannelSession, error) {
			return channels, nil
		},
		OnRefund: func(r RefundResult) { refunds = append(refunds, r) },
	}
	m.runRefundJob(context.Background())
	if len(refunds) != 1 {
		t.Fatalf("expected refund callback, got %d", len(refunds))
	}
}

func TestRunRefundJob_NoOpWithoutSelectRefundChannels(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession("0xa", "100")
	sess.Balance = "1000"
	sess.ChargedCumulativeAmount = "100"
	_ = s.UpdateSession("0xa", sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	m.autoSettleConfig = AutoSettlementConfig{}
	m.runRefundJob(context.Background())
	if f.settleCalls != 0 {
		t.Fatalf("expected no facilitator calls without selector, got %d", f.settleCalls)
	}
}

func TestGetClaimableVouchers_NoSessions(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
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
