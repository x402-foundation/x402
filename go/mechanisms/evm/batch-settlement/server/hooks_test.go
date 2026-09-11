package server

import (
	"context"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/crypto"

	x402 "github.com/x402-foundation/x402/go/v2"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	bsclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/client"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/facilitator"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
	"github.com/x402-foundation/x402/go/v2/types"
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
	payTo   string
	extra   map[string]interface{}
}

func (s stubRequirements) GetScheme() string                { return s.scheme }
func (s stubRequirements) GetNetwork() string               { return s.network }
func (s stubRequirements) GetAsset() string                 { return s.asset }
func (s stubRequirements) GetAmount() string                { return s.amount }
func (s stubRequirements) GetPayTo() string                 { return s.payTo }
func (s stubRequirements) GetMaxTimeoutSeconds() int        { return 60 }
func (s stubRequirements) GetExtra() map[string]interface{} { return s.extra }

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

func testChannelId(t *testing.T) string {
	t.Helper()
	id, err := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func validVerifyResult() *x402.VerifyResponse {
	return &x402.VerifyResponse{
		IsValid: true, Payer: "0xpayer",
		Extra: map[string]interface{}{"balance": "1000", "totalClaimed": "0"},
	}
}

func runBeforeVerify(t *testing.T, s *BatchSettlementEvmScheme, payload x402.PaymentPayloadView) *x402.BeforeHookResult {
	t.Helper()
	res, err := s.BeforeVerifyHook()(x402.VerifyContext{Payload: payload, Requirements: batchedReqs()})
	if err != nil {
		t.Fatalf("BeforeVerify err: %v", err)
	}
	return res
}

func runAfterVerify(t *testing.T, s *BatchSettlementEvmScheme, payload x402.PaymentPayloadView, result *x402.VerifyResponse) *x402.AfterVerifyResult {
	t.Helper()
	res, err := s.AfterVerifyHook()(x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{Payload: payload, Requirements: batchedReqs()},
		Result:        result,
	})
	if err != nil {
		t.Fatalf("AfterVerify err: %v", err)
	}
	return res
}

func mustAcquire(t *testing.T, s *BatchSettlementEvmScheme, id, pendingId string) {
	t.Helper()
	ok, err := s.GetLockStorage().Acquire(id, pendingId, 600_000)
	if err != nil || !ok {
		t.Fatalf("Acquire: ok=%v err=%v", ok, err)
	}
}

func lockHeld(t *testing.T, s *BatchSettlementEvmScheme, id, pendingId string) bool {
	t.Helper()
	held, err := s.GetLockStorage().IsHeld(id, pendingId)
	if err != nil {
		t.Fatalf("IsHeld: %v", err)
	}
	return held
}

type throwingLockStorage struct{}

func (throwingLockStorage) Acquire(string, string, int64) (bool, error) {
	return false, errors.New("lock down")
}
func (throwingLockStorage) Release(string, string) error {
	return errors.New("lock down")
}
func (throwingLockStorage) IsHeld(string, string) (bool, error) {
	return false, errors.New("lock down")
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
	// AfterVerify can rebuild the session. BeforeVerify performs no write.
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := testChannelId(t)
	res := runBeforeVerify(t, s, &stubPayload{data: refundPayload(id, "0", "0xsig")})
	if res != nil {
		t.Fatalf("expected pass-through, got %+v", res)
	}
}

func TestBeforeVerifyHook_NoSessionNonRefundPasses(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := testChannelId(t)
	res := runBeforeVerify(t, s, &stubPayload{data: voucherPayload(id, "10", "0xsig")})
	if res != nil {
		t.Fatalf("expected pass-through, got %+v", res)
	}
}

func TestBeforeVerifyHook_StaleCumulativeAborts(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := testChannelId(t)
	sess := sampleSession(id, "10")
	_ = s.UpdateSession(id, sess)
	res := runBeforeVerify(t, s, &stubPayload{data: voucherPayload(id, "999", "0xsig")})
	if res == nil || !res.Abort || res.Reason != batchsettlement.ErrCumulativeAmountMismatch {
		t.Fatalf("got %+v", res)
	}
}

