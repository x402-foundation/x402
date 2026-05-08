package client

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/types"
)

// ---------- normalizeRefundAmount ----------

func TestNormalizeRefundAmount(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"", "", false},
		{"1", "1", false},
		{"1000000", "1000000", false},
		{"0", "", true},
		{"-1", "", true},
		{"1.5", "", true},
		{"abc", "", true},
		{"  10  ", "", true},
	}
	for _, tc := range cases {
		got, err := normalizeRefundAmount(tc.in)
		if (err != nil) != tc.wantErr {
			t.Fatalf("normalizeRefundAmount(%q): err=%v wantErr=%v", tc.in, err, tc.wantErr)
		}
		if !tc.wantErr && got != tc.want {
			t.Fatalf("normalizeRefundAmount(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// ---------- encodePaymentSignatureHeader ----------

func TestEncodePaymentSignatureHeader_RoundTrip(t *testing.T) {
	payload := &types.PaymentPayload{
		X402Version: 2,
		Payload:     map[string]interface{}{"k": "v"},
	}
	accepted := types.PaymentRequirements{Scheme: "batch-settlement", Network: "eip155:8453"}

	out, err := encodePaymentSignatureHeader(payload, accepted)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(out)
	if err != nil {
		t.Fatalf("not base64: %v", err)
	}
	var envelope map[string]interface{}
	if err := json.Unmarshal(decoded, &envelope); err != nil {
		t.Fatalf("not json: %v", err)
	}
	if envelope["x402Version"].(float64) != 2 {
		t.Fatalf("version = %v", envelope["x402Version"])
	}
	if envelope["payload"].(map[string]interface{})["k"] != "v" {
		t.Fatalf("payload not preserved: %v", envelope["payload"])
	}
}

// ---------- decode helpers ----------

func TestDecodePaymentRequiredHeader(t *testing.T) {
	pr := x402.PaymentRequired{
		X402Version: 2,
		Error:       "boom",
		Accepts:     []types.PaymentRequirements{{Scheme: "batch-settlement"}},
	}
	raw, _ := json.Marshal(pr)
	encoded := base64.StdEncoding.EncodeToString(raw)
	got, err := decodePaymentRequiredHeader(" " + encoded + " ")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got.Error != "boom" || len(got.Accepts) != 1 {
		t.Fatalf("decoded = %+v", got)
	}
}

func TestDecodePaymentRequiredHeader_BadBase64(t *testing.T) {
	if _, err := decodePaymentRequiredHeader("!!!not-base64!!!"); err == nil {
		t.Fatal("expected error")
	}
}

func TestDecodePaymentRequiredHeader_BadJSON(t *testing.T) {
	garbage := base64.StdEncoding.EncodeToString([]byte("not json{"))
	if _, err := decodePaymentRequiredHeader(garbage); err == nil {
		t.Fatal("expected error")
	}
}

func TestDecodePaymentResponseHeader(t *testing.T) {
	settle := x402.SettleResponse{Success: true, Transaction: "0xabc"}
	raw, _ := json.Marshal(settle)
	encoded := base64.StdEncoding.EncodeToString(raw)
	got, err := decodePaymentResponseHeader(encoded)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !got.Success || got.Transaction != "0xabc" {
		t.Fatalf("decoded = %+v", got)
	}
}

func TestDecodePaymentResponseHeader_Errors(t *testing.T) {
	if _, err := decodePaymentResponseHeader("!!!"); err == nil {
		t.Fatal("expected base64 error")
	}
	bad := base64.StdEncoding.EncodeToString([]byte("not json{"))
	if _, err := decodePaymentResponseHeader(bad); err == nil {
		t.Fatal("expected json error")
	}
}

// ---------- UpdateSessionAfterRefund ----------

func TestUpdateSessionAfterRefund_FullRefundDeletes(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	_ = storage.Set("ch", &BatchSettlementClientContext{Balance: "100"})
	err := UpdateSessionAfterRefund(storage, "ch", map[string]interface{}{"balance": "0"})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got, _ := storage.Get("ch"); got != nil {
		t.Fatalf("session not deleted: %+v", got)
	}
}

func TestUpdateSessionAfterRefund_MissingBalanceDeletes(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	_ = storage.Set("ch", &BatchSettlementClientContext{Balance: "100"})
	err := UpdateSessionAfterRefund(storage, "ch", map[string]interface{}{})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got, _ := storage.Get("ch"); got != nil {
		t.Fatalf("session not deleted: %+v", got)
	}
}

func TestUpdateSessionAfterRefund_PartialRefundUpdates(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	_ = storage.Set("ch", &BatchSettlementClientContext{
		Balance:                 "1000",
		ChargedCumulativeAmount: "100",
		TotalClaimed:            "100",
		Signature:               "0xsig",
	})
	err := UpdateSessionAfterRefund(storage, "ch", map[string]interface{}{
		"channelState": map[string]interface{}{
			"balance":                 "500",
			"chargedCumulativeAmount": "200",
			"totalClaimed":            "150",
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get("ch")
	if got == nil {
		t.Fatal("session deleted but should be retained")
	}
	if got.Balance != "500" || got.ChargedCumulativeAmount != "200" || got.TotalClaimed != "150" {
		t.Fatalf("not updated: %+v", got)
	}
	if got.Signature != "0xsig" {
		t.Fatalf("signature lost: %q", got.Signature)
	}
}

func TestUpdateSessionAfterRefund_NoPriorSessionPartial(t *testing.T) {
	storage := NewInMemoryClientChannelStorage()
	err := UpdateSessionAfterRefund(storage, "ch", map[string]interface{}{
		"channelState": map[string]interface{}{
			"balance":                 "500",
			"chargedCumulativeAmount": "10",
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := storage.Get("ch")
	if got == nil || got.Balance != "500" {
		t.Fatalf("session not seeded: %+v", got)
	}
}

// ---------- probeRefundRequirements (HTTP) ----------

func TestProbeRefundRequirements_Non402(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	if _, err := probeRefundRequirements(context.Background(), srv.URL, http.DefaultClient); err == nil {
		t.Fatal("expected error")
	}
}

func TestProbeRefundRequirements_MissingHeader(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusPaymentRequired)
	}))
	defer srv.Close()
	if _, err := probeRefundRequirements(context.Background(), srv.URL, http.DefaultClient); err == nil {
		t.Fatal("expected error")
	}
}

func TestProbeRefundRequirements_NoBatchedScheme(t *testing.T) {
	pr := x402.PaymentRequired{Accepts: []types.PaymentRequirements{{Scheme: "exact"}}}
	raw, _ := json.Marshal(pr)
	header := base64.StdEncoding.EncodeToString(raw)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("PAYMENT-REQUIRED", header)
		w.WriteHeader(http.StatusPaymentRequired)
	}))
	defer srv.Close()
	if _, err := probeRefundRequirements(context.Background(), srv.URL, http.DefaultClient); err == nil {
		t.Fatal("expected error: no batched scheme")
	}
}

func TestProbeRefundRequirements_MissingReceiverAuthorizer(t *testing.T) {
	pr := x402.PaymentRequired{Accepts: []types.PaymentRequirements{{Scheme: batchsettlement.SchemeBatched}}}
	raw, _ := json.Marshal(pr)
	header := base64.StdEncoding.EncodeToString(raw)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("PAYMENT-REQUIRED", header)
		w.WriteHeader(http.StatusPaymentRequired)
	}))
	defer srv.Close()
	if _, err := probeRefundRequirements(context.Background(), srv.URL, http.DefaultClient); err == nil {
		t.Fatal("expected error: missing receiverAuthorizer")
	}
}

