package client

import (
	"context"
	"errors"
	"math/big"
	"strings"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	testNetwork            = "eip155:8453"
	testAsset              = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
	testPayTo              = "0x3333333333333333333333333333333333333333"
	testReceiverAuthorizer = "0x4444444444444444444444444444444444444444"
)

// readSigner extends mockSigner with ReadContract.
type readSigner struct {
	*mockSigner
	readResult interface{}
	readErr    error
}

func (r *readSigner) ReadContract(_ context.Context, _ string, _ []byte, _ string, _ ...interface{}) (interface{}, error) {
	return r.readResult, r.readErr
}

func defaultRequirements() types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:  batchsettlement.SchemeBatched,
		Network: testNetwork,
		Asset:   testAsset,
		Amount:  "100",
		PayTo:   testPayTo,
		Extra: map[string]interface{}{
			"name":               "USDC",
			"version":            "2",
			"receiverAuthorizer": testReceiverAuthorizer,
		},
	}
}

func requirementsWithAmount(amount string) types.PaymentRequirements {
	req := defaultRequirements()
	req.Amount = amount
	return req
}

func strPtr(s string) *string { return &s }

func makeSettle(extra map[string]interface{}) *x402.SettleResponse {
	return &x402.SettleResponse{
		Success:     true,
		Transaction: "0x",
		Network:     testNetwork,
		Extra:       extra,
	}
}

func makeFailedSettle(extra map[string]interface{}) *x402.SettleResponse {
	return &x402.SettleResponse{
		Success:     false,
		Transaction: "",
		Network:     testNetwork,
		ErrorReason: "settlement_failed",
		Extra:       extra,
	}
}

func voucherPayload() map[string]interface{} {
	return map[string]interface{}{"type": "voucher"}
}

func refundPayloadMap(channelId string, amount *string) map[string]interface{} {
	p := map[string]interface{}{
		"type":          "refund",
		"channelConfig": map[string]interface{}{},
		"voucher": map[string]interface{}{
			"channelId":          channelId,
			"maxClaimableAmount": "1000",
			"signature":          "0xdead",
		},
	}
	if amount != nil {
		p["amount"] = *amount
	}
	return p
}

func depositPayloadMap(channelId, depositAmount string) map[string]interface{} {
	return map[string]interface{}{
		"type":          "deposit",
		"channelConfig": map[string]interface{}{},
		"voucher": map[string]interface{}{
			"channelId":          channelId,
			"maxClaimableAmount": "1000",
			"signature":          "0xdead",
		},
		"deposit": map[string]interface{}{
			"amount":        depositAmount,
			"authorization": map[string]interface{}{},
		},
	}
}

func localChannelId(t *testing.T, scheme *BatchSettlementEvmScheme, req types.PaymentRequirements) string {
	t.Helper()
	cfg, err := scheme.BuildChannelConfig(req)
	if err != nil {
		t.Fatalf("BuildChannelConfig: %v", err)
	}
	id, err := batchsettlement.ComputeChannelId(cfg, req.Network)
	if err != nil {
		t.Fatalf("ComputeChannelId: %v", err)
	}
	id, err = batchsettlement.NormalizeChannelId(id)
	if err != nil {
		t.Fatalf("NormalizeChannelId: %v", err)
	}
	return id
}

// ---------- NewBatchSettlementEvmScheme defaults ----------

func TestNewBatchSettlementEvmScheme_Defaults(t *testing.T) {
	signer := &mockSigner{address: "0x1"}
	scheme := NewBatchSettlementEvmScheme(signer, nil)
	if scheme.config.DepositMultiplier != DefaultDepositMultiplier {
		t.Fatalf("multiplier = %d", scheme.config.DepositMultiplier)
	}
	if scheme.config.Salt != DefaultSalt {
		t.Fatalf("salt = %s", scheme.config.Salt)
	}
	if scheme.config.DepositStrategy != nil {
		t.Fatal("DepositStrategy should be nil by default")
	}
	if scheme.storage == nil {
		t.Fatal("storage default missing")
	}
	if scheme.Scheme() != batchsettlement.SchemeBatched {
		t.Fatalf("Scheme() = %s", scheme.Scheme())
	}
}

func TestNewBatchSettlementEvmScheme_OverridesConfig(t *testing.T) {
	signer := &mockSigner{address: "0x1"}
	storage := NewInMemoryClientChannelStorage()
	cfg := &BatchSettlementEvmSchemeOptions{
		DepositMultiplier: 7,
		Storage:           storage,
		Salt:              "0xfeed",
		PayerAuthorizer:   "0xPA",
		VoucherSigner:     &mockSigner{address: "0xV"},
	}
	scheme := NewBatchSettlementEvmScheme(signer, cfg)
	if scheme.config.DepositMultiplier != 7 {
		t.Fatalf("multiplier = %d", scheme.config.DepositMultiplier)
	}
	if scheme.storage != storage {
		t.Fatal("storage should be the explicit one")
	}
	if scheme.config.Salt != "0xfeed" {
		t.Fatalf("salt = %s", scheme.config.Salt)
	}
	if scheme.config.PayerAuthorizer != "0xPA" {
		t.Fatalf("payerAuthorizer = %s", scheme.config.PayerAuthorizer)
	}
	if scheme.config.VoucherSigner == nil {
		t.Fatal("voucherSigner missing")
	}
}

// ---------- BuildChannelConfig ----------