func TestBeforeVerifyHook_StaleCumulativeCapturesSnapshot(t *testing.T) {
	// When the payload is a real *types.PaymentPayload (not a stub), aborting
	// must also stash the current session as a snapshot so the resource server
	// can echo ChannelState in the corrective 402.
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := testChannelId(t)
	sess := sampleSession(id, "10")
	_ = s.UpdateSession(id, sess)

	pp := &types.PaymentPayload{
		X402Version: 2,
		Payload:     voucherPayload(id, "999", "0xsig"),
		Accepted:    types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"},
	}
	res := runBeforeVerify(t, s, pp)
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
	id := testChannelId(t)
	sess := sampleSession(id, "10")
	_ = s.UpdateSession(id, sess)
	// expected = 10 + 10 (req amount) = 20
	res := runBeforeVerify(t, s, &stubPayload{data: voucherPayload(id, "20", "0xsig")})
	if res != nil {
		t.Fatalf("expected pass-through, got %+v", res)
	}
}

// TestBeforeVerifyHook_LocalVerifyRejectsOverEscrow pins that a voucher whose
// cumulative maxClaimable exceeds the cached (real) escrow balance is not
// locally approved. With an inflated cached balance (e.g. SettleDeposit
// double-count), the same voucher would incorrectly pass the local fast path.
func TestBeforeVerifyHook_LocalVerifyRejectsOverEscrow(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	voucherSigner, err := evmsigners.NewClientSignerFromPrivateKey(hex.EncodeToString(crypto.FromECDSA(priv)))
	if err != nil {
		t.Fatalf("client signer: %v", err)
	}
	payerAuthorizer := voucherSigner.Address()

	cfg := testConfig()
	cfg.PayerAuthorizer = payerAuthorizer
	channelId, err := batchsettlement.ComputeChannelId(cfg, "eip155:8453")
	if err != nil {
		t.Fatalf("compute channel id: %v", err)
	}

	// charged=100, reqAmount=10 → expected maxClaimable=110 > Balance=100.
	const maxClaimable = "110"
	voucher, err := bsclient.SignVoucher(context.Background(), voucherSigner, channelId, maxClaimable, "eip155:8453")
	if err != nil {
		t.Fatalf("sign voucher: %v", err)
	}

	s := NewBatchSettlementEvmScheme(cfg.Receiver, nil)
	sess := sampleSession(channelId, "100")
	sess.ChannelConfig = cfg
	sess.Balance = "100"
	sess.TotalClaimed = "0"
	sess.OnchainSyncedAt = time.Now().UnixMilli()
	_ = s.UpdateSession(channelId, sess)

	reqs := stubRequirements{
		scheme:  batchsettlement.SchemeBatched,
		network: "eip155:8453",
		asset:   cfg.Token,
		amount:  "10",
		payTo:   cfg.Receiver,
		extra: map[string]interface{}{
			"receiverAuthorizer": cfg.ReceiverAuthorizer,
		},
	}
	payload := map[string]interface{}{
		"type":          "voucher",
		"channelConfig": batchsettlement.ChannelConfigToMap(cfg),
		"voucher": map[string]interface{}{
			"channelId":          channelId,
			"maxClaimableAmount": maxClaimable,
			"signature":          voucher.Signature,
		},
	}

	res, err := s.BeforeVerifyHook()(x402.VerifyContext{
		Payload:      &stubPayload{data: payload},
		Requirements: reqs,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Skip || res.SkipVerifyResult == nil {
		t.Fatalf("expected local verify skip result, got %+v", res)
	}
	if res.SkipVerifyResult.IsValid {
		t.Fatal("expected local verify to reject over-escrow voucher")
	}
	if res.SkipVerifyResult.InvalidReason != facilitator.ErrMaxClaimableExceedsBal {
		t.Fatalf("InvalidReason = %q, want %q", res.SkipVerifyResult.InvalidReason, facilitator.ErrMaxClaimableExceedsBal)
	}
}

func TestBeforeVerifyHook_RefundFreshCumulativePasses(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := testChannelId(t)
	sess := sampleSession(id, "10")
	_ = s.UpdateSession(id, sess)
	// Refund: expected = prevCharged (10), no req amount added.
	res := runBeforeVerify(t, s, &stubPayload{data: refundPayload(id, "10", "0xsig")})
	if res != nil {
		t.Fatalf("expected pass-through, got %+v", res)
	}
}

func TestBeforeVerifyHook_LivePendingPassesThrough(t *testing.T) {
	// BeforeVerify is read-only — a live admission lock must not abort here.
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := testChannelId(t)
	sess := sampleSession(id, "10")
	_ = s.UpdateSession(id, sess)
	mustAcquire(t, s, id, "p-live")

	res := runBeforeVerify(t, s, &stubPayload{data: voucherPayload(id, "20", "0xsig")})
	if res != nil {
		t.Fatalf("expected pass-through, got %+v", res)
	}
}

func TestBeforeVerifyHook_NonCanonicalChannelIdAborts(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	res := runBeforeVerify(t, s, &stubPayload{data: voucherPayload("0xabcd", "10", "0xsig")})
	if res == nil || !res.Abort || res.Reason != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("got %+v", res)
	}
	list, err := s.storage.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("expected no storage mutation, got %d sessions", len(list))
	}
}