func TestProbeRefundRequirements_OK(t *testing.T) {
	pr := x402.PaymentRequired{
		Accepts: []types.PaymentRequirements{{
			Scheme: batchsettlement.SchemeBatched,
			Extra:  map[string]interface{}{"receiverAuthorizer": "0x1"},
		}},
	}
	raw, _ := json.Marshal(pr)
	header := base64.StdEncoding.EncodeToString(raw)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("PAYMENT-REQUIRED", header)
		w.WriteHeader(http.StatusPaymentRequired)
	}))
	defer srv.Close()
	got, err := probeRefundRequirements(context.Background(), srv.URL, http.DefaultClient)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got.Scheme != batchsettlement.SchemeBatched {
		t.Fatalf("scheme = %q", got.Scheme)
	}
}

func TestProbeRefundRequirements_BadHeader(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("PAYMENT-REQUIRED", "!!!")
		w.WriteHeader(http.StatusPaymentRequired)
	}))
	defer srv.Close()
	if _, err := probeRefundRequirements(context.Background(), srv.URL, http.DefaultClient); err == nil {
		t.Fatal("expected decode error")
	}
}

// ---------- buildRefundVoucherPayload via stub RefundContext ----------

type fakeRefundContext struct {
	storage       *InMemoryClientChannelStorage
	signer        *mockSigner
	voucherSigner *mockSigner
	config        batchsettlement.ChannelConfig
	recoverErr    error
	recovered     *BatchSettlementClientContext
}