func TestBuildChannelConfig_DefaultsAndOverrides(t *testing.T) {
	signer := &mockSigner{address: "0xSIGNER"}
	scheme := NewBatchSettlementEvmScheme(signer, nil)
	req := defaultRequirements()
	config, err := scheme.BuildChannelConfig(req)
	if err != nil {
		t.Fatalf("BuildChannelConfig: %v", err)
	}

	if config.Payer != "0xSIGNER" || config.PayerAuthorizer != "0xSIGNER" {
		t.Fatalf("payer/payerAuthorizer = %s/%s", config.Payer, config.PayerAuthorizer)
	}
	if config.Receiver != testPayTo || config.ReceiverAuthorizer != testReceiverAuthorizer {
		t.Fatalf("receiver/receiverAuthorizer mismatch: %s/%s", config.Receiver, config.ReceiverAuthorizer)
	}
	if config.Token != testAsset {
		t.Fatalf("token = %s", config.Token)
	}
	if config.WithdrawDelay != DefaultWithdrawDelay {
		t.Fatalf("withdrawDelay = %d", config.WithdrawDelay)
	}
}

func TestBuildChannelConfig_ReceiverAuthorizerOverride(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1"}, nil)
	req := defaultRequirements()
	req.Extra["receiverAuthorizer"] = "0x5555555555555555555555555555555555555555"
	cfg, err := scheme.BuildChannelConfig(req)
	if err != nil {
		t.Fatalf("BuildChannelConfig: %v", err)
	}
	if cfg.ReceiverAuthorizer != "0x5555555555555555555555555555555555555555" {
		t.Fatalf("receiverAuthorizer = %s", cfg.ReceiverAuthorizer)
	}
}

func TestBuildChannelConfig_RejectsMissingOrZeroReceiverAuthorizer(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1"}, nil)

	req := defaultRequirements()
	delete(req.Extra, "receiverAuthorizer")
	if _, err := scheme.BuildChannelConfig(req); err == nil {
		t.Fatalf("expected error when receiverAuthorizer is missing")
	}

	req = defaultRequirements()
	req.Extra["receiverAuthorizer"] = "0x0000000000000000000000000000000000000000"
	if _, err := scheme.BuildChannelConfig(req); err == nil {
		t.Fatalf("expected error when receiverAuthorizer is zero")
	}
}

func TestBuildChannelConfig_WithdrawDelayOverride(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1"}, nil)

	for _, v := range []interface{}{float64(1800), int(1800)} {
		req := defaultRequirements()
		req.Extra["withdrawDelay"] = v
		cfg, err := scheme.BuildChannelConfig(req)
		if err != nil {
			t.Fatalf("%T: %v", v, err)
		}
		if cfg.WithdrawDelay != 1800 {
			t.Fatalf("%T: withdrawDelay = %d", v, cfg.WithdrawDelay)
		}
	}
}

func TestBuildChannelConfig_ExplicitPayerAuthorizer(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0xSIG"}, &BatchSettlementEvmSchemeOptions{
		PayerAuthorizer: "0xPA",
	})
	cfg, err := scheme.BuildChannelConfig(defaultRequirements())
	if err != nil {
		t.Fatalf("BuildChannelConfig: %v", err)
	}
	if cfg.PayerAuthorizer != "0xPA" {
		t.Fatalf("payerAuthorizer = %s", cfg.PayerAuthorizer)
	}
	if cfg.Payer != "0xSIG" {
		t.Fatalf("payer = %s", cfg.Payer)
	}
}

// ---------- calculateDepositAmount ----------

func TestCalculateDepositAmount_BasicMultiplier(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1"}, nil)
	// Default multiplier 5 → 5 * 100 = 500.
	got := scheme.calculateDepositAmount(big.NewInt(100))
	if got.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("got %s", got.String())
	}
}

func TestCalculateDepositAmount_HonorsCustomMultiplier(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1"}, &BatchSettlementEvmSchemeOptions{
		DepositMultiplier: 100,
	})
	got := scheme.calculateDepositAmount(big.NewInt(100))
	if got.Cmp(big.NewInt(10_000)) != 0 {
		t.Fatalf("got %s", got.String())
	}
}

// ---------- DepositStrategy ----------

func TestDepositStrategy_OverridesAmount(t *testing.T) {
	called := false
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1"}, &BatchSettlementEvmSchemeOptions{
		DepositStrategy: func(_ context.Context, c DepositStrategyContext) (DepositStrategyResult, error) {
			called = true
			// Return a higher deposit than the default.
			return DepositStrategyResult{Amount: "999999"}, nil
		},
	})
	res, err := scheme.resolveDepositAmount(context.Background(), DepositStrategyContext{
		MinimumDepositAmount: "100",
		DepositAmount:        "500",
	})
	if err != nil || !called {
		t.Fatalf("strategy not invoked or err: called=%v err=%v", called, err)
	}
	if res.amount != "999999" || res.skip {
		t.Fatalf("got %+v", res)
	}
}

func TestDepositStrategy_SkipsDeposit(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1"}, &BatchSettlementEvmSchemeOptions{
		DepositStrategy: func(_ context.Context, _ DepositStrategyContext) (DepositStrategyResult, error) {
			return DepositStrategyResult{Skip: true}, nil
		},
	})
	res, err := scheme.resolveDepositAmount(context.Background(), DepositStrategyContext{
		MinimumDepositAmount: "100",
		DepositAmount:        "500",
	})
	if err != nil || !res.skip {
		t.Fatalf("expected skip; got %+v err=%v", res, err)
	}
}

func TestDepositStrategy_RejectsBelowMinimum(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1"}, &BatchSettlementEvmSchemeOptions{
		DepositStrategy: func(_ context.Context, _ DepositStrategyContext) (DepositStrategyResult, error) {
			return DepositStrategyResult{Amount: "50"}, nil
		},
	})
	_, err := scheme.resolveDepositAmount(context.Background(), DepositStrategyContext{
		MinimumDepositAmount: "100",
		DepositAmount:        "500",
	})
	if err == nil {
		t.Fatal("expected error: deposit below minimum")
	}
}

