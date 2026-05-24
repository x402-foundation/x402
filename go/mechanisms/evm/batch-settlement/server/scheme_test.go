package server

import (
	"context"
	"errors"
	"math/big"
	"testing"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/types"
)

// mockAuthorizerSigner records calls and returns canned bytes.
type mockAuthorizerSigner struct {
	address string
	sig     []byte
	err     error
	calls   int
}

func (m *mockAuthorizerSigner) Address() string { return m.address }
func (m *mockAuthorizerSigner) SignTypedData(_ context.Context, _ evm.TypedDataDomain, _ map[string][]evm.TypedDataField, _ string, _ map[string]interface{}) ([]byte, error) {
	m.calls++
	return m.sig, m.err
}

func TestNewBatchSettlementEvmScheme_NilConfigDefaults(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	if s.GetReceiverAddress() != "0xreceiver" {
		t.Fatalf("receiver = %q", s.GetReceiverAddress())
	}
	if s.GetWithdrawDelay() != batchsettlement.MinWithdrawDelay {
		t.Fatalf("withdrawDelay = %d", s.GetWithdrawDelay())
	}
	if s.GetReceiverAuthorizerAddress() != "" {
		t.Fatalf("expected empty receiverAuthorizer, got %q", s.GetReceiverAuthorizerAddress())
	}
	if s.GetStorage() == nil {
		t.Fatal("expected default in-memory storage")
	}
	if s.Scheme() != batchsettlement.SchemeBatched {
		t.Fatalf("scheme = %s", s.Scheme())
	}
}

func TestNewBatchSettlementEvmScheme_OverridesApplied(t *testing.T) {
	storage := NewInMemoryChannelStorage()
	auth := &mockAuthorizerSigner{address: "0xauth"}
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{
		Storage:                  storage,
		ReceiverAuthorizerSigner: auth,
		WithdrawDelay:            1800,
	})
	if s.GetWithdrawDelay() != 1800 {
		t.Fatalf("withdrawDelay = %d", s.GetWithdrawDelay())
	}
	if s.GetReceiverAuthorizerAddress() != "0xauth" {
		t.Fatalf("receiverAuthorizer = %q", s.GetReceiverAuthorizerAddress())
	}
	if s.GetStorage() != storage {
		t.Fatalf("expected provided storage")
	}
}

func TestNewBatchSettlementEvmScheme_ZeroWithdrawDelayFallsBackToMin(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{WithdrawDelay: 0})
	if s.GetWithdrawDelay() != batchsettlement.MinWithdrawDelay {
		t.Fatalf("withdrawDelay = %d", s.GetWithdrawDelay())
	}
}

func TestParsePrice_AssetAmountMap(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	got, err := s.ParsePrice(map[string]interface{}{
		"amount": "1000",
		"asset":  "0xtoken",
		"extra":  map[string]interface{}{"name": "USDC"},
	}, x402.Network("eip155:8453"))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got.Amount != "1000" || got.Asset != "0xtoken" {
		t.Fatalf("got = %+v", got)
	}
	if got.Extra["name"] != "USDC" {
		t.Fatalf("extra = %+v", got.Extra)
	}
}