func (f *fakeRefundContext) Storage() ClientChannelStorage { return f.storage }
func (f *fakeRefundContext) Signer() evm.ClientEvmSigner   { return f.signer }
func (f *fakeRefundContext) VoucherSigner() evm.ClientEvmSigner {
	if f.voucherSigner == nil {
		return nil
	}
	return f.voucherSigner
}
func (f *fakeRefundContext) BuildChannelConfig(_ types.PaymentRequirements) (batchsettlement.ChannelConfig, error) {
	return f.config, nil
}
func (f *fakeRefundContext) RecoverSession(_ context.Context, _ types.PaymentRequirements) (*BatchSettlementClientContext, error) {
	if f.recoverErr != nil {
		return nil, f.recoverErr
	}
	if f.recovered != nil {
		_ = f.storage.Set("recovered", f.recovered)
	}
	return f.recovered, nil
}
func (f *fakeRefundContext) ProcessSettleResponse(_ map[string]interface{}) error { return nil }
func (f *fakeRefundContext) ProcessCorrectivePaymentRequired(_ context.Context, _ string, _ []types.PaymentRequirements) (bool, error) {
	return false, nil
}

func defaultConfig() batchsettlement.ChannelConfig {
	return batchsettlement.ChannelConfig{
		Payer:              "0x1111111111111111111111111111111111111111",
		PayerAuthorizer:    "0x2222222222222222222222222222222222222222",
		Receiver:           "0x3333333333333333333333333333333333333333",
		ReceiverAuthorizer: "0x4444444444444444444444444444444444444444",
		Token:              "0x5555555555555555555555555555555555555555",
		WithdrawDelay:      900,
		Salt:               "0x01",
	}
}

func TestBuildRefundVoucherPayload_NoSession(t *testing.T) {
	fctx := &fakeRefundContext{
		storage: NewInMemoryClientChannelStorage(),
		signer:  &mockSigner{address: "0x1"},
		config:  defaultConfig(),
	}
	_, err := buildRefundVoucherPayload(context.Background(), fctx, types.PaymentRequirements{Network: "eip155:8453"}, "")
	if err == nil || !strings.Contains(err.Error(), "existing channel session") {
		t.Fatalf("expected missing-session error, got %v", err)
	}
}

func TestBuildRefundVoucherPayload_HasSession(t *testing.T) {
	channelId, err := batchsettlement.ComputeChannelId(defaultConfig(), "eip155:8453")
	if err != nil {
		t.Fatalf("compute: %v", err)
	}
	storage := NewInMemoryClientChannelStorage()
	_ = storage.Set(batchsettlement.NormalizeChannelId(channelId), &BatchSettlementClientContext{
		ChargedCumulativeAmount: "200",
	})

	fctx := &fakeRefundContext{
		storage: storage,
		signer:  &mockSigner{address: "0x1", sig: []byte{0x99}},
		config:  defaultConfig(),
	}
	payload, err := buildRefundVoucherPayload(context.Background(), fctx, types.PaymentRequirements{Network: "eip155:8453"}, "100")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	body := payload.Payload
	if body["type"] != "refund" || body["amount"] != "100" {
		t.Fatalf("payload = %+v", body)
	}
	voucherMap, _ := body["voucher"].(map[string]interface{})
	if voucherMap == nil || voucherMap["maxClaimableAmount"] != "200" {
		t.Fatalf("expected charged echoed back as max, got %v", body["voucher"])
	}
}