func TestBeforeVerifyHook_ChannelIdMismatchAborts(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	res := runBeforeVerify(t, s, &stubPayload{data: voucherPayload(testChA, "10", "0xsig")})
	if res == nil || !res.Abort || res.Reason != batchsettlement.ErrChannelIdMismatch {
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
			Payload:      &stubPayload{data: voucherPayload(testChannelId(t), "10", "0xsig")},
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
	id := testChannelId(t)
	stub := &stubPayload{data: voucherPayload(id, "10", "0xsig")}
	_ = runBeforeVerify(t, s, stub)
	res := runAfterVerify(t, s, stub, &x402.VerifyResponse{IsValid: false})
	if res != nil {
		t.Fatalf("expected pass-through, got %+v", res)
	}
	got, _ := s.GetSession(id)
	if got != nil {
		t.Fatalf("invalid result must not mutate storage: %+v", got)
	}
}

func TestAfterVerifyHook_WithoutBeforeVerifyContextAborts(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := testChannelId(t)
	res := runAfterVerify(t, s, &stubPayload{data: voucherPayload(id, "10", "0xsig")}, validVerifyResult())
	if res == nil || !res.Abort || res.Reason != batchsettlement.ErrVerificationStateUnavailable {
		t.Fatalf("got %+v", res)
	}
}

func TestAfterVerifyHook_LivePendingRejectsSameChannel(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := testChannelId(t)
	sess := sampleSession(id, "10")
	_ = s.UpdateSession(id, sess)
	mustAcquire(t, s, id, "p-live")

	stub := &stubPayload{data: voucherPayload(id, "20", "0xsig")}
	if res := runBeforeVerify(t, s, stub); res != nil {
		t.Fatalf("BeforeVerify: %+v", res)
	}
	res := runAfterVerify(t, s, stub, validVerifyResult())
	if res == nil || !res.Abort || res.Reason != batchsettlement.ErrChannelBusy {
		t.Fatalf("got %+v", res)
	}
}

func TestAfterVerifyHook_ReplacesExpiredAdmissionLock(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := testChannelId(t)
	_ = s.UpdateSession(id, sampleSession(id, "10"))
	ok, err := s.GetLockStorage().Acquire(id, "expired", 1)
	if err != nil || !ok {
		t.Fatalf("Acquire: ok=%v err=%v", ok, err)
	}
	time.Sleep(5 * time.Millisecond)

	stub := &stubPayload{data: voucherPayload(id, "20", "0xsig")}
	if res := runBeforeVerify(t, s, stub); res != nil {
		t.Fatalf("BeforeVerify: %+v", res)
	}
	res := runAfterVerify(t, s, stub, validVerifyResult())
	if res != nil {
		t.Fatalf("got %+v", res)
	}
	if lockHeld(t, s, id, "expired") {
		t.Fatal("expired lock should have been replaced")
	}
	if !lockHeld(t, s, id, "") {
		t.Fatal("expected a live admission lock")
	}
}

func TestAfterVerifyHook_VoucherStoresSession(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := testChannelId(t)
	stub := &stubPayload{data: voucherPayload(id, "10", "0xsig")}
	if res := runBeforeVerify(t, s, stub); res != nil {
		t.Fatalf("BeforeVerify: %+v", res)
	}
	res := runAfterVerify(t, s, stub, validVerifyResult())
	if res != nil {
		t.Fatalf("got res=%+v", res)
	}
	got, _ := s.GetSession(id)
	if got != nil {
		t.Fatalf("after-verify must not persist a channel row: %+v", got)
	}
	if !lockHeld(t, s, id, "") {
		t.Fatal("expected admission lock after AfterVerify")
	}
	rc := s.ReadRequestContext(stub)
	if rc == nil || rc.ChannelSnapshot == nil || rc.ChannelSnapshot.Balance != "1000" {
		t.Fatalf("snapshot = %+v", rc)
	}
}

func TestAfterVerifyHook_DepositStoresSession(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := testChannelId(t)
	stub := &stubPayload{data: depositPayloadFor(id, "100", "0xsig")}
	if res := runBeforeVerify(t, s, stub); res != nil {
		t.Fatalf("BeforeVerify: %+v", res)
	}
	if res := runAfterVerify(t, s, stub, validVerifyResult()); res != nil {
		t.Fatalf("AfterVerify: %+v", res)
	}
	got, _ := s.GetSession(id)
	if got != nil {
		t.Fatalf("after-verify must not persist a channel row: %+v", got)
	}
	if !lockHeld(t, s, id, "") {
		t.Fatal("expected admission lock after AfterVerify")
	}
	rc := s.ReadRequestContext(stub)
	if rc == nil || rc.ChannelSnapshot == nil || rc.ChannelSnapshot.SignedMaxClaimable != "100" {
		t.Fatalf("snapshot = %+v", rc)
	}
}

func TestAfterVerifyHook_RefundReturnsSkipHandler(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := testChannelId(t)
	stub := &stubPayload{data: refundPayload(id, "0", "0xsig")}
	if res := runBeforeVerify(t, s, stub); res != nil {
		t.Fatalf("BeforeVerify: %+v", res)
	}
	res := runAfterVerify(t, s, stub, validVerifyResult())
	if res == nil || !res.SkipHandler || res.Response == nil {
		t.Fatalf("got %+v", res)
	}
}

func TestOnVerifyFailureHook_ClearsPendingRequest(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := testChannelId(t)
	sess := sampleSession(id, "10")
	_ = s.UpdateSession(id, sess)
	mustAcquire(t, s, id, "p-verify")
	stub := &stubPayload{data: voucherPayload(id, "20", "0xsig")}
	s.MergeRequestContext(stub, BatchSettlementRequestContext{
		ChannelId:            id,
		PendingId:            "p-verify",
		ChannelSnapshot:      sess,
		ReservationCommitted: true,
	})

	res, err := s.OnVerifyFailureHook()(x402.VerifyFailureContext{
		VerifyContext: x402.VerifyContext{Payload: stub, Requirements: batchedReqs()},
	})
	if err != nil || res != nil {
		t.Fatalf("got res=%+v err=%v", res, err)
	}
	got, _ := s.GetSession(id)
	if got == nil {
		t.Fatal("expected durable row to remain")
	}
	if lockHeld(t, s, id, "") {
		t.Fatal("admission lock not released")
	}
}

func TestOnVerifiedPaymentCanceled_AfterVerifyAbortedClearsPending(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := testChannelId(t)
	stub := &stubPayload{data: voucherPayload(id, "10", "0xsig")}
	if res := runBeforeVerify(t, s, stub); res != nil {
		t.Fatalf("BeforeVerify: %+v", res)
	}
	if res := runAfterVerify(t, s, stub, validVerifyResult()); res != nil {
		t.Fatalf("AfterVerify: %+v", res)
	}
	if !lockHeld(t, s, id, "") {
		t.Fatal("expected committed admission lock")
	}

	err := s.OnVerifiedPaymentCanceledHook()(x402.VerifiedPaymentCanceledContext{
		SettleContext: x402.SettleContext{Payload: stub, Requirements: batchedReqs()},
		Reason:        x402.CancellationReasonAfterVerifyAborted,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if lockHeld(t, s, id, "") {
		t.Fatal("admission lock not released")
	}
}

// ----- BeforeSettleHook -----

// TestBeforeSettleHook_DepositPassThrough pins the new BeforeSettleHook
// behavior for deposits: pass through to the facilitator with no payload
// mutation. Server-owned deposit enrichment lives in EnrichSettlementResponse
// (which adds chargedCumulativeAmount + chargedAmount additively post-settle).
func TestBeforeSettleHook_DepositPassThrough(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := testChannelId(t)
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
	id := testChannelId(t)
	res, err := s.BeforeSettleHook()(x402.SettleContext{
		Payload:      &stubPayload{data: voucherPayload(id, "10", "0xsig")},
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
	id := testChannelId(t)
	_ = s.UpdateSession(id, sampleSession(id, "10"))
	stub := &stubPayload{data: voucherPayload(id, "20", "0xsig")}
	if res := runBeforeVerify(t, s, stub); res != nil {
		t.Fatalf("BeforeVerify: %+v", res)
	}
	if res := runAfterVerify(t, s, stub, validVerifyResult()); res != nil {
		t.Fatalf("AfterVerify: %+v", res)
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
	got, _ := s.GetSession(id)
	if got == nil || got.ChargedCumulativeAmount != "20" {
		t.Fatalf("session not updated: %+v", got)
	}
}

func TestBeforeSettleHook_VoucherExceedsSignedCapAborts(t *testing.T) {
	// Simulate chargedCumulativeAmount changing after reservation.
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := testChannelId(t)
	_ = s.UpdateSession(id, sampleSession(id, "10"))
	stub := &stubPayload{data: voucherPayload(id, "20", "0xsig")}
	if res := runBeforeVerify(t, s, stub); res != nil {
		t.Fatalf("BeforeVerify: %+v", res)
	}
	if res := runAfterVerify(t, s, stub, validVerifyResult()); res != nil {
		t.Fatalf("AfterVerify: %+v", res)
	}
	cur, _ := s.GetSession(id)
	if cur == nil {
		t.Fatal("expected session after store")
	}
	cur.ChargedCumulativeAmount = "15"
	_ = s.UpdateSession(id, cur)
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
	if lockHeld(t, s, id, "") {
		t.Fatal("admission lock not released after cap abort")
	}
}

func TestBeforeSettleHook_UpsertsFirstSeenChannelAtSettle(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id := testChannelId(t)
	stub := &stubPayload{data: voucherPayload(id, "10", "0xsig")}
	if res := runBeforeVerify(t, s, stub); res != nil {
		t.Fatalf("BeforeVerify: %+v", res)
	}
	if res := runAfterVerify(t, s, stub, validVerifyResult()); res != nil {
		t.Fatalf("AfterVerify: %+v", res)
	}
	got, _ := s.GetSession(id)
	if got != nil {
		t.Fatalf("expected no durable row after verify: %+v", got)
	}

	res, err := s.BeforeSettleHook()(x402.SettleContext{
		Payload:      stub,
		Requirements: batchedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Skip {
		t.Fatalf("got %+v", res)
	}
	created, _ := s.GetSession(id)
	if created == nil || created.ChargedCumulativeAmount != "10" || created.Balance != "1000" {
		t.Fatalf("session = %+v", created)
	}
	if created.OnchainSyncedAt == 0 {
		t.Fatal("expected onchainSyncedAt at settle")
	}
	if lockHeld(t, s, id, "") {
		t.Fatal("admission lock not released")
	}
}

func TestBeforeSettleHook_OptimisticLockStoreOneChargeWins(t *testing.T) {
	storage := NewInMemoryChannelStorage()
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{
		Storage:     storage,
		LockStorage: throwingLockStorage{},
	})
	id := testChannelId(t)
	_ = s.UpdateSession(id, sampleSession(id, "0"))

	first := &stubPayload{data: voucherPayload(id, "10", "0xsig")}
	second := &stubPayload{data: voucherPayload(id, "10", "0xsig")}
	if res := runBeforeVerify(t, s, first); res != nil {
		t.Fatalf("BeforeVerify first: %+v", res)
	}
	if res := runBeforeVerify(t, s, second); res != nil {
		t.Fatalf("BeforeVerify second: %+v", res)
	}
	if res := runAfterVerify(t, s, first, validVerifyResult()); res != nil {
		t.Fatalf("AfterVerify first: %+v", res)
	}
	if res := runAfterVerify(t, s, second, validVerifyResult()); res != nil {
		t.Fatalf("AfterVerify second: %+v", res)
	}

	type settleOut struct {
		res *x402.BeforeHookResult
		err error
	}
	ch := make(chan settleOut, 2)
	go func() {
		res, err := s.BeforeSettleHook()(x402.SettleContext{Payload: first, Requirements: batchedReqs()})
		ch <- settleOut{res, err}
	}()
	go func() {
		res, err := s.BeforeSettleHook()(x402.SettleContext{Payload: second, Requirements: batchedReqs()})
		ch <- settleOut{res, err}
	}()
	a, b := <-ch, <-ch
	if a.err != nil || b.err != nil {
		t.Fatalf("err a=%v b=%v", a.err, b.err)
	}
	skips, aborts := 0, 0
	for _, out := range []settleOut{a, b} {
		if out.res != nil && out.res.Skip {
			skips++
		}
		if out.res != nil && out.res.Abort {
			aborts++
		}
	}
	if skips != 1 || aborts != 1 {
		t.Fatalf("expected 1 skip and 1 abort, got skips=%d aborts=%d a=%+v b=%+v", skips, aborts, a.res, b.res)
	}
	got, _ := storage.Get(id)
	if got == nil || got.ChargedCumulativeAmount != "10" {
		t.Fatalf("charged = %+v", got)
	}
}

func TestClearPendingRequest_IgnoresLockStoreErrors(t *testing.T) {
	inner := NewInMemoryChannelStorage()
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{
		Storage:     inner,
		LockStorage: throwingLockStorage{},
	})
	id := testChannelId(t)
	stub := &stubPayload{data: voucherPayload(id, "10", "0xsig")}
	s.MergeRequestContext(stub, BatchSettlementRequestContext{
		ChannelId:            id,
		PendingId:            "p1",
		ReservationCommitted: true,
	})
	if err := s.ClearPendingRequest(stub); err != nil {
		t.Fatalf("err: %v", err)
	}
	rc := s.ReadRequestContext(stub)
	if rc == nil || rc.ReservationCommitted {
		t.Fatalf("expected reservationCommitted=false, got %+v", rc)
	}
}

func TestAfterVerifyHook_ContinuesWhenLockAcquireThrows(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{
		LockStorage: throwingLockStorage{},
	})
	id := testChannelId(t)
	stub := &stubPayload{data: voucherPayload(id, "10", "0xsig")}
	if res := runBeforeVerify(t, s, stub); res != nil {
		t.Fatalf("BeforeVerify: %+v", res)
	}
	res := runAfterVerify(t, s, stub, validVerifyResult())
	if res != nil {
		t.Fatalf("got %+v", res)
	}
	got, _ := s.GetSession(id)
	if got != nil {
		t.Fatalf("expected no durable row: %+v", got)
	}
}

// reserveRefundPending acquires an admission lock and stamps voucher fields so
// EnrichSettlementPayload's holder check and signature match pass.
func reserveRefundPending(t *testing.T, s *BatchSettlementEvmScheme, id, pendingId, signedMax, sig string) {
	t.Helper()
	sess, _ := s.GetSession(id)
	if sess == nil {
		t.Fatalf("expected session for %s", id)
	}
	sess.SignedMaxClaimable = signedMax
	sess.Signature = sig
	_ = s.UpdateSession(id, sess)
	mustAcquire(t, s, id, pendingId)
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
	id := testChannelId(t)
	sess := sampleSession(id, "10")
	_ = s.UpdateSession(id, sess)
	mustAcquire(t, s, id, "p-settle")
	stub := &stubPayload{data: voucherPayload(id, "20", "0xsig")}
	s.MergeRequestContext(stub, BatchSettlementRequestContext{
		ChannelId:            id,
		PendingId:            "p-settle",
		ChannelSnapshot:      sess,
		ReservationCommitted: true,
	})

	res, err := s.OnSettleFailureHook()(x402.SettleFailureContext{
		SettleContext: x402.SettleContext{Payload: stub, Requirements: batchedReqs()},
	})
	if err != nil || res != nil {
		t.Fatalf("got res=%+v err=%v", res, err)
	}
	if lockHeld(t, s, id, "") {
		t.Fatal("admission lock not released")
	}
}

// ----- AfterSettleHook -----

func TestAfterSettleHook_NonBatchedIgnored(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	req := batchedReqs()
	req.scheme = "exact"
	err := s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      &stubPayload{data: depositPayloadFor(testChannelId(t), "100", "0xsig")},
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
			Payload:      &stubPayload{data: depositPayloadFor(testChannelId(t), "100", "0xsig")},
			Requirements: batchedReqs(),
		},
		Result: &x402.SettleResponse{Success: false},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
}

// reserveDepositPending acquires an admission lock so AfterSettleHook's
// holder check treats this request as the lock owner.
func reserveDepositPending(t *testing.T, s *BatchSettlementEvmScheme, id, pendingId string) {
	t.Helper()
	mustAcquire(t, s, id, pendingId)
}

func TestAfterSettleHook_DepositUpdatesBalance(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	_ = s.UpdateSession(id, sampleSession(id, "0"))
	reserveDepositPending(t, s, id, "p-deposit")
	payload := depositPayloadFor(id, "100", "0xsig")
	stub := &stubPayload{data: payload}
	s.MergeRequestContext(stub, BatchSettlementRequestContext{
		ChannelId:            id,
		PendingId:            "p-deposit",
		ReservationCommitted: true,
	})
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
// release the admission lock. Otherwise the next voucher hits the 5s pending-TTL
// guard in AfterVerifyHook and 402's with `invalid_batch_settlement_evm_channel_busy`.
func TestAfterSettleHook_DepositClearsPendingRequest(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	_ = s.UpdateSession(id, sampleSession(id, "0"))
	reserveDepositPending(t, s, id, "p-deposit")
	payload := depositPayloadFor(id, "100", "0xsig")
	stub := &stubPayload{data: payload}
	s.MergeRequestContext(stub, BatchSettlementRequestContext{
		ChannelId:            id,
		PendingId:            "p-deposit",
		ReservationCommitted: true,
	})
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
	if lockHeld(t, s, id, "") {
		t.Fatal("admission lock not released after deposit settle")
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
	after := runAfterVerify(t, s, pp, validVerifyResult())
	if after == nil || !after.SkipHandler {
		t.Fatalf("expected refund SkipHandler from AfterVerify, got %+v", after)
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
	s.MergeRequestContext(stub, BatchSettlementRequestContext{
		ChannelId:            id,
		PendingId:            "p-refund",
		ReservationCommitted: true,
	})
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
	if lockHeld(t, s, id, "") {
		t.Fatal("admission lock not released after partial refund")
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

func TestAfterSettleHook_DepositChargesWithoutLock(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	_ = s.UpdateSession(id, sampleSession(id, "0"))
	err := s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      &stubPayload{data: depositPayloadFor(id, "100", "0xsig")},
			Requirements: batchedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"channelId":           id,
					"balance":             "10000",
					"totalClaimed":        "0",
					"withdrawRequestedAt": 0,
					"refundNonce":         "0",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := s.GetSession(id)
	if got == nil || got.ChargedCumulativeAmount != "10" {
		t.Fatalf("session = %+v", got)
	}
}

func TestAfterSettleHook_DepositNoRowNoSnapshotBusy(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	err := s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      &stubPayload{data: depositPayloadFor(id, "100", "0xsig")},
			Requirements: batchedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"channelId":    id,
					"balance":      "10000",
					"totalClaimed": "0",
					"refundNonce":  "0",
				},
			},
		},
	})
	if err == nil || err.Error() != batchsettlement.ErrChannelBusy {
		t.Fatalf("got %v", err)
	}
}

func TestAfterSettleHook_DepositHeldByOtherBusy(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	_ = s.UpdateSession(id, sampleSession(id, "0"))
	mustAcquire(t, s, id, "other")
	err := s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      &stubPayload{data: depositPayloadFor(id, "100", "0xsig")},
			Requirements: batchedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"channelId":    id,
					"balance":      "10000",
					"totalClaimed": "0",
					"refundNonce":  "0",
				},
			},
		},
	})
	if err == nil || err.Error() != batchsettlement.ErrChannelBusy {
		t.Fatalf("got %v", err)
	}
}

func TestEnrichSettlementPayload_HeldByOtherBusy(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	sess := sampleSession(id, "500")
	sess.ChannelConfig = testConfig()
	sess.Balance = "10000"
	_ = s.UpdateSession(id, sess)
	mustAcquire(t, s, id, "other")
	_, err := s.EnrichSettlementPayload(x402.SettleContext{
		Payload:      &stubPayload{data: refundPayload(id, "500", "0xsig")},
		Requirements: batchedReqs(),
	})
	if err == nil || err.Error() != batchsettlement.ErrChannelBusy {
		t.Fatalf("got %v", err)
	}
}

func TestEnrichSettlementPayload_MissingChannel(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	id, _ := batchsettlement.ComputeChannelId(testConfig(), "eip155:8453")
	_, err := s.EnrichSettlementPayload(x402.SettleContext{
		Payload:      &stubPayload{data: refundPayload(id, "500", "0xsig")},
		Requirements: batchedReqs(),
	})
	if err == nil || err.Error() != batchsettlement.ErrMissingChannel {
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