func TestParsePrice_AssetAmountMap_AmountNotString(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	_, err := s.ParsePrice(map[string]interface{}{
		"amount": 1000,
		"asset":  "0xtoken",
	}, x402.Network("eip155:8453"))
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestParsePrice_AssetAmountMap_MissingAsset(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	_, err := s.ParsePrice(map[string]interface{}{"amount": "1000"}, x402.Network("eip155:8453"))
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestParsePrice_String(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	got, err := s.ParsePrice("$0.01", x402.Network("eip155:8453"))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got.Amount == "" || got.Asset == "" {
		t.Fatalf("got = %+v", got)
	}
}

func TestParsePrice_UnsupportedType(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	_, err := s.ParsePrice(struct{}{}, x402.Network("eip155:8453"))
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestRegisterMoneyParser_OverridesDefault(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	called := false
	s.RegisterMoneyParser(func(_ float64, _ x402.Network) (*x402.AssetAmount, error) {
		called = true
		return &x402.AssetAmount{Amount: "777", Asset: "0xcustom"}, nil
	})
	got, err := s.ParsePrice("0.50", x402.Network("eip155:8453"))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !called || got.Amount != "777" || got.Asset != "0xcustom" {
		t.Fatalf("custom parser not invoked: called=%v got=%+v", called, got)
	}
}

func TestEnhancePaymentRequirements_ExplicitAsset(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth"}
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{
		ReceiverAuthorizerSigner: auth,
		WithdrawDelay:            1800,
	})
	req := types.PaymentRequirements{
		Network: "eip155:8453",
		Asset:   "0x1234567890abcdef1234567890abcdef12345678",
		Amount:  "1000",
	}
	out, err := s.EnhancePaymentRequirements(context.Background(), req, types.SupportedKind{}, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if out.Extra["receiverAuthorizer"] != "0xauth" {
		t.Fatalf("receiverAuthorizer = %v", out.Extra["receiverAuthorizer"])
	}
	if out.Extra["withdrawDelay"] != 1800 {
		t.Fatalf("withdrawDelay = %v", out.Extra["withdrawDelay"])
	}
}

// In delegated-authorizer mode (no local ReceiverAuthorizerSigner) the server
// must surface the facilitator-advertised authorizer from supportedKind.Extra so
// clients build channelConfig.receiverAuthorizer correctly. Without this fallback
// the delegated mode produced channelId mismatches and onchain deposit reverts.
func TestEnhancePaymentRequirements_FallsBackToFacilitatorAuthorizerInDelegatedMode(t *testing.T) {
	// No ReceiverAuthorizerSigner configured — delegated to facilitator.
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	req := types.PaymentRequirements{
		Network: "eip155:8453",
		Asset:   "0x1234567890abcdef1234567890abcdef12345678",
		Amount:  "1000",
	}
	supported := types.SupportedKind{
		Extra: map[string]interface{}{
			"receiverAuthorizer": "0xCFA51eEAF6B2831d2A7e09829477E88154647cbB",
		},
	}
	out, err := s.EnhancePaymentRequirements(context.Background(), req, supported, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := out.Extra["receiverAuthorizer"].(string)
	if got != "0xCFA51eEAF6B2831d2A7e09829477E88154647cbB" {
		t.Fatalf("expected facilitator authorizer to be surfaced, got %q", got)
	}
}

// Local signer must take precedence over the facilitator-advertised authorizer.
func TestEnhancePaymentRequirements_LocalAuthorizerWinsOverFacilitator(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xLocalAuth"}
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{ReceiverAuthorizerSigner: auth})
	req := types.PaymentRequirements{
		Network: "eip155:8453",
		Asset:   "0x1234567890abcdef1234567890abcdef12345678",
		Amount:  "1000",
	}
	supported := types.SupportedKind{
		Extra: map[string]interface{}{"receiverAuthorizer": "0xFacilitator"},
	}
	out, err := s.EnhancePaymentRequirements(context.Background(), req, supported, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got := out.Extra["receiverAuthorizer"]; got != "0xLocalAuth" {
		t.Fatalf("local signer should win, got %v", got)
	}
}

// Routes can set `extra.assetTransferMethod = "permit2"` on the accept config to
// switch the deposit transport. EnhancePaymentRequirements must pass it
// through unchanged so the client picks the right deposit signer.
func TestEnhancePaymentRequirements_PassesThroughAssetTransferMethod(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	req := types.PaymentRequirements{
		Network: "eip155:8453",
		Asset:   "0x1234567890abcdef1234567890abcdef12345678",
		Amount:  "1000",
		Extra: map[string]interface{}{
			"assetTransferMethod": "permit2",
			"receiverAuthorizer":  "0x4444444444444444444444444444444444444444",
		},
	}
	out, err := s.EnhancePaymentRequirements(context.Background(), req, types.SupportedKind{}, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got, _ := out.Extra["assetTransferMethod"].(string); got != "permit2" {
		t.Fatalf("expected assetTransferMethod=permit2 to pass through, got %q", got)
	}
}

func TestEnhancePaymentRequirements_DecimalAmountNormalized(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	req := types.PaymentRequirements{
		Network: "eip155:8453",
		Asset:   "0x1234567890abcdef1234567890abcdef12345678",
		Amount:  "1.5",
		Extra: map[string]interface{}{
			"receiverAuthorizer": "0x4444444444444444444444444444444444444444",
		},
	}
	out, err := s.EnhancePaymentRequirements(context.Background(), req, types.SupportedKind{}, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if out.Amount == "1.5" {
		t.Fatalf("amount not normalized: %s", out.Amount)
	}
}

// Rejects requirements when neither the server nor facilitator provides receiverAuthorizer.
func TestEnhancePaymentRequirements_RejectsMissingReceiverAuthorizer(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	req := types.PaymentRequirements{
		Network: "eip155:8453",
		Asset:   "0x1234567890abcdef1234567890abcdef12345678",
		Amount:  "100",
	}
	if _, err := s.EnhancePaymentRequirements(context.Background(), req, types.SupportedKind{}, nil); err == nil {
		t.Fatalf("expected error when receiverAuthorizer is unavailable")
	}
}

func TestSignRefund_NoSignerErrors(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	_, err := s.SignRefund(context.Background(), "0xabcd", "100", "1", "eip155:8453")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSignRefund_BadNetwork(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", sig: []byte{0x01}}
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{ReceiverAuthorizerSigner: auth})
	_, err := s.SignRefund(context.Background(), "0xabcd", "100", "1", "not-a-network")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSignRefund_BadAmount(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", sig: []byte{0x01}}
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{ReceiverAuthorizerSigner: auth})
	_, err := s.SignRefund(context.Background(), "0xabcd", "not-a-number", "1", "eip155:8453")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSignRefund_BadNonce(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", sig: []byte{0x01}}
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{ReceiverAuthorizerSigner: auth})
	_, err := s.SignRefund(context.Background(), "0xabcd", "100", "not-a-number", "eip155:8453")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSignRefund_BadChannelId(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", sig: []byte{0x01}}
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{ReceiverAuthorizerSigner: auth})
	_, err := s.SignRefund(context.Background(), "not-hex", "100", "1", "eip155:8453")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSignRefund_OK(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", sig: []byte{0xde, 0xad}}
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{ReceiverAuthorizerSigner: auth})
	sig, err := s.SignRefund(context.Background(), "0xabcd", "100", "1", "eip155:8453")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(sig) != 2 || sig[0] != 0xde {
		t.Fatalf("sig = %x", sig)
	}
	if auth.calls != 1 {
		t.Fatalf("calls = %d", auth.calls)
	}
}

func TestSignRefund_PropagatesSignerError(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", err: errors.New("kms down")}
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{ReceiverAuthorizerSigner: auth})
	_, err := s.SignRefund(context.Background(), "0xabcd", "100", "1", "eip155:8453")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSignClaimBatch_NoSignerErrors(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	_, err := s.SignClaimBatch(context.Background(), nil, "eip155:8453")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSignClaimBatch_BadNetwork(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", sig: []byte{0x01}}
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{ReceiverAuthorizerSigner: auth})
	_, err := s.SignClaimBatch(context.Background(), nil, "not-a-network")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSignClaimBatch_OK(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", sig: []byte{0xbe, 0xef}}
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{ReceiverAuthorizerSigner: auth})
	claim := batchsettlement.BatchSettlementVoucherClaim{Signature: "0xsig", TotalClaimed: "0"}
	claim.Voucher.Channel = batchsettlement.ChannelConfig{
		Payer:              "0x1111111111111111111111111111111111111111",
		PayerAuthorizer:    "0x2222222222222222222222222222222222222222",
		Receiver:           "0x3333333333333333333333333333333333333333",
		ReceiverAuthorizer: "0xauth",
		Token:              "0x5555555555555555555555555555555555555555",
		WithdrawDelay:      900,
		Salt:               "0x01",
	}
	claim.Voucher.MaxClaimableAmount = "100"
	sig, err := s.SignClaimBatch(context.Background(), []batchsettlement.BatchSettlementVoucherClaim{claim}, "eip155:8453")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(sig) != 2 || sig[1] != 0xef {
		t.Fatalf("sig = %x", sig)
	}
}

func TestSession_RoundTrip_CaseInsensitive(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	in := sampleSession("0xABCD", "10")
	if err := s.UpdateSession("0xABCD", in); err != nil {
		t.Fatalf("update: %v", err)
	}
	got, err := s.GetSession("0xabcd")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got == nil || got.ChannelId != "0xABCD" {
		t.Fatalf("got %+v", got)
	}
	if err := s.DeleteSession("0XABCD"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if got2, _ := s.GetSession("0xabcd"); got2 != nil {
		t.Fatalf("expected nil after delete")
	}
}

func TestGetAssetDecimals_DefaultsTo6(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	if got := s.GetAssetDecimals("0xunknown", x402.Network("nope")); got != 6 {
		t.Fatalf("got %d", got)
	}
}

func TestCreateChannelManager_NotNil(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	cm := s.CreateChannelManager(nil, x402.Network("eip155:8453"))
	if cm == nil {
		t.Fatal("expected non-nil manager")
	}
}

func TestParseMoneyToDecimal_AllNumericTypes(t *testing.T) {
	cases := []struct {
		in   x402.Price
		want float64
	}{
		{"1.5", 1.5},
		{"$2.25", 2.25},
		{float64(3.5), 3.5},
		{int(4), 4.0},
		{int64(5), 5.0},
	}
	for _, c := range cases {
		got, err := parseMoneyToDecimal(c.in)
		if err != nil {
			t.Fatalf("err on %v: %v", c.in, err)
		}
		if got != c.want {
			t.Fatalf("got %v, want %v for %v", got, c.want, c.in)
		}
	}
}

func TestParseMoneyToDecimal_BadString(t *testing.T) {
	if _, err := parseMoneyToDecimal("nope"); err == nil {
		t.Fatal("expected error")
	}
}

func TestParseMoneyToDecimal_UnsupportedType(t *testing.T) {
	if _, err := parseMoneyToDecimal(big.NewInt(1)); err == nil {
		t.Fatal("expected error")
	}
}

func nowMs() int64 {
	return int64(1) << 50 // far in the future, simulates "very recent"
}

// ----- Snapshot + EnrichPaymentRequiredResponse -----

func makeBatchedPayload(channelId string) *types.PaymentPayload {
	return &types.PaymentPayload{
		X402Version: 2,
		Payload: map[string]interface{}{
			"type": "voucher",
			"voucher": map[string]interface{}{
				"channelId":          channelId,
				"maxClaimableAmount": "100",
				"signature":          "0xsig",
			},
		},
		Accepted: types.PaymentRequirements{
			Scheme:  batchsettlement.SchemeBatched,
			Network: "eip155:8453",
		},
	}
}

// enrich is a test helper that invokes EnrichPaymentRequiredResponse with a
// minimal context, mutating reqs in place and returning the same slice for
// chained assertions.
func enrich(s *BatchSettlementEvmScheme, pp *types.PaymentPayload, errReason string, reqs []types.PaymentRequirements) []types.PaymentRequirements {
	s.EnrichPaymentRequiredResponse(x402.PaymentRequiredContext{
		Requirements:   reqs,
		PaymentPayload: pp,
		Error:          errReason,
	})
	return reqs
}

func TestRememberAndTakeChannelSnapshot_RoundTrip(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	pp := makeBatchedPayload("0xabcd")
	sess := sampleSession("0xabcd", "10")

	s.RememberChannelSnapshot(pp, sess)
	got := s.TakeChannelSnapshot(pp)
	if got != sess {
		t.Fatalf("expected snapshot back, got %+v", got)
	}
	// Second take returns nil (snapshot consumed).
	if got2 := s.TakeChannelSnapshot(pp); got2 != nil {
		t.Fatalf("expected nil after take, got %+v", got2)
	}
}

func TestRememberChannelSnapshot_NilInputsAreNoOp(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	pp := makeBatchedPayload("0xabcd")
	s.RememberChannelSnapshot(nil, sampleSession("0xabcd", "10"))
	s.RememberChannelSnapshot(pp, nil)
	if got := s.TakeChannelSnapshot(pp); got != nil {
		t.Fatalf("expected nil snapshot, got %+v", got)
	}
	if got := s.TakeChannelSnapshot(nil); got != nil {
		t.Fatalf("expected nil for nil payload")
	}
}

func TestEnrichPaymentRequiredResponse_WrongReasonNoOp(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	pp := makeBatchedPayload("0xabcd")
	s.RememberChannelSnapshot(pp, sampleSession("0xabcd", "10"))
	reqs := enrich(s, pp, "some_other_reason",
		[]types.PaymentRequirements{{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"}})
	if reqs[0].Extra != nil {
		t.Fatalf("expected no enrichment, got %+v", reqs[0].Extra)
	}
}

func TestEnrichPaymentRequiredResponse_NilPayloadNoOp(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	reqs := enrich(s, nil, batchsettlement.ErrCumulativeAmountMismatch,
		[]types.PaymentRequirements{{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"}})
	if reqs[0].Extra != nil {
		t.Fatalf("expected no enrichment, got %+v", reqs[0].Extra)
	}
}

func TestEnrichPaymentRequiredResponse_FromSnapshot(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	pp := makeBatchedPayload("0xabcd")
	s.RememberChannelSnapshot(pp, sampleSession("0xabcd", "42"))

	reqs := enrich(s, pp, batchsettlement.ErrCumulativeAmountMismatch,
		[]types.PaymentRequirements{{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"}})

	channelState, ok := reqs[0].Extra["channelState"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected channelState map, got %+v", reqs[0].Extra)
	}
	if channelState["channelId"] != "0xabcd" {
		t.Fatalf("channelId = %v", channelState["channelId"])
	}
	if channelState["chargedCumulativeAmount"] != "42" {
		t.Fatalf("chargedCumulativeAmount = %v", channelState["chargedCumulativeAmount"])
	}
	if channelState["balance"] == "" {
		t.Fatalf("expected balance present, got %+v", channelState)
	}
	voucherState, ok := reqs[0].Extra["voucherState"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected voucherState map, got %+v", reqs[0].Extra)
	}
	if voucherState["signedMaxClaimable"] != "1000" {
		t.Fatalf("signedMaxClaimable = %v", voucherState["signedMaxClaimable"])
	}
	if voucherState["signature"] != "0xsig" {
		t.Fatalf("signature = %v", voucherState["signature"])
	}
	// Snapshot should be consumed.
	if got := s.TakeChannelSnapshot(pp); got != nil {
		t.Fatalf("expected snapshot consumed")
	}
}

func TestEnrichPaymentRequiredResponse_FallsBackToStorage(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	pp := makeBatchedPayload("0xabcd")
	_ = s.UpdateSession("0xabcd", sampleSession("0xabcd", "77"))

	reqs := enrich(s, pp, batchsettlement.ErrCumulativeAmountMismatch,
		[]types.PaymentRequirements{{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"}})

	state, ok := reqs[0].Extra["channelState"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected channelState map from storage fallback, got %+v", reqs[0].Extra)
	}
	if state["chargedCumulativeAmount"] != "77" {
		t.Fatalf("chargedCumulativeAmount = %v", state["chargedCumulativeAmount"])
	}
}

func TestEnrichPaymentRequiredResponse_NoSessionNoOp(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	pp := makeBatchedPayload("0xabcd")
	reqs := enrich(s, pp, batchsettlement.ErrCumulativeAmountMismatch,
		[]types.PaymentRequirements{{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"}})
	if reqs[0].Extra != nil {
		t.Fatalf("expected no enrichment without session, got %+v", reqs[0].Extra)
	}
}

func TestEnrichPaymentRequiredResponse_SkipsNonBatchedAndMismatchedNetwork(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	pp := makeBatchedPayload("0xabcd")
	s.RememberChannelSnapshot(pp, sampleSession("0xabcd", "10"))

	reqs := enrich(s, pp, batchsettlement.ErrCumulativeAmountMismatch, []types.PaymentRequirements{
		{Scheme: "exact", Network: "eip155:8453"},
		{Scheme: batchsettlement.SchemeBatched, Network: "eip155:1"},
		{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"},
	})

	if reqs[0].Extra != nil {
		t.Fatalf("non-batched req should not be enriched: %+v", reqs[0].Extra)
	}
	if reqs[1].Extra != nil {
		t.Fatalf("network-mismatch req should not be enriched: %+v", reqs[1].Extra)
	}
	if _, ok := reqs[2].Extra["channelState"]; !ok {
		t.Fatalf("matching req should be enriched: %+v", reqs[2].Extra)
	}
}

func TestEnrichPaymentRequiredResponse_MissingChannelIdNoOp(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", nil)
	pp := &types.PaymentPayload{
		X402Version: 2,
		Payload:     map[string]interface{}{"type": "voucher"},
		Accepted:    types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"},
	}
	reqs := enrich(s, pp, batchsettlement.ErrCumulativeAmountMismatch,
		[]types.PaymentRequirements{{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"}})
	if reqs[0].Extra != nil {
		t.Fatalf("expected no enrichment without channelId, got %+v", reqs[0].Extra)
	}
}

func TestExtractChannelIdFromPayload(t *testing.T) {
	if got := extractChannelIdFromPayload(nil); got != "" {
		t.Fatalf("nil payload: got %q", got)
	}
	if got := extractChannelIdFromPayload(map[string]interface{}{}); got != "" {
		t.Fatalf("missing voucher: got %q", got)
	}
	if got := extractChannelIdFromPayload(map[string]interface{}{"voucher": "not-a-map"}); got != "" {
		t.Fatalf("voucher non-map: got %q", got)
	}
	if got := extractChannelIdFromPayload(map[string]interface{}{
		"voucher": map[string]interface{}{"channelId": 123},
	}); got != "" {
		t.Fatalf("channelId non-string: got %q", got)
	}
	if got := extractChannelIdFromPayload(map[string]interface{}{
		"voucher": map[string]interface{}{"channelId": "0xabcd"},
	}); got != "0xabcd" {
		t.Fatalf("got %q", got)
	}
}