func TestBuildRefundVoucherPayload_DefaultsChargedZero(t *testing.T) {
	channelId, _ := batchsettlement.ComputeChannelId(defaultConfig(), "eip155:8453")
	storage := NewInMemoryClientChannelStorage()
	_ = storage.Set(batchsettlement.NormalizeChannelId(channelId), &BatchSettlementClientContext{})

	fctx := &fakeRefundContext{
		storage: storage,
		signer:  &mockSigner{address: "0x1", sig: []byte{0x88}},
		config:  defaultConfig(),
	}
	payload, err := buildRefundVoucherPayload(context.Background(), fctx, types.PaymentRequirements{Network: "eip155:8453"}, "")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	voucherMap, _ := payload.Payload["voucher"].(map[string]interface{})
	if voucherMap == nil || voucherMap["maxClaimableAmount"] != "0" {
		t.Fatalf("expected voucher.maxClaimableAmount=0, got %v", payload.Payload["voucher"])
	}
}

func TestBuildRefundVoucherPayload_SignerError(t *testing.T) {
	channelId, _ := batchsettlement.ComputeChannelId(defaultConfig(), "eip155:8453")
	storage := NewInMemoryClientChannelStorage()
	_ = storage.Set(batchsettlement.NormalizeChannelId(channelId), &BatchSettlementClientContext{ChargedCumulativeAmount: "1"})

	fctx := &fakeRefundContext{
		storage: storage,
		signer:  &mockSigner{address: "0x1", err: errors.New("kms down")},
		config:  defaultConfig(),
	}
	if _, err := buildRefundVoucherPayload(context.Background(), fctx, types.PaymentRequirements{Network: "eip155:8453"}, ""); err == nil {
		t.Fatal("expected signer error")
	}
}

// ---------- RefundChannel end-to-end (light) ----------

func TestRefundChannel_BadAmount(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusPaymentRequired)
	}))
	defer srv.Close()

	fctx := &fakeRefundContext{
		storage: NewInMemoryClientChannelStorage(),
		signer:  &mockSigner{address: "0x1"},
		config:  defaultConfig(),
	}
	_, err := RefundChannel(context.Background(), fctx, srv.URL, &RefundOptions{Amount: "abc"})
	if err == nil {
		t.Fatal("expected amount validation error")
	}
}

func TestRefundChannel_ProbeFailure(t *testing.T) {
	// Server returns 500 — probe fails.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	fctx := &fakeRefundContext{
		storage: NewInMemoryClientChannelStorage(),
		signer:  &mockSigner{address: "0x1"},
		config:  defaultConfig(),
	}
	_, err := RefundChannel(context.Background(), fctx, srv.URL, nil)
	if err == nil {
		t.Fatal("expected probe error")
	}
}

// ---------- formatRefundFailure ----------

func TestFormatRefundFailure_NilSettle(t *testing.T) {
	got := formatRefundFailure(nil)
	if !strings.Contains(got, "unknown_settlement_error") {
		t.Fatalf("got %q", got)
	}
}

func TestFormatRefundFailure_ReasonOnly(t *testing.T) {
	got := formatRefundFailure(&x402.SettleResponse{ErrorReason: "boom"})
	if got != "Refund failed: boom" {
		t.Fatalf("got %q", got)
	}
}

func TestFormatRefundFailure_ReasonAndMessage(t *testing.T) {
	got := formatRefundFailure(&x402.SettleResponse{ErrorReason: "boom", ErrorMessage: "details"})
	if got != "Refund failed: boom: details" {
		t.Fatalf("got %q", got)
	}
}