func TestDepositStrategy_DefaultsToComputedAmountWhenStrategyReturnsEmpty(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1"}, &BatchSettlementEvmSchemeOptions{
		DepositStrategy: func(_ context.Context, _ DepositStrategyContext) (DepositStrategyResult, error) {
			// Empty Amount with Skip=false → SDK uses computed deposit.
			return DepositStrategyResult{}, nil
		},
	})
	res, err := scheme.resolveDepositAmount(context.Background(), DepositStrategyContext{
		MinimumDepositAmount: "100",
		DepositAmount:        "500",
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.amount != "500" {
		t.Fatalf("expected fallback to 500, got %q", res.amount)
	}
}

// ---------- HasSession / GetSession ----------

func TestHasSession_GetSession(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1"}, &BatchSettlementEvmSchemeOptions{Storage: storage})

	const missingID = "0x0000000000000000000000000000000000000000000000000000000000000099"
	const channelID = "0xabcdef0000000000000000000000000000000000000000000000000000000000"
	const channelIDUpper = "0xABCDEF0000000000000000000000000000000000000000000000000000000000"

	if scheme.HasSession(missingID) {
		t.Fatal("missing should be false")
	}
	if _, ok := scheme.GetSession(missingID); ok {
		t.Fatal("missing should not return ok")
	}

	_ = storage.Set(channelID, &BatchSettlementClientContext{Balance: "100"})
	if !scheme.HasSession(channelIDUpper) {
		t.Fatal("case-insensitive lookup failed")
	}
	got, ok := scheme.GetSession(channelIDUpper)
	if !ok || got.Balance != "100" {
		t.Fatalf("GetSession = %+v ok=%v", got, ok)
	}
}

// ---------- UpdateChannelFromSettle / OnPaymentResponse ----------

func TestUpdateChannelFromSettle_AppliesCappedChargedAmountLeavesBalanceUnchanged(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	signer := &mockSigner{address: "0x1111111111111111111111111111111111111111"}
	scheme := NewBatchSettlementEvmScheme(signer, &BatchSettlementEvmSchemeOptions{Storage: storage})
	req := requirementsWithAmount("1000")
	channelId := localChannelId(t, scheme, req)
	_ = storage.Set(channelId, &BatchSettlementClientContext{
		Balance:                 "9000",
		ChargedCumulativeAmount: "0",
		TotalClaimed:            "500",
	})

	_, err := scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		PaymentPayload: types.PaymentPayload{Payload: voucherPayload()},
		Requirements:   req,
		SettleResponse: makeSettle(map[string]interface{}{
			"chargedAmount": "1000",
			"channelState": map[string]interface{}{
				"channelId":               channelId,
				"chargedCumulativeAmount": "1000",
				"balance":                 "1",
				"totalClaimed":            "999",
			},
		}),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get(channelId)
	if got == nil || got.ChargedCumulativeAmount != "1000" || got.Balance != "9000" || got.TotalClaimed != "500" {
		t.Fatalf("session = %+v", got)
	}
}

func TestUpdateChannelFromSettle_IgnoresNoChargedAmountAndNoDeposit(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	channelId := "0xabc1230000000000000000000000000000000000000000000000000000000001"
	if err := UpdateChannelFromSettle(storage, ChannelSettleServer{}, ChannelSettleLocal{
		ChannelId:     channelId,
		RequestAmount: "1000",
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get(channelId)
	if got != nil {
		t.Fatalf("expected no session, got %+v", got)
	}
}

func TestOnPaymentResponse_DoesNotProcessFailedSettle(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	signer := &mockSigner{address: "0x1111111111111111111111111111111111111111"}
	scheme := NewBatchSettlementEvmScheme(signer, &BatchSettlementEvmSchemeOptions{Storage: storage})
	req := requirementsWithAmount("1000")
	channelId := localChannelId(t, scheme, req)

	_, err := scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		PaymentPayload: types.PaymentPayload{Payload: depositPayloadMap(channelId, "5000")},
		Requirements:   req,
		SettleResponse: makeFailedSettle(map[string]interface{}{"chargedAmount": "1000"}),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get(channelId)
	if got != nil {
		t.Fatalf("expected no session, got %+v", got)
	}
}

func TestOnPaymentResponse_DelegatesToUpdateChannelFromSettle(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	signer := &mockSigner{address: "0x1111111111111111111111111111111111111111"}
	scheme := NewBatchSettlementEvmScheme(signer, &BatchSettlementEvmSchemeOptions{Storage: storage})
	req := requirementsWithAmount("1000")
	channelId := localChannelId(t, scheme, req)
	_ = storage.Set(channelId, &BatchSettlementClientContext{
		Balance:                 "9000",
		ChargedCumulativeAmount: "0",
	})

	_, err := scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		PaymentPayload: types.PaymentPayload{Payload: voucherPayload()},
		Requirements:   req,
		SettleResponse: makeSettle(map[string]interface{}{
			"chargedAmount": "1000",
			"channelState": map[string]interface{}{
				"channelId":               channelId,
				"chargedCumulativeAmount": "1000",
				"balance":                 "9000",
			},
		}),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get(channelId)
	if got == nil || got.ChargedCumulativeAmount != "1000" || got.Balance != "9000" {
		t.Fatalf("session = %+v", got)
	}
}

func TestOnPaymentResponse_DoesNotRecordDepositWhenSettlementFails(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	signer := &mockSigner{address: "0x1111111111111111111111111111111111111111"}
	scheme := NewBatchSettlementEvmScheme(signer, &BatchSettlementEvmSchemeOptions{Storage: storage})
	req := defaultRequirements()
	channelId := localChannelId(t, scheme, req)

	_, err := scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		PaymentPayload: types.PaymentPayload{Payload: depositPayloadMap(channelId, "5000")},
		Requirements:   req,
		SettleResponse: makeFailedSettle(map[string]interface{}{"chargedAmount": "1000"}),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get(channelId)
	if got != nil {
		t.Fatalf("expected no session, got %+v", got)
	}
}

func TestOnPaymentResponse_RoutesRefundThroughRefundReconciliation(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	signer := &mockSigner{address: "0x1111111111111111111111111111111111111111"}
	scheme := NewBatchSettlementEvmScheme(signer, &BatchSettlementEvmSchemeOptions{Storage: storage})
	req := defaultRequirements()
	channelId := localChannelId(t, scheme, req)
	_ = storage.Set(channelId, &BatchSettlementClientContext{ChargedCumulativeAmount: "1000"})

	_, err := scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		PaymentPayload: types.PaymentPayload{Payload: refundPayloadMap(channelId, nil)},
		Requirements:   req,
		SettleResponse: makeSettle(map[string]interface{}{
			"channelState": map[string]interface{}{"channelId": channelId, "balance": "9999"},
		}),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get(channelId)
	if got != nil {
		t.Fatalf("full refund should delete, got %+v", got)
	}

	_, err = scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		PaymentPayload: types.PaymentPayload{Payload: voucherPayload()},
		Requirements:   req,
		SettleResponse: makeSettle(map[string]interface{}{
			"channelState": map[string]interface{}{"channelId": channelId, "balance": "0"},
		}),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ = storage.Get(channelId)
	if got != nil {
		t.Fatalf("voucher-only with no chargedAmount should not write, got %+v", got)
	}
}

func TestOnPaymentResponse_SubtractsPartialRefundIgnoresServerBalance(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	signer := &mockSigner{address: "0x1111111111111111111111111111111111111111"}
	scheme := NewBatchSettlementEvmScheme(signer, &BatchSettlementEvmSchemeOptions{Storage: storage})
	req := defaultRequirements()
	channelId := localChannelId(t, scheme, req)
	_ = storage.Set(channelId, &BatchSettlementClientContext{
		ChargedCumulativeAmount: "1000",
		Balance:                 "10000",
	})

	_, err := scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		PaymentPayload: types.PaymentPayload{Payload: refundPayloadMap(channelId, strPtr("2000"))},
		Requirements:   req,
		SettleResponse: makeSettle(map[string]interface{}{
			"channelState": map[string]interface{}{"channelId": channelId, "balance": "0"},
		}),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get(channelId)
	if got == nil || got.Balance != "8000" || got.ChargedCumulativeAmount != "1000" {
		t.Fatalf("session = %+v", got)
	}
}

func TestOnPaymentResponse_LeavesStateUnchangedWhenRefundSettleFails(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	signer := &mockSigner{address: "0x1111111111111111111111111111111111111111"}
	scheme := NewBatchSettlementEvmScheme(signer, &BatchSettlementEvmSchemeOptions{Storage: storage})
	req := defaultRequirements()
	channelId := localChannelId(t, scheme, req)
	previous := &BatchSettlementClientContext{
		ChargedCumulativeAmount: "1000",
		Balance:                 "10000",
		TotalClaimed:            "500",
	}
	_ = storage.Set(channelId, previous)

	_, err := scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		PaymentPayload: types.PaymentPayload{Payload: refundPayloadMap(channelId, strPtr("2000"))},
		Requirements:   req,
		SettleResponse: makeFailedSettle(nil),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get(channelId)
	if got == nil || got.ChargedCumulativeAmount != "1000" || got.Balance != "10000" || got.TotalClaimed != "500" {
		t.Fatalf("session = %+v", got)
	}
}

func TestOnPaymentResponse_KeysRefundByLocallyComputedChannelId(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	signer := &mockSigner{address: "0x1111111111111111111111111111111111111111"}
	scheme := NewBatchSettlementEvmScheme(signer, &BatchSettlementEvmSchemeOptions{Storage: storage})
	req := defaultRequirements()
	localId := localChannelId(t, scheme, req)
	hostileId := "0xabc12300000000000000000000000000000000000000000000000000000000ff"
	_ = storage.Set(localId, &BatchSettlementClientContext{ChargedCumulativeAmount: "1000", Balance: "5000"})

	_, err := scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		PaymentPayload: types.PaymentPayload{Payload: refundPayloadMap(localId, nil)},
		Requirements:   req,
		SettleResponse: makeSettle(map[string]interface{}{
			"channelState": map[string]interface{}{"channelId": hostileId, "balance": "9999"},
		}),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get(localId)
	if got != nil {
		t.Fatalf("local session should be deleted, got %+v", got)
	}
	got, _ = storage.Get(hostileId)
	if got != nil {
		t.Fatalf("hostile key should stay empty, got %+v", got)
	}
}

func TestUpdateChannelFromSettle_GetError(t *testing.T) {
	storageErr := errors.New("storage unavailable")
	storage := &failingClientChannelStorage{
		storage: NewInMemoryClientChannelStorage(),
		getErr:  storageErr,
	}
	err := UpdateChannelFromSettle(storage, ChannelSettleServer{ChargedAmount: strPtr("100")}, ChannelSettleLocal{
		ChannelId:     testChannelID,
		RequestAmount: "1000",
	})
	if !errors.Is(err, storageErr) {
		t.Fatalf("expected storage error, got %v", err)
	}
	if storage.setCalls != 0 {
		t.Fatalf("Set called %d time(s) after Get failure", storage.setCalls)
	}
}

// ---------- UpdateChannelFromSettle local truth ----------

const hostileChannelID = "0xabc12300000000000000000000000000000000000000000000000000000000aa"

func seedChannel(storage ClientChannelStorage, channelId, balance, charged string) {
	_ = storage.Set(channelId, &BatchSettlementClientContext{
		Balance:                 balance,
		ChargedCumulativeAmount: charged,
	})
}

func TestUpdateChannelFromSettle_IgnoresInflatedServerCumulative(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	signer := &mockSigner{address: "0x1111111111111111111111111111111111111111", sig: []byte{0xaa}}
	scheme := NewBatchSettlementEvmScheme(signer, &BatchSettlementEvmSchemeOptions{Storage: storage})
	req := requirementsWithAmount("10000")
	channelId := localChannelId(t, scheme, req)
	seedChannel(storage, channelId, "50000", "0")

	_, err := scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		PaymentPayload: types.PaymentPayload{Payload: voucherPayload()},
		Requirements:   req,
		SettleResponse: makeSettle(map[string]interface{}{
			"chargedAmount": "10000",
			"channelState": map[string]interface{}{
				"channelId":               channelId,
				"chargedCumulativeAmount": "40000",
				"balance":                 "50000",
			},
		}),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get(channelId)
	if got == nil || got.ChargedCumulativeAmount != "0" || got.Balance != "50000" {
		t.Fatalf("session = %+v", got)
	}

	result, err := scheme.CreatePaymentPayload(context.Background(), req)
	if err != nil {
		t.Fatalf("CreatePaymentPayload: %v", err)
	}
	if result.Payload["type"] != "voucher" {
		t.Fatalf("expected voucher, got %v", result.Payload["type"])
	}
	voucher, _ := result.Payload["voucher"].(map[string]interface{})
	if voucher["maxClaimableAmount"] != "10000" {
		t.Fatalf("maxClaimableAmount = %v", voucher["maxClaimableAmount"])
	}
}

func TestUpdateChannelFromSettle_DoesNotWriteSecondKeyOnChannelIdMismatch(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	signer := &mockSigner{address: "0x1111111111111111111111111111111111111111"}
	scheme := NewBatchSettlementEvmScheme(signer, &BatchSettlementEvmSchemeOptions{Storage: storage})
	req := requirementsWithAmount("10000")
	channelId := localChannelId(t, scheme, req)
	seedChannel(storage, channelId, "50000", "0")

	_, err := scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		PaymentPayload: types.PaymentPayload{Payload: voucherPayload()},
		Requirements:   req,
		SettleResponse: makeSettle(map[string]interface{}{
			"chargedAmount": "10000",
			"channelState": map[string]interface{}{
				"channelId":               hostileChannelID,
				"chargedCumulativeAmount": "10000",
				"balance":                 "50000",
			},
		}),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get(hostileChannelID)
	if got != nil {
		t.Fatalf("hostile key written: %+v", got)
	}
	got, _ = storage.Get(channelId)
	if got == nil || got.ChargedCumulativeAmount != "10000" || got.Balance != "50000" {
		t.Fatalf("session = %+v", got)
	}
}

func TestUpdateChannelFromSettle_RejectsChargedAmountGreaterThanRequestAmount(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	channelId := "0xabc1230000000000000000000000000000000000000000000000000000000005"
	seedChannel(storage, channelId, "50000", "0")

	err := UpdateChannelFromSettle(storage, ChannelSettleServer{ChargedAmount: strPtr("20000")}, ChannelSettleLocal{
		ChannelId:     channelId,
		RequestAmount: "10000",
	})
	if err == nil || !strings.Contains(err.Error(), "chargedAmount") {
		t.Fatalf("expected chargedAmount error, got %v", err)
	}
	got, _ := storage.Get(channelId)
	if got == nil || got.ChargedCumulativeAmount != "0" || got.Balance != "50000" {
		t.Fatalf("session = %+v", got)
	}
}

func TestUpdateChannelFromSettle_RejectsNonIntegerChargedAmount(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	channelId := "0xabc1230000000000000000000000000000000000000000000000000000000005"
	seedChannel(storage, channelId, "50000", "0")

	err := UpdateChannelFromSettle(storage, ChannelSettleServer{ChargedAmount: strPtr("10.5")}, ChannelSettleLocal{
		ChannelId:     channelId,
		RequestAmount: "10000",
	})
	if err == nil || !strings.Contains(err.Error(), "chargedAmount") {
		t.Fatalf("expected chargedAmount error, got %v", err)
	}
	got, _ := storage.Get(channelId)
	if got == nil || got.ChargedCumulativeAmount != "0" {
		t.Fatalf("session = %+v", got)
	}
}

func TestUpdateChannelFromSettle_IgnoresVoucherOnlyBalanceDeflation(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	signer := &mockSigner{address: "0x1111111111111111111111111111111111111111"}
	scheme := NewBatchSettlementEvmScheme(signer, &BatchSettlementEvmSchemeOptions{Storage: storage})
	req := requirementsWithAmount("10000")
	channelId := localChannelId(t, scheme, req)
	seedChannel(storage, channelId, "50000", "0")

	_, err := scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		PaymentPayload: types.PaymentPayload{Payload: voucherPayload()},
		Requirements:   req,
		SettleResponse: makeSettle(map[string]interface{}{
			"chargedAmount": "10000",
			"channelState": map[string]interface{}{
				"channelId":               channelId,
				"chargedCumulativeAmount": "10000",
				"balance":                 "10000",
			},
		}),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get(channelId)
	if got == nil || got.ChargedCumulativeAmount != "10000" || got.Balance != "50000" {
		t.Fatalf("session = %+v", got)
	}
}

func TestUpdateChannelFromSettle_AddsDepositAmountToLocalBalance(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	channelId := "0xabc1230000000000000000000000000000000000000000000000000000000008"
	if err := UpdateChannelFromSettle(storage, ChannelSettleServer{ChargedAmount: strPtr("10000")}, ChannelSettleLocal{
		ChannelId:     channelId,
		RequestAmount: "10000",
		DepositAmount: strPtr("50000"),
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get(channelId)
	if got == nil || got.ChargedCumulativeAmount != "10000" || got.Balance != "50000" {
		t.Fatalf("session = %+v", got)
	}
}

func TestUpdateChannelFromSettle_PersistsWhenExtraCumulativeOmitted(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	channelId := "0xabc1230000000000000000000000000000000000000000000000000000000007"
	seedChannel(storage, channelId, "50000", "0")

	if err := UpdateChannelFromSettle(storage, ChannelSettleServer{ChargedAmount: strPtr("10000")}, ChannelSettleLocal{
		ChannelId:     channelId,
		RequestAmount: "10000",
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get(channelId)
	if got == nil || got.ChargedCumulativeAmount != "10000" || got.Balance != "50000" {
		t.Fatalf("session = %+v", got)
	}
}

func TestUpdateChannelFromSettle_PersistsWhenExtraCumulativeMatches(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	channelId := "0xabc1230000000000000000000000000000000000000000000000000000000007"
	seedChannel(storage, channelId, "50000", "0")

	if err := UpdateChannelFromSettle(storage, ChannelSettleServer{
		ChargedAmount:           strPtr("10000"),
		ChargedCumulativeAmount: strPtr("10000"),
	}, ChannelSettleLocal{
		ChannelId:     channelId,
		RequestAmount: "10000",
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get(channelId)
	if got == nil || got.ChargedCumulativeAmount != "10000" || got.Balance != "50000" {
		t.Fatalf("session = %+v", got)
	}
}

func TestUpdateChannelFromSettle_WritesNothingWhenExtraCumulativeDisagreesIncludingDeposit(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	channelId := "0xabc1230000000000000000000000000000000000000000000000000000000009"
	seedChannel(storage, channelId, "50000", "0")

	if err := UpdateChannelFromSettle(storage, ChannelSettleServer{
		ChargedAmount:           strPtr("10000"),
		ChargedCumulativeAmount: strPtr("40000"),
	}, ChannelSettleLocal{
		ChannelId:     channelId,
		RequestAmount: "10000",
		DepositAmount: strPtr("1000"),
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get(channelId)
	if got == nil || got.ChargedCumulativeAmount != "0" || got.Balance != "50000" {
		t.Fatalf("session = %+v", got)
	}
}

func TestUpdateChannelFromSettle_WritesNothingWhenExtraCumulativeNotInteger(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	channelId := "0xabc1230000000000000000000000000000000000000000000000000000000009"
	seedChannel(storage, channelId, "50000", "0")

	if err := UpdateChannelFromSettle(storage, ChannelSettleServer{
		ChargedAmount:           strPtr("10000"),
		ChargedCumulativeAmount: strPtr("10.5"),
	}, ChannelSettleLocal{
		ChannelId:     channelId,
		RequestAmount: "10000",
		DepositAmount: strPtr("1000"),
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get(channelId)
	if got == nil || got.ChargedCumulativeAmount != "0" || got.Balance != "50000" {
		t.Fatalf("session = %+v", got)
	}
}

// ---------- CreatePaymentPayload (deposit + voucher branches) ----------

func TestCreatePaymentPayload_FirstRequestDeposit(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1111111111111111111111111111111111111111", sig: []byte{0xaa}}, nil)
	payload, err := scheme.CreatePaymentPayload(context.Background(), defaultRequirements())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if payload.Payload["type"] != "deposit" {
		t.Fatalf("expected deposit, got %v", payload.Payload["type"])
	}
}

func TestCreatePaymentPayload_VoucherWhenSessionHasFunds(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	signer := &mockSigner{address: "0x1111111111111111111111111111111111111111", sig: []byte{0xab}}
	scheme := NewBatchSettlementEvmScheme(signer, &BatchSettlementEvmSchemeOptions{Storage: storage})

	// Pre-seed session with sufficient funds.
	channelConfig, err := scheme.BuildChannelConfig(defaultRequirements())
	if err != nil {
		t.Fatalf("BuildChannelConfig: %v", err)
	}
	channelId, _ := batchsettlement.ComputeChannelId(channelConfig, testNetwork)
	channelId, _ = batchsettlement.NormalizeChannelId(channelId)
	_ = storage.Set(channelId, &BatchSettlementClientContext{Balance: "1000", ChargedCumulativeAmount: "100"})

	payload, err := scheme.CreatePaymentPayload(context.Background(), defaultRequirements())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if payload.Payload["type"] != "voucher" {
		t.Fatalf("expected voucher, got %v", payload.Payload["type"])
	}
}

func TestCreatePaymentPayload_TopsUpOnInsufficient(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	signer := &mockSigner{address: "0x1111111111111111111111111111111111111111", sig: []byte{0xac}}
	scheme := NewBatchSettlementEvmScheme(signer, &BatchSettlementEvmSchemeOptions{Storage: storage})

	channelConfig, err := scheme.BuildChannelConfig(defaultRequirements())
	if err != nil {
		t.Fatalf("BuildChannelConfig: %v", err)
	}
	channelId, _ := batchsettlement.ComputeChannelId(channelConfig, testNetwork)
	channelId, _ = batchsettlement.NormalizeChannelId(channelId)
	_ = storage.Set(channelId, &BatchSettlementClientContext{Balance: "50", ChargedCumulativeAmount: "0"})

	payload, err := scheme.CreatePaymentPayload(context.Background(), defaultRequirements())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if payload.Payload["type"] != "deposit" {
		t.Fatalf("expected deposit (top-up), got %v", payload.Payload["type"])
	}
}

// DepositStrategy returning Skip=true causes an insufficient-balance request to
// fall through as a voucher (the request will then fail at verify; the caller
// is opting out of auto top-up).
func TestCreatePaymentPayload_DepositStrategySkipYieldsVoucher(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	signer := &mockSigner{address: "0x1111111111111111111111111111111111111111", sig: []byte{0xad}}
	scheme := NewBatchSettlementEvmScheme(signer, &BatchSettlementEvmSchemeOptions{
		Storage: storage,
		DepositStrategy: func(_ context.Context, _ DepositStrategyContext) (DepositStrategyResult, error) {
			return DepositStrategyResult{Skip: true}, nil
		},
	})

	channelConfig, err := scheme.BuildChannelConfig(defaultRequirements())
	if err != nil {
		t.Fatalf("BuildChannelConfig: %v", err)
	}
	channelId, _ := batchsettlement.ComputeChannelId(channelConfig, testNetwork)
	channelId, _ = batchsettlement.NormalizeChannelId(channelId)
	_ = storage.Set(channelId, &BatchSettlementClientContext{Balance: "50"})

	payload, err := scheme.CreatePaymentPayload(context.Background(), defaultRequirements())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if payload.Payload["type"] != "voucher" {
		t.Fatalf("expected voucher (deposit skipped), got %v", payload.Payload["type"])
	}
}

func TestCreatePaymentPayload_BadAmount(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1"}, nil)
	req := defaultRequirements()
	req.Amount = "not-a-number"
	if _, err := scheme.CreatePaymentPayload(context.Background(), req); err == nil {
		t.Fatal("expected error")
	}
}

// ---------- RecoverSession ----------

func TestRecoverSession_RequiresReadCapableSigner(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1"}, nil)
	if _, err := scheme.RecoverSession(context.Background(), defaultRequirements()); err == nil {
		t.Fatal("expected error: signer lacks ReadContract")
	}
}

func TestRecoverSession_OK(t *testing.T) {
	signer := &readSigner{
		mockSigner: &mockSigner{address: "0x1111111111111111111111111111111111111111"},
		readResult: []interface{}{big.NewInt(900), big.NewInt(100)},
	}
	scheme := NewBatchSettlementEvmScheme(signer, nil)
	got, err := scheme.RecoverSession(context.Background(), defaultRequirements())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got.Balance != "900" || got.TotalClaimed != "100" || got.ChargedCumulativeAmount != "100" {
		t.Fatalf("session = %+v", got)
	}
}

func TestRecoverSession_ReadError(t *testing.T) {
	signer := &readSigner{
		mockSigner: &mockSigner{address: "0x1"},
		readErr:    errors.New("rpc down"),
	}
	scheme := NewBatchSettlementEvmScheme(signer, nil)
	if _, err := scheme.RecoverSession(context.Background(), defaultRequirements()); err == nil {
		t.Fatal("expected RPC error")
	}
}

// ---------- ProcessCorrectivePaymentRequired ----------

// readChannelStateFromExtra accepts the corrective split shape:
// extra.channelState + extra.voucherState.
func TestReadChannelStateFromExtra_CanonicalSplitShape(t *testing.T) {
	extra := map[string]interface{}{
		"channelState": map[string]interface{}{
			"channelId":               "0xabc",
			"chargedCumulativeAmount": "200",
			"balance":                 "1000",
			"totalClaimed":            "100",
		},
		"voucherState": map[string]interface{}{
			"signedMaxClaimable": "300",
			"signature":          "0xsig",
		},
	}
	charged, signed, sig, ok := readChannelStateFromExtra(extra)
	if !ok || charged != "200" || signed != "300" || sig != "0xsig" {
		t.Fatalf("canonical shape: ok=%v charged=%q signed=%q sig=%q", ok, charged, signed, sig)
	}
}

func TestReadChannelStateFromExtra_MissingFieldsReturnsFalse(t *testing.T) {
	if _, _, _, ok := readChannelStateFromExtra(nil); ok {
		t.Fatal("nil extra should be rejected")
	}
	// channelState present but voucherState missing — not enough for signature recovery.
	extra := map[string]interface{}{
		"channelState": map[string]interface{}{"chargedCumulativeAmount": "200"},
	}
	if _, _, _, ok := readChannelStateFromExtra(extra); ok {
		t.Fatal("missing voucherState should be rejected")
	}
	// voucherState present but channelState missing.
	extra = map[string]interface{}{
		"voucherState": map[string]interface{}{
			"signedMaxClaimable": "300",
			"signature":          "0xsig",
		},
	}
	if _, _, _, ok := readChannelStateFromExtra(extra); ok {
		t.Fatal("missing channelState should be rejected")
	}
}

func TestProcessCorrective_UnrelatedReason(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1"}, nil)
	ok, err := scheme.ProcessCorrectivePaymentRequired(context.Background(), "other_reason", nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if ok {
		t.Fatal("unrelated reason should not recover")
	}
}

func TestProcessCorrective_NoBatchedAccept(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1"}, nil)
	ok, err := scheme.ProcessCorrectivePaymentRequired(
		context.Background(),
		batchsettlement.ErrCumulativeAmountMismatch,
		[]types.PaymentRequirements{{Scheme: "exact"}},
	)
	if err != nil || ok {
		t.Fatalf("expected (false, nil), got (%v, %v)", ok, err)
	}
}

func TestProcessCorrective_FallsBackToOnChain(t *testing.T) {
	signer := &readSigner{
		mockSigner: &mockSigner{address: "0x1111111111111111111111111111111111111111"},
		readResult: []interface{}{big.NewInt(900), big.NewInt(100)},
	}
	scheme := NewBatchSettlementEvmScheme(signer, nil)
	req := defaultRequirements()
	ok, err := scheme.ProcessCorrectivePaymentRequired(
		context.Background(),
		batchsettlement.ErrCumulativeAmountMismatch,
		[]types.PaymentRequirements{req},
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !ok {
		t.Fatal("expected onchain recovery to succeed")
	}
}

func TestProcessCorrective_RecoverFromSignatureBadCharged(t *testing.T) {
	signer := &readSigner{
		mockSigner: &mockSigner{address: "0x1"},
		readResult: []interface{}{big.NewInt(900), big.NewInt(100)},
	}
	scheme := NewBatchSettlementEvmScheme(signer, nil)
	req := defaultRequirements()
	// Corrective split shape with bad charged amount.
	req.Extra["channelState"] = map[string]interface{}{
		"chargedCumulativeAmount": "not-a-number",
	}
	req.Extra["voucherState"] = map[string]interface{}{
		"signedMaxClaimable": "100",
		"signature":          "0xff",
	}
	ok, err := scheme.ProcessCorrectivePaymentRequired(
		context.Background(),
		batchsettlement.ErrCumulativeAmountMismatch,
		[]types.PaymentRequirements{req},
	)
	if err != nil || ok {
		t.Fatalf("expected (false, nil), got (%v, %v)", ok, err)
	}
}

func TestProcessCorrective_RecoverFromSignatureChargedBeyondSigned(t *testing.T) {
	signer := &readSigner{
		mockSigner: &mockSigner{address: "0x1"},
		readResult: []interface{}{big.NewInt(900), big.NewInt(100)},
	}
	scheme := NewBatchSettlementEvmScheme(signer, nil)
	req := defaultRequirements()
	// Corrective split shape with charged > signed.
	req.Extra["channelState"] = map[string]interface{}{
		"chargedCumulativeAmount": "200",
	}
	req.Extra["voucherState"] = map[string]interface{}{
		"signedMaxClaimable": "100",
		"signature":          "0xff",
	}
	ok, _ := scheme.ProcessCorrectivePaymentRequired(
		context.Background(),
		batchsettlement.ErrCumulativeAmountMismatch,
		[]types.PaymentRequirements{req},
	)
	if ok {
		t.Fatal("charged > signed should refuse")
	}
}

func TestProcessCorrective_RecoverFromSignatureNoReadCapability(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1"}, nil)
	req := defaultRequirements()
	req.Extra["channelState"] = map[string]interface{}{"chargedCumulativeAmount": "10"}
	req.Extra["voucherState"] = map[string]interface{}{
		"signedMaxClaimable": "100",
		"signature":          "0xff",
	}
	ok, _ := scheme.ProcessCorrectivePaymentRequired(
		context.Background(),
		batchsettlement.ErrCumulativeAmountMismatch,
		[]types.PaymentRequirements{req},
	)
	if ok {
		t.Fatal("no read capability should not recover")
	}
}

// ---------- OnPaymentResponse (PaymentResponseHandler) ----------

func TestOnPaymentResponse_NilExtraIsNoop(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1"}, nil)
	res, err := scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		Requirements:   defaultRequirements(),
		SettleResponse: &x402.SettleResponse{Success: true},
	})
	if err != nil || res.Recovered {
		t.Fatalf("expected no-op, got recovered=%v err=%v", res.Recovered, err)
	}
}

func TestOnPaymentResponse_CorrectiveMismatchSignalsRecovered(t *testing.T) {
	signer := &readSigner{
		mockSigner: &mockSigner{address: "0x1"},
		readResult: []interface{}{big.NewInt(900), big.NewInt(50)},
	}
	storage := NewInMemoryClientChannelStorage()
	scheme := NewBatchSettlementEvmScheme(signer, &BatchSettlementEvmSchemeOptions{Storage: storage})

	res, err := scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		Requirements: defaultRequirements(),
		PaymentRequired: &types.PaymentRequired{
			X402Version: 2,
			Resource:    &types.ResourceInfo{URL: "https://example.com/resource"},
			Error:       batchsettlement.ErrCumulativeAmountMismatch,
			Accepts:     []types.PaymentRequirements{defaultRequirements()},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !res.Recovered {
		t.Fatal("onchain recovery should set Recovered=true")
	}
}

func TestOnPaymentResponse_CorrectiveUnknownErrorDoesNotRecover(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0x1"}, nil)
	res, err := scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		Requirements: defaultRequirements(),
		PaymentRequired: &types.PaymentRequired{
			X402Version: 2,
			Resource:    &types.ResourceInfo{URL: "https://example.com/resource"},
			Error:       "some_other_error",
			Accepts:     []types.PaymentRequirements{defaultRequirements()},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.Recovered {
		t.Fatal("unrelated error should not signal Recovered")
	}
}

// ---------- Refund adapter ----------

func TestRefundContextAdapter(t *testing.T) {
	signer := &mockSigner{address: "0x1"}
	voucherSigner := &mockSigner{address: "0xV"}
	storage := NewInMemoryClientChannelStorage()
	scheme := NewBatchSettlementEvmScheme(signer, &BatchSettlementEvmSchemeOptions{
		Storage:       storage,
		VoucherSigner: voucherSigner,
	})
	a := &refundContextAdapter{scheme: scheme}
	if a.Storage() != storage {
		t.Fatal("Storage() mismatch")
	}
	if a.Signer() != evm.ClientEvmSigner(signer) {
		t.Fatal("Signer() mismatch")
	}
	if a.VoucherSigner() != evm.ClientEvmSigner(voucherSigner) {
		t.Fatal("VoucherSigner() mismatch")
	}
	cfg, err := a.BuildChannelConfig(defaultRequirements())
	if err != nil {
		t.Fatalf("BuildChannelConfig: %v", err)
	}
	if cfg.Payer != signer.Address() {
		t.Fatalf("BuildChannelConfig.Payer = %s", cfg.Payer)
	}
	ok, err := a.ProcessCorrectivePaymentRequired(context.Background(), "x", nil)
	if err != nil || ok {
		t.Fatalf("got (%v, %v)", ok, err)
	}
}
