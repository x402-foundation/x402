package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"reflect"
	"sync"
	"testing"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/facilitator"
)

// fakeFacilitator records Settle/Verify calls and returns canned responses.
type fakeFacilitator struct {
	mu             sync.Mutex
	settleCalls    int
	settlePayloads []map[string]interface{}
	settleResp     *x402.SettleResponse
	settleErr      error
	settleErrAt    map[int]error // fails the Nth (1-indexed) Settle call
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
	if err, ok := f.settleErrAt[f.settleCalls]; ok {
		return nil, err
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
	return newManagerOn(s, f, "eip155:8453")
}

func newManagerOn(s *BatchSettlementEvmScheme, f *fakeFacilitator, network x402.Network) *BatchSettlementChannelManager {
	return NewBatchSettlementChannelManager(ChannelManagerConfig{
		Scheme:      s,
		Facilitator: f,
		Receiver:    "0xreceiver",
		Token:       "0xtoken",
		Network:     network,
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
	sess := sampleSession(testChA, "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	seedSession(t, s, testChA, sess)

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
	channelId, err = batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		t.Fatal(err)
	}

	sess := sampleSession(channelId, "1000")
	sess.ChannelConfig = cfg
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	seedSession(t, s, channelId, sess)

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
	for _, id := range []string{testChA, testChB, testChC} {
		sess := sampleSession(id, "100")
		sess.SignedMaxClaimable = "1000"
		sess.TotalClaimed = "100"
		sess.ChargedCumulativeAmount = "1000"
		seedSession(t, s, id, sess)
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
	sess := sampleSession(testChA, "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	seedSession(t, s, testChA, sess)

	f := &fakeFacilitator{settleErr: errors.New("boom")}
	m := newManager(s, f)
	_, err := m.Claim(context.Background(), nil)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSettle_Success(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession(testChA, "100")
	sess.ChannelConfig.Token = "0xtoken"
	seedSession(t, s, testChA, sess)

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
	sess := sampleSession(testChA, "500")
	sess.Balance = "500" // balance == charged → refund = 0
	seedSession(t, s, testChA, sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	res, _ := m.Refund(context.Background(), []string{testChA})
	if len(res) != 0 {
		t.Fatalf("expected empty, got %+v", res)
	}
	if f.settleCalls != 0 {
		t.Fatalf("settleCalls = %d", f.settleCalls)
	}
}

func TestRefund_SkipsMalformedNumbers(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession(testChA, "not-a-number")
	seedSession(t, s, testChA, sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	res, _ := m.Refund(context.Background(), []string{testChA})
	if len(res) != 0 {
		t.Fatalf("expected empty, got %+v", res)
	}
}

func TestRefund_SuccessDeletesSession(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession(testChA, "100")
	sess.Balance = "1000"
	sess.ChargedCumulativeAmount = "100"
	seedSession(t, s, testChA, sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	res, err := m.Refund(context.Background(), []string{testChA})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(res) != 1 || res[0].Channel != testChA {
		t.Fatalf("got %+v", res)
	}
	if res[0].Transaction != "0xtx" {
		t.Fatalf("tx = %s", res[0].Transaction)
	}
	if f.settlePayloads[0]["type"] != "refund" {
		t.Fatalf("payload = %+v", f.settlePayloads[0])
	}
	// Session should be deleted.
	if got, _ := s.GetSession(testChA); got != nil {
		t.Fatalf("expected session deleted, got %+v", got)
	}
}

func TestRefund_FacilitatorErrorIsReturned(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession(testChA, "100")
	sess.Balance = "1000"
	sess.ChargedCumulativeAmount = "100"
	seedSession(t, s, testChA, sess)

	f := &fakeFacilitator{settleErr: errors.New("boom")}
	m := newManager(s, f)
	res, err := m.Refund(context.Background(), []string{testChA})
	if err == nil {
		t.Fatal("expected error from facilitator failure")
	}
	if len(res) != 0 {
		t.Fatalf("expected empty results on facilitator error, got %+v", res)
	}
	// Session must NOT be deleted on failure.
	if got, _ := s.GetSession(testChA); got == nil {
		t.Fatal("session unexpectedly deleted after refund error")
	}
}

func TestRefund_WithAuthorizerSignerAttachesSignatures(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", sig: []byte{0xde, 0xad}}
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{
		ReceiverAuthorizerSigner: auth,
	})
	sess := sampleSession(testChA, "500")
	sess.Balance = "1000"
	sess.ChargedCumulativeAmount = "500" // > TotalClaimed (100) → claim batch is non-empty
	seedSession(t, s, testChA, sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	if _, err := m.Refund(context.Background(), []string{testChA}); err != nil {
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

func TestRefund_SkipsChannelWithLiveAdmissionLock(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession(testChA, "100")
	sess.Balance = "1000"
	sess.ChargedCumulativeAmount = "100"
	seedSession(t, s, testChA, sess)
	if _, err := s.GetLockStorage().Acquire(context.Background(), testChA, "p1", 60_000); err != nil {
		t.Fatalf("Acquire: %v", err)
	}

	f := &fakeFacilitator{}
	m := newManager(s, f)
	res, err := m.Refund(context.Background(), []string{testChA})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(res) != 0 {
		t.Fatalf("expected refund to skip in-flight channel, got %+v", res)
	}
}

func TestRefund_StillRefundsWhenLockStoreThrows(t *testing.T) {
	storage := NewInMemoryChannelStorage()
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{
		Storage:     storage,
		LockStorage: throwingLockStorage{},
	})
	sess := sampleSession(testChA, "1000")
	sess.Balance = "10000"
	sess.ChargedCumulativeAmount = "1000"
	seedSession(t, s, testChA, sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	res, err := m.Refund(context.Background(), []string{testChA})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(res) != 1 || res[0].Channel != testChA || res[0].Transaction != "0xtx" {
		t.Fatalf("got %+v", res)
	}
}

func TestRefund_IsHeldSyntaxErrorFailsClosed(t *testing.T) {
	storage := NewInMemoryChannelStorage()
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{
		Storage:     storage,
		LockStorage: errLockStorage{isHeldErr: corruptHoldError()},
	})
	sess := sampleSession(testChA, "1000")
	sess.Balance = "10000"
	sess.ChargedCumulativeAmount = "1000"
	seedSession(t, s, testChA, sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	_, err := m.Refund(context.Background(), []string{testChA})
	requireSyntaxError(t, err)
}

func TestClaim_PreservesLiveAdmissionLock(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession(testChA, "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	seedSession(t, s, testChA, sess)
	if _, err := s.GetLockStorage().Acquire(context.Background(), testChA, "pending", 60_000); err != nil {
		t.Fatalf("Acquire: %v", err)
	}

	f := &fakeFacilitator{}
	m := newManager(s, f)
	results, err := m.Claim(context.Background(), nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(results) != 1 || results[0].Transaction != "0xtx" {
		t.Fatalf("got %+v", results)
	}
	held, err := s.GetLockStorage().IsHeld(context.Background(), testChA, "pending")
	if err != nil || !held {
		t.Fatalf("expected lock held: held=%v err=%v", held, err)
	}
}

func TestClaimAndSettle_PropagatesClaimError(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession(testChA, "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	seedSession(t, s, testChA, sess)

	f := &fakeFacilitator{settleErr: errors.New("boom")}
	m := newManager(s, f)
	if _, _, err := m.ClaimAndSettle(context.Background(), nil); err == nil {
		t.Fatal("expected error")
	}
}

func TestClaimAndSettle_SettlesAfterClaim(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession(testChA, "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	seedSession(t, s, testChA, sess)

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
	sess := sampleSession(testChA, "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	seedSession(t, s, testChA, sess)

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
	sess := sampleSession(testChA, "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	seedSession(t, s, testChA, sess)

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
	sess := sampleSession(testChA, "100")
	sess.Balance = "1000"
	sess.ChargedCumulativeAmount = "100"
	sess.LastRequestTimestamp = time.Now().Add(-1 * time.Hour).UnixMilli()
	seedSession(t, s, testChA, sess)

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
	sess := sampleSession(testChA, "100")
	sess.Balance = "1000"
	sess.ChargedCumulativeAmount = "100"
	seedSession(t, s, testChA, sess)

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
	sess := sampleSession(testChA, "10")
	sess.SignedMaxClaimable = "10"
	sess.TotalClaimed = "10"
	seedSession(t, s, testChA, sess)
	m := newManager(s, &fakeFacilitator{})
	got, _ := m.GetClaimableVouchers(nil)
	if len(got) != 0 {
		t.Fatalf("expected 0, got %d", len(got))
	}
}

func TestGetClaimableVouchers_ReturnsClaimable(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession(testChA, "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	seedSession(t, s, testChA, sess)
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
	sess := sampleSession(testChA, "100")
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.ChargedCumulativeAmount = "1000"
	sess.LastRequestTimestamp = nowMs() // very recent
	seedSession(t, s, testChA, sess)
	m := newManager(s, &fakeFacilitator{})
	got, _ := m.GetClaimableVouchers(&GetClaimableVouchersOpts{IdleSecs: 3600})
	if len(got) != 0 {
		t.Fatalf("expected idle filter to drop session, got %d", len(got))
	}
}

func TestGetWithdrawalPendingSessions(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	a := sampleSession(testChA, "10")
	b := sampleSession(testChB, "10")
	b.WithdrawRequestedAt = 12345
	seedSession(t, s, testChA, a)
	seedSession(t, s, testChB, b)
	m := newManager(s, &fakeFacilitator{})
	got, err := m.GetWithdrawalPendingSessions()
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(got) != 1 || got[0].ChannelId != testChB {
		t.Fatalf("got %+v", got)
	}
}

func buildManagedManager(t *testing.T) (*BatchSettlementChannelManager, *fakeFacilitator, SessionStorage) {
	t.Helper()
	store := NewInMemoryChannelStorage()
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{
		VoucherStoreMode: VoucherStoreModeFacilitator,
		Storage:          store,
	})
	f := &fakeFacilitator{}
	return newManager(s, f), f, store
}

func TestChannelManager_ManagedClaimFromReplica(t *testing.T) {
	m, f, store := buildManagedManager(t)
	sess := sampleSession(testChA, "100")
	sess.ChargedCumulativeAmount = "5000"
	sess.TotalClaimed = "0"
	seedStore(t, store, testChA, sess)
	results, err := m.Claim(context.Background(), nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(results) != 1 || f.settleCalls != 1 {
		t.Fatalf("results=%+v settleCalls=%d", results, f.settleCalls)
	}
	if f.settlePayloads[0]["type"] != "claim" {
		t.Fatalf("payload = %+v", f.settlePayloads[0])
	}
}

func TestChannelManager_ManagedRefundRejected(t *testing.T) {
	m, _, _ := buildManagedManager(t)
	_, err := m.Refund(context.Background(), nil)
	if err == nil || err.Error() != "cooperative refunds are client-initiated in facilitator-managed mode" {
		t.Fatalf("got %v", err)
	}
}

func TestChannelManager_ManagedRefundIdleRejected(t *testing.T) {
	m, _, _ := buildManagedManager(t)
	_, err := m.RefundIdleChannels(context.Background(), 60)
	if err == nil || err.Error() != "cooperative refunds are client-initiated in facilitator-managed mode" {
		t.Fatalf("got %v", err)
	}
}

func TestChannelManager_ManagedDoesNotStartRefundTimer(t *testing.T) {
	m, _, _ := buildManagedManager(t)
	m.Start(AutoSettlementConfig{ClaimIntervalSecs: 3600, SettleIntervalSecs: 3600, RefundIntervalSecs: 3600})
	defer func() { _ = m.Stop(context.Background(), nil) }()
	m.mu.Lock()
	_, hasRefund := m.timers[autoJobRefund]
	m.mu.Unlock()
	if hasRefund {
		t.Fatal("managed mode must not start a refund timer")
	}
}

const (
	networkBase    = x402.Network("eip155:8453")
	networkSepolia = x402.Network("eip155:84532")
)

// boundSession returns a claimable and refundable session whose channel id is
// bound to network. A false stamped drops the persisted Network, modelling a
// row written before sessions carried one.
func boundSession(t *testing.T, network x402.Network, salt int, stamped bool) *ChannelSession {
	t.Helper()
	cfg := batchsettlement.ChannelConfig{
		Payer:              "0xabc1000000000000000000000000000000000001",
		PayerAuthorizer:    "0xabc1000000000000000000000000000000000001",
		Receiver:           "0xabc2000000000000000000000000000000000002",
		ReceiverAuthorizer: "0xabc3000000000000000000000000000000000003",
		Token:              "0xabc4000000000000000000000000000000000004",
		WithdrawDelay:      900,
		Salt:               fmt.Sprintf("0x%064x", salt),
	}
	channelId, err := batchsettlement.ComputeChannelId(cfg, string(network))
	if err != nil {
		t.Fatalf("ComputeChannelId: %v", err)
	}
	sess := sampleSession(channelId, "1000")
	sess.ChannelConfig = cfg
	sess.Balance = "5000"
	sess.SignedMaxClaimable = "1000"
	sess.TotalClaimed = "100"
	sess.Network = ""
	if stamped {
		sess.Network = string(network)
	}
	return sess
}

// networkFixture shares one store between a Base and a Base Sepolia manager.
type networkFixture struct {
	scheme              *BatchSettlementEvmScheme
	base, sepolia       *ChannelSession
	baseFac, sepoliaFac *fakeFacilitator
	baseMgr, sepoliaMgr *BatchSettlementChannelManager
}

func newNetworkFixture(t *testing.T, stamped bool) *networkFixture {
	t.Helper()
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	fx := &networkFixture{
		scheme:     s,
		base:       boundSession(t, networkBase, 1, stamped),
		sepolia:    boundSession(t, networkSepolia, 2, stamped),
		baseFac:    &fakeFacilitator{},
		sepoliaFac: &fakeFacilitator{},
	}
	fx.baseMgr = newManagerOn(s, fx.baseFac, networkBase)
	fx.sepoliaMgr = newManagerOn(s, fx.sepoliaFac, networkSepolia)
	seedSession(t, s, fx.base.ChannelId, fx.base)
	seedSession(t, s, fx.sepolia.ChannelId, fx.sepolia)
	return fx
}

func requireTotalClaimed(t *testing.T, s *BatchSettlementEvmScheme, channelId, want string) {
	t.Helper()
	got, err := s.GetSession(channelId)
	if err != nil || got == nil {
		t.Fatalf("GetSession(%s): %v %+v", channelId, err, got)
	}
	if got.TotalClaimed != want {
		t.Fatalf("TotalClaimed = %s, want %s", got.TotalClaimed, want)
	}
}

func requireSessionPresent(t *testing.T, s *BatchSettlementEvmScheme, channelId string, want bool) {
	t.Helper()
	got, err := s.GetSession(channelId)
	if err != nil {
		t.Fatalf("GetSession(%s): %v", channelId, err)
	}
	if (got != nil) != want {
		t.Fatalf("session %s present = %v, want %v", channelId, got != nil, want)
	}
}

var networkScopeCases = []struct {
	name    string
	stamped bool
}{
	{"persisted network", true},
	{"legacy row without network", false},
}

func TestChannelManager_ClaimSelectsOnlyOwnNetwork(t *testing.T) {
	for _, tc := range networkScopeCases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newNetworkFixture(t, tc.stamped)

			for _, c := range []struct {
				mgr  *BatchSettlementChannelManager
				want *ChannelSession
			}{{fx.baseMgr, fx.base}, {fx.sepoliaMgr, fx.sepolia}} {
				claims, err := c.mgr.GetClaimableVouchers(nil)
				if err != nil {
					t.Fatalf("GetClaimableVouchers: %v", err)
				}
				if len(claims) != 1 || claims[0].Voucher.Channel.Salt != c.want.ChannelConfig.Salt {
					t.Fatalf("expected only the manager's own channel, got %+v", claims)
				}
			}

			results, err := fx.baseMgr.Claim(context.Background(), nil)
			if err != nil || len(results) != 1 || results[0].Vouchers != 1 {
				t.Fatalf("results=%+v err=%v", results, err)
			}
			if fx.baseFac.settleCalls != 1 || fx.sepoliaFac.settleCalls != 0 {
				t.Fatalf("settle calls base=%d sepolia=%d", fx.baseFac.settleCalls, fx.sepoliaFac.settleCalls)
			}
			requireTotalClaimed(t, fx.scheme, fx.base.ChannelId, "1000")
			requireTotalClaimed(t, fx.scheme, fx.sepolia.ChannelId, "100")

			results, err = fx.sepoliaMgr.Claim(context.Background(), nil)
			if err != nil || len(results) != 1 {
				t.Fatalf("results=%+v err=%v", results, err)
			}
			requireTotalClaimed(t, fx.scheme, fx.sepolia.ChannelId, "1000")
		})
	}
}

func TestChannelManager_ClaimSelectorReceivesOnlyOwnNetworkChannels(t *testing.T) {
	for _, tc := range networkScopeCases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newNetworkFixture(t, tc.stamped)

			var seen []*ChannelSession
			results, err := fx.baseMgr.Claim(context.Background(), &ClaimOptions{
				SelectClaimChannels: func(channels []*ChannelSession, _ AutoSettlementContext) ([]*ChannelSession, error) {
					seen = channels
					return channels, nil
				},
			})
			if err != nil || len(results) != 1 {
				t.Fatalf("results=%+v err=%v", results, err)
			}
			if len(seen) != 1 || seen[0].ChannelId != fx.base.ChannelId {
				t.Fatalf("selector saw %+v, want only %s", seen, fx.base.ChannelId)
			}
		})
	}
}

func TestChannelManager_WithdrawalPendingSessionsAreNetworkScoped(t *testing.T) {
	for _, tc := range networkScopeCases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newNetworkFixture(t, tc.stamped)
			for _, sess := range []*ChannelSession{fx.base, fx.sepolia} {
				sess.WithdrawRequestedAt = 12345
				seedSession(t, fx.scheme, sess.ChannelId, sess)
			}
			got, err := fx.baseMgr.GetWithdrawalPendingSessions()
			if err != nil {
				t.Fatalf("err: %v", err)
			}
			if len(got) != 1 || got[0].ChannelId != fx.base.ChannelId {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

func TestChannelManager_LegacyRowWithUnboundChannelIdIsExcluded(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sess := sampleSession(testChA, "1000")
	sess.Network = ""
	seedSession(t, s, testChA, sess)

	f := &fakeFacilitator{}
	m := newManager(s, f)
	claims, err := m.GetClaimableVouchers(nil)
	if err != nil || len(claims) != 0 {
		t.Fatalf("claims=%+v err=%v", claims, err)
	}
	if results, err := m.Claim(context.Background(), nil); err != nil || len(results) != 0 || f.settleCalls != 0 {
		t.Fatalf("results=%+v err=%v settleCalls=%d", results, err, f.settleCalls)
	}
}

func TestChannelManager_RefundSkipsForeignNetworkChannels(t *testing.T) {
	for _, tc := range networkScopeCases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newNetworkFixture(t, tc.stamped)

			res, err := fx.sepoliaMgr.Refund(context.Background(), []string{fx.base.ChannelId, fx.sepolia.ChannelId})
			if err != nil || len(res) != 1 || res[0].Channel != fx.sepolia.ChannelId {
				t.Fatalf("res=%+v err=%v", res, err)
			}
			if fx.baseFac.settleCalls != 0 {
				t.Fatalf("foreign channel reached the wrong network: base settle calls = %d", fx.baseFac.settleCalls)
			}
			requireSessionPresent(t, fx.scheme, fx.base.ChannelId, true)
			requireSessionPresent(t, fx.scheme, fx.sepolia.ChannelId, false)

			seedSession(t, fx.scheme, fx.sepolia.ChannelId, fx.sepolia)
			res, err = fx.baseMgr.Refund(context.Background(), nil)
			if err != nil || len(res) != 1 || res[0].Channel != fx.base.ChannelId {
				t.Fatalf("res=%+v err=%v", res, err)
			}
			if fx.sepoliaFac.settleCalls != 1 {
				t.Fatalf("sepolia settle calls = %d, want only its own earlier refund", fx.sepoliaFac.settleCalls)
			}
			requireSessionPresent(t, fx.scheme, fx.sepolia.ChannelId, true)
		})
	}
}

func TestChannelManager_IdleRefundSelectionIsNetworkScoped(t *testing.T) {
	for _, tc := range networkScopeCases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newNetworkFixture(t, tc.stamped)
			idle, err := fx.baseMgr.getIdleChannelsForRefund(context.Background(), 1)
			if err != nil {
				t.Fatalf("err: %v", err)
			}
			if len(idle) != 1 || idle[0].ChannelId != fx.base.ChannelId {
				t.Fatalf("got %+v", idle)
			}

			res, err := fx.baseMgr.RefundIdleChannels(context.Background(), 1)
			if err != nil || len(res) != 1 || res[0].Channel != fx.base.ChannelId {
				t.Fatalf("res=%+v err=%v", res, err)
			}
			if fx.sepoliaFac.settleCalls != 0 {
				t.Fatalf("sepolia settle calls = %d", fx.sepoliaFac.settleCalls)
			}
			requireSessionPresent(t, fx.scheme, fx.sepolia.ChannelId, true)
		})
	}
}

func TestRunRefundJob_SelectorOnlySeesOwnNetworkChannels(t *testing.T) {
	for _, tc := range networkScopeCases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newNetworkFixture(t, tc.stamped)
			var seen []*ChannelSession
			var refunds []RefundResult
			fx.baseMgr.autoSettleConfig = AutoSettlementConfig{
				SelectRefundChannels: func(channels []*ChannelSession, _ AutoSettlementContext) ([]*ChannelSession, error) {
					seen = channels
					// Also return the foreign channel: the manager must still not refund it.
					return append(append([]*ChannelSession{}, channels...), fx.sepolia), nil
				},
				OnRefund: func(r RefundResult) { refunds = append(refunds, r) },
			}
			fx.baseMgr.runRefundJob(context.Background())
			if len(seen) != 1 || seen[0].ChannelId != fx.base.ChannelId {
				t.Fatalf("selector saw %+v", seen)
			}
			if len(refunds) != 1 || refunds[0].Channel != fx.base.ChannelId {
				t.Fatalf("refunds = %+v", refunds)
			}
			if fx.baseFac.settleCalls != 1 || fx.sepoliaFac.settleCalls != 0 {
				t.Fatalf("settle calls base=%d sepolia=%d", fx.baseFac.settleCalls, fx.sepoliaFac.settleCalls)
			}
			requireSessionPresent(t, fx.scheme, fx.sepolia.ChannelId, true)
		})
	}
}

// failedBatchSalt returns the channel salt carried by the first claim payload,
// which identifies the channel whose batch the facilitator rejected.
func failedBatchSalt(t *testing.T, f *fakeFacilitator) string {
	t.Helper()
	if len(f.settlePayloads) == 0 {
		t.Fatal("no claim payload recorded")
	}
	claims, _ := f.settlePayloads[0]["claims"].([]interface{})
	if len(claims) != 1 {
		t.Fatalf("expected single-claim batch, got %+v", f.settlePayloads[0])
	}
	claim, _ := claims[0].(map[string]interface{})
	voucher, _ := claim["voucher"].(map[string]interface{})
	channel, _ := voucher["channel"].(map[string]interface{})
	salt, _ := channel["salt"].(string)
	return salt
}

// twoClaimableChannels seeds two Base channels so MaxClaimsPerBatch: 1 yields
// two claim batches.
func twoClaimableChannels(t *testing.T, f *fakeFacilitator) (*BatchSettlementEvmScheme, *BatchSettlementChannelManager, [2]*ChannelSession) {
	t.Helper()
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	sessions := [2]*ChannelSession{
		boundSession(t, networkBase, 1, true),
		boundSession(t, networkBase, 2, true),
	}
	for _, sess := range sessions {
		seedSession(t, s, sess.ChannelId, sess)
	}
	return s, newManager(s, f), sessions
}

func TestClaim_ContinuesAfterFailedBatch(t *testing.T) {
	boom := errors.New("boom")
	f := &fakeFacilitator{settleErrAt: map[int]error{1: boom}}
	s, m, sessions := twoClaimableChannels(t, f)

	results, err := m.Claim(context.Background(), &ClaimOptions{MaxClaimsPerBatch: 1})
	if !errors.Is(err, boom) {
		t.Fatalf("expected joined batch error, got %v", err)
	}
	if len(results) != 1 || f.settleCalls != 2 {
		t.Fatalf("results=%+v settleCalls=%d", results, f.settleCalls)
	}
	m.mu.Lock()
	pendingSettle := m.pendingSettle
	m.mu.Unlock()
	if !pendingSettle {
		t.Fatal("expected pendingSettle after a successful batch")
	}

	failedSalt := failedBatchSalt(t, f)
	for _, sess := range sessions {
		want := "1000"
		if sess.ChannelConfig.Salt == failedSalt {
			want = "100"
		}
		requireTotalClaimed(t, s, sess.ChannelId, want)
	}

	// The failed channel stays claimable and lands on the next pass.
	results, err = m.Claim(context.Background(), &ClaimOptions{MaxClaimsPerBatch: 1})
	if err != nil || len(results) != 1 {
		t.Fatalf("retry results=%+v err=%v", results, err)
	}
	for _, sess := range sessions {
		requireTotalClaimed(t, s, sess.ChannelId, "1000")
	}
}

func TestClaim_ReturnsEveryBatchError(t *testing.T) {
	first, second := errors.New("first"), errors.New("second")
	f := &fakeFacilitator{settleErrAt: map[int]error{1: first, 2: second}}
	s, m, sessions := twoClaimableChannels(t, f)

	results, err := m.Claim(context.Background(), &ClaimOptions{MaxClaimsPerBatch: 1})
	if !errors.Is(err, first) || !errors.Is(err, second) {
		t.Fatalf("expected both batch errors, got %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("results = %+v", results)
	}
	m.mu.Lock()
	pendingSettle := m.pendingSettle
	m.mu.Unlock()
	if pendingSettle {
		t.Fatal("pendingSettle must stay false when no batch succeeded")
	}
	for _, sess := range sessions {
		requireTotalClaimed(t, s, sess.ChannelId, "100")
	}
}

func TestClaimAndSettle_SettlesAfterPartialClaim(t *testing.T) {
	boom := errors.New("boom")
	f := &fakeFacilitator{settleErrAt: map[int]error{1: boom}}
	_, m, _ := twoClaimableChannels(t, f)

	claims, settle, err := m.ClaimAndSettle(context.Background(), &ClaimOptions{MaxClaimsPerBatch: 1})
	if !errors.Is(err, boom) {
		t.Fatalf("expected claim error, got %v", err)
	}
	if len(claims) != 1 || settle == nil || settle.Transaction != "0xtx" {
		t.Fatalf("claims=%+v settle=%+v", claims, settle)
	}
	if f.settleCalls != 3 || f.settlePayloads[2]["type"] != "settle" {
		t.Fatalf("expected two claim batches then settle, got %d calls", f.settleCalls)
	}
}

func TestClaimAndSettle_JoinsClaimAndSettleErrors(t *testing.T) {
	claimErr, settleErr := errors.New("claim failed"), errors.New("settle failed")
	f := &fakeFacilitator{settleErrAt: map[int]error{1: claimErr, 3: settleErr}}
	_, m, _ := twoClaimableChannels(t, f)

	claims, settle, err := m.ClaimAndSettle(context.Background(), &ClaimOptions{MaxClaimsPerBatch: 1})
	if !errors.Is(err, claimErr) || !errors.Is(err, settleErr) {
		t.Fatalf("expected both errors, got %v", err)
	}
	if len(claims) != 1 || settle != nil {
		t.Fatalf("claims=%+v settle=%+v", claims, settle)
	}
}

func TestRunClaimJob_ReportsFailedBatchAndKeepsSuccessfulClaims(t *testing.T) {
	boom := errors.New("boom")
	f := &fakeFacilitator{settleErrAt: map[int]error{1: boom}}
	_, m, _ := twoClaimableChannels(t, f)
	var errs []error
	var claims []ClaimResult
	m.autoSettleConfig = AutoSettlementConfig{
		MaxClaimsPerBatch: 1,
		OnError:           func(err error) { errs = append(errs, err) },
		OnClaim:           func(r ClaimResult) { claims = append(claims, r) },
	}

	m.runClaimJob(context.Background())
	if len(errs) != 1 || !errors.Is(errs[0], boom) {
		t.Fatalf("errs = %v", errs)
	}
	if len(claims) != 1 {
		t.Fatalf("OnClaim calls = %d", len(claims))
	}
	m.mu.Lock()
	lastClaimTime := m.lastClaimTime
	m.mu.Unlock()
	if lastClaimTime == 0 {
		t.Fatal("expected lastClaimTime to advance after a successful batch")
	}
}

func TestRunClaimJob_AllBatchesFailKeepsLastClaimTime(t *testing.T) {
	f := &fakeFacilitator{settleErr: errors.New("boom")}
	_, m, _ := twoClaimableChannels(t, f)
	var errs []error
	var claims []ClaimResult
	m.autoSettleConfig = AutoSettlementConfig{
		MaxClaimsPerBatch: 1,
		OnError:           func(err error) { errs = append(errs, err) },
		OnClaim:           func(r ClaimResult) { claims = append(claims, r) },
	}

	m.runClaimJob(context.Background())
	if len(errs) != 1 || len(claims) != 0 {
		t.Fatalf("errs=%v claims=%+v", errs, claims)
	}
	m.mu.Lock()
	lastClaimTime := m.lastClaimTime
	m.mu.Unlock()
	if lastClaimTime != 0 {
		t.Fatalf("lastClaimTime = %d, want unchanged", lastClaimTime)
	}
}

// chainFacilitator tracks claimed and settled totals like the contract's
// `receivers(receiver, token)`: claims (alone or inside a refund) add to the
// claimed total, and settle fails with ErrNothingToSettle unless something is
// claimed but not yet settled. Assumes each channel is claimed once, from zero.
type chainFacilitator struct {
	fakeFacilitator
	claimed int64
	settled int64
	// nothingToSettleAsError mimics HTTPFacilitatorClient, which returns a
	// *x402.SettleError when the facilitator replies with a non-2xx status.
	nothingToSettleAsError bool
	payloadTypes           []string
}

func (f *chainFacilitator) Settle(_ context.Context, payloadBytes []byte, _ []byte) (*x402.SettleResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var env struct {
		Payload struct {
			Type   string `json:"type"`
			Claims []struct {
				TotalClaimed string `json:"totalClaimed"`
			} `json:"claims"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(payloadBytes, &env); err != nil {
		return nil, err
	}
	f.payloadTypes = append(f.payloadTypes, env.Payload.Type)
	network := x402.Network("eip155:8453")
	if env.Payload.Type == "settle" {
		if f.claimed <= f.settled {
			if f.nothingToSettleAsError {
				return nil, x402.NewSettleError(facilitator.ErrNothingToSettle, "", network, "", "facilitator returned 400")
			}
			return &x402.SettleResponse{
				Success:      false,
				ErrorReason:  facilitator.ErrNothingToSettle,
				ErrorMessage: "nothing to settle for receiver and token",
				Network:      network,
			}, nil
		}
		f.settled = f.claimed
		return &x402.SettleResponse{Success: true, Transaction: "0xsettle", Network: network}, nil
	}
	for _, c := range env.Payload.Claims {
		amount, ok := new(big.Int).SetString(c.TotalClaimed, 10)
		if !ok {
			return nil, errors.New("bad totalClaimed")
		}
		f.claimed += amount.Int64()
	}
	return &x402.SettleResponse{Success: true, Transaction: "0x" + env.Payload.Type, Network: network}, nil
}

func newChainManager(s *BatchSettlementEvmScheme, f *chainFacilitator) *BatchSettlementChannelManager {
	return NewBatchSettlementChannelManager(ChannelManagerConfig{
		Scheme:      s,
		Facilitator: f,
		Receiver:    "0xreceiver",
		Token:       "0xtoken",
		Network:     x402.Network("eip155:8453"),
	})
}

// storeChargedSession stores a channel with 3000 charged but unclaimed and
// refundable balance left over.
func storeChargedSession(t *testing.T, s *BatchSettlementEvmScheme) {
	t.Helper()
	sess := sampleSession(testChA, "3000")
	sess.Balance = "10000"
	sess.SignedMaxClaimable = "3000"
	sess.TotalClaimed = "0"
	seedSession(t, s, testChA, sess)
}

// autoSettleRecorder collects OnSettle and OnError callbacks.
type autoSettleRecorder struct {
	settles []SettleResult
	errs    []error
}

func (r *autoSettleRecorder) config() AutoSettlementConfig {
	return AutoSettlementConfig{
		OnSettle: func(res SettleResult) { r.settles = append(r.settles, res) },
		OnError:  func(err error) { r.errs = append(r.errs, err) },
	}
}

func TestSettle_NothingToSettleReturnsEmptyTransaction(t *testing.T) {
	m := newChainManager(NewBatchSettlementEvmScheme("0xreceiver", nil), &chainFacilitator{})
	res, err := m.Settle(context.Background())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || res.Transaction != "" {
		t.Fatalf("expected empty transaction, got %+v", res)
	}
}

func TestRunSettleJob_SettlesClaimsSubmittedByRefund(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	storeChargedSession(t, s)
	f := &chainFacilitator{}
	m := newChainManager(s, f)

	if _, err := m.Refund(context.Background(), nil); err != nil {
		t.Fatalf("refund: %v", err)
	}

	rec := &autoSettleRecorder{}
	m.autoSettleConfig = rec.config()
	for i := 0; i < 3; i++ {
		m.runSettleJob(context.Background())
	}

	if len(rec.settles) != 1 || rec.settles[0].Transaction != "0xsettle" {
		t.Fatalf("expected one OnSettle with 0xsettle, got %+v", rec.settles)
	}
	if len(rec.errs) != 0 {
		t.Fatalf("expected no OnError, got %v", rec.errs)
	}
	want := []string{"refund", "settle", "settle", "settle"}
	if !reflect.DeepEqual(f.payloadTypes, want) {
		t.Fatalf("payload types = %v, want %v", f.payloadTypes, want)
	}
	if f.settled != 3000 {
		t.Fatalf("settled = %d, want 3000", f.settled)
	}
}

func TestRunSettleJob_SettlesClaimsLeftByPreviousProcess(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	storeChargedSession(t, s)
	f := &chainFacilitator{}

	// Claims, then stops before its settle timer fires.
	if _, err := newChainManager(s, f).Claim(context.Background(), nil); err != nil {
		t.Fatalf("claim: %v", err)
	}

	m := newChainManager(s, f)
	rec := &autoSettleRecorder{}
	m.autoSettleConfig = rec.config()
	m.runSettleJob(context.Background())

	if len(rec.settles) != 1 || rec.settles[0].Transaction != "0xsettle" {
		t.Fatalf("expected one OnSettle with 0xsettle, got %+v", rec.settles)
	}
	if len(rec.errs) != 0 {
		t.Fatalf("expected no OnError, got %v", rec.errs)
	}
	if f.settled != 3000 {
		t.Fatalf("settled = %d, want 3000", f.settled)
	}
}

func TestStop_FlushSettlesClaimsSubmittedByRefund(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	storeChargedSession(t, s)
	f := &chainFacilitator{}
	m := newChainManager(s, f)

	if _, err := m.Refund(context.Background(), nil); err != nil {
		t.Fatalf("refund: %v", err)
	}
	m.Start(AutoSettlementConfig{ClaimIntervalSecs: 3600, SettleIntervalSecs: 3600})
	if err := m.Stop(context.Background(), &StopOptions{Flush: true}); err != nil {
		t.Fatalf("stop: %v", err)
	}

	want := []string{"refund", "settle"}
	if !reflect.DeepEqual(f.payloadTypes, want) {
		t.Fatalf("payload types = %v, want %v", f.payloadTypes, want)
	}
	if f.settled != 3000 {
		t.Fatalf("settled = %d, want 3000", f.settled)
	}
}

func TestSettle_NothingToSettleSettleErrorIsNoOp(t *testing.T) {
	f := &chainFacilitator{nothingToSettleAsError: true}
	m := newChainManager(NewBatchSettlementEvmScheme("0xreceiver", nil), f)

	res, err := m.Settle(context.Background())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || res.Transaction != "" {
		t.Fatalf("expected empty transaction, got %+v", res)
	}

	rec := &autoSettleRecorder{}
	m.autoSettleConfig = rec.config()
	m.runSettleJob(context.Background())
	if len(rec.settles) != 0 || len(rec.errs) != 0 {
		t.Fatalf("expected no callbacks, got settles=%+v errs=%v", rec.settles, rec.errs)
	}
	m.mu.Lock()
	lastSettleTime := m.lastSettleTime
	m.mu.Unlock()
	if lastSettleTime != 0 {
		t.Fatalf("expected lastSettleTime unchanged, got %d", lastSettleTime)
	}
}