func TestFormatRefundFailure_DropsDuplicateMessage(t *testing.T) {
	// When errorMessage == errorReason, don't duplicate.
	got := formatRefundFailure(&x402.SettleResponse{ErrorReason: "same", ErrorMessage: "same"})
	if got != "Refund failed: same" {
		t.Fatalf("got %q", got)
	}
}

func TestFormatRefundFailure_EmptyDefaults(t *testing.T) {
	got := formatRefundFailure(&x402.SettleResponse{})
	if !strings.Contains(got, "unknown_settlement_error") {
		t.Fatalf("got %q", got)
	}
}

// ---------- buildRefundVoucherPayload — drained channel short-circuit ----------

func TestBuildRefundVoucherPayload_DrainedChannelShortCircuits(t *testing.T) {
	channelId, _ := batchsettlement.ComputeChannelId(defaultConfig(), "eip155:8453")
	storage := NewInMemoryClientChannelStorage()
	_ = storage.Set(batchsettlement.NormalizeChannelId(channelId), &BatchSettlementClientContext{
		Balance:                 "100",
		ChargedCumulativeAmount: "100", // balance <= charged → drained
	})

	fctx := &fakeRefundContext{
		storage: storage,
		signer:  &mockSigner{address: "0x1", sig: []byte{0x77}},
		config:  defaultConfig(),
	}
	_, err := buildRefundVoucherPayload(context.Background(), fctx, types.PaymentRequirements{Network: "eip155:8453"}, "")
	if err == nil || !strings.Contains(err.Error(), "no remaining balance") {
		t.Fatalf("expected drained-channel error, got %v", err)
	}
}

func TestBuildRefundVoucherPayload_PartiallyDrainedProceeds(t *testing.T) {
	channelId, _ := batchsettlement.ComputeChannelId(defaultConfig(), "eip155:8453")
	storage := NewInMemoryClientChannelStorage()
	_ = storage.Set(batchsettlement.NormalizeChannelId(channelId), &BatchSettlementClientContext{
		Balance:                 "1000",
		ChargedCumulativeAmount: "100", // 1000 > 100 → has remainder
	})

	fctx := &fakeRefundContext{
		storage: storage,
		signer:  &mockSigner{address: "0x1", sig: []byte{0x77}},
		config:  defaultConfig(),
	}
	_, err := buildRefundVoucherPayload(context.Background(), fctx, types.PaymentRequirements{Network: "eip155:8453"}, "")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
}

func TestBuildRefundVoucherPayload_EmptyBalanceBypassesShortCircuit(t *testing.T) {
	// session.balance == "" → can't compare → don't short-circuit.
	channelId, _ := batchsettlement.ComputeChannelId(defaultConfig(), "eip155:8453")
	storage := NewInMemoryClientChannelStorage()
	_ = storage.Set(batchsettlement.NormalizeChannelId(channelId), &BatchSettlementClientContext{
		ChargedCumulativeAmount: "100",
	})

	fctx := &fakeRefundContext{
		storage: storage,
		signer:  &mockSigner{address: "0x1", sig: []byte{0x77}},
		config:  defaultConfig(),
	}
	if _, err := buildRefundVoucherPayload(context.Background(), fctx, types.PaymentRequirements{Network: "eip155:8453"}, ""); err != nil {
		t.Fatalf("err: %v", err)
	}
}

// ---------- executeRefund — 402 PAYMENT-RESPONSE handling ----------

// fakeRefundContextWithSession is a refund context that pre-seeds a session for the
// channel computed from defaultConfig() so executeRefund can reach the network.
func fakeRefundContextWithSession(charged string) *fakeRefundContext {
	channelId, _ := batchsettlement.ComputeChannelId(defaultConfig(), "eip155:8453")
	storage := NewInMemoryClientChannelStorage()
	_ = storage.Set(batchsettlement.NormalizeChannelId(channelId), &BatchSettlementClientContext{
		Balance:                 "10000",
		ChargedCumulativeAmount: charged,
	})
	return &fakeRefundContext{
		storage: storage,
		signer:  &mockSigner{address: "0x1", sig: []byte{0xaa}},
		config:  defaultConfig(),
	}
}

func TestExecuteRefund_402WithPaymentResponseFailsFast(t *testing.T) {
	// Settle-side abort: server returns 402 + PAYMENT-RESPONSE → no retry, fail with formatted reason.
	settle := x402.SettleResponse{
		Success:      false,
		ErrorReason:  batchsettlement.ErrRefundNoBalance,
		ErrorMessage: "Channel drained",
	}
	settleBytes, _ := json.Marshal(settle)
	settleHeader := base64.StdEncoding.EncodeToString(settleBytes)

	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.Header().Set("PAYMENT-RESPONSE", settleHeader)
		w.WriteHeader(http.StatusPaymentRequired)
	}))
	defer srv.Close()

	fctx := fakeRefundContextWithSession("100")
	_, err := executeRefund(context.Background(), fctx, srv.URL,
		types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"},
		"", http.DefaultClient)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), batchsettlement.ErrRefundNoBalance) {
		t.Fatalf("got %v", err)
	}
	if !strings.Contains(err.Error(), "Channel drained") {
		t.Fatalf("expected message in error, got %v", err)
	}
	if calls != 1 {
		t.Fatalf("expected fail-fast (1 call), got %d", calls)
	}
}

func TestExecuteRefund_402WithBadPaymentResponseHeader(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("PAYMENT-RESPONSE", "!!!not-base64!!!")
		w.WriteHeader(http.StatusPaymentRequired)
	}))
	defer srv.Close()
	fctx := fakeRefundContextWithSession("100")
	_, err := executeRefund(context.Background(), fctx, srv.URL,
		types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"},
		"", http.DefaultClient)
	if err == nil || !strings.Contains(err.Error(), "decode PAYMENT-RESPONSE") {
		t.Fatalf("got %v", err)
	}
}

func TestExecuteRefund_NonRecoverableErrorFailsFast(t *testing.T) {
	// Verify-side abort with a known non-recoverable error code: don't retry.
	pr := x402.PaymentRequired{Error: batchsettlement.ErrRefundAmountInvalid}
	prBytes, _ := json.Marshal(pr)
	prHeader := base64.StdEncoding.EncodeToString(prBytes)

	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.Header().Set("PAYMENT-REQUIRED", prHeader)
		w.WriteHeader(http.StatusPaymentRequired)
	}))
	defer srv.Close()

	fctx := fakeRefundContextWithSession("100")
	_, err := executeRefund(context.Background(), fctx, srv.URL,
		types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"},
		"", http.DefaultClient)
	if err == nil || !strings.Contains(err.Error(), batchsettlement.ErrRefundAmountInvalid) {
		t.Fatalf("got %v", err)
	}
	if calls != 1 {
		t.Fatalf("expected fail-fast (1 call), got %d", calls)
	}
}

func TestExecuteRefund_RecoverableErrorRetriesAndExhausts(t *testing.T) {
	// Recoverable error code (not in non-recoverable set) but recovery returns false → fail with reason.
	pr := x402.PaymentRequired{Error: "some_recoverable_thing"}
	prBytes, _ := json.Marshal(pr)
	prHeader := base64.StdEncoding.EncodeToString(prBytes)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("PAYMENT-REQUIRED", prHeader)
		w.WriteHeader(http.StatusPaymentRequired)
	}))
	defer srv.Close()

	fctx := fakeRefundContextWithSession("100")
	_, err := executeRefund(context.Background(), fctx, srv.URL,
		types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"},
		"", http.DefaultClient)
	if err == nil || !strings.Contains(err.Error(), "some_recoverable_thing") {
		t.Fatalf("got %v", err)
	}
}

func TestExecuteRefund_402MissingHeadersErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusPaymentRequired)
	}))
	defer srv.Close()

	fctx := fakeRefundContextWithSession("100")
	_, err := executeRefund(context.Background(), fctx, srv.URL,
		types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"},
		"", http.DefaultClient)
	if err == nil || !strings.Contains(err.Error(), "missing PAYMENT-REQUIRED") {
		t.Fatalf("got %v", err)
	}
}
