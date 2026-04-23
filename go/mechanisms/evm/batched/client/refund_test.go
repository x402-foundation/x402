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
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
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
	storage := NewInMemoryClientSessionStorage()
	_ = storage.Set("ch", &BatchedClientContext{Balance: "100"})
	err := UpdateSessionAfterRefund(storage, "ch", map[string]interface{}{"balance": "0"})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got, _ := storage.Get("ch"); got != nil {
		t.Fatalf("session not deleted: %+v", got)
	}
}

func TestUpdateSessionAfterRefund_MissingBalanceDeletes(t *testing.T) {
	storage := NewInMemoryClientSessionStorage()
	_ = storage.Set("ch", &BatchedClientContext{Balance: "100"})
	err := UpdateSessionAfterRefund(storage, "ch", map[string]interface{}{})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got, _ := storage.Get("ch"); got != nil {
		t.Fatalf("session not deleted: %+v", got)
	}
}

func TestUpdateSessionAfterRefund_PartialRefundUpdates(t *testing.T) {
	storage := NewInMemoryClientSessionStorage()
	_ = storage.Set("ch", &BatchedClientContext{
		Balance:                 "1000",
		ChargedCumulativeAmount: "100",
		TotalClaimed:            "100",
		Signature:               "0xsig",
	})
	err := UpdateSessionAfterRefund(storage, "ch", map[string]interface{}{
		"balance":                 "500",
		"chargedCumulativeAmount": "200",
		"totalClaimed":            "150",
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
	storage := NewInMemoryClientSessionStorage()
	err := UpdateSessionAfterRefund(storage, "ch", map[string]interface{}{
		"balance":                 "500",
		"chargedCumulativeAmount": "10",
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
	pr := x402.PaymentRequired{Accepts: []types.PaymentRequirements{{Scheme: batched.SchemeBatched}}}
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
			Scheme: batched.SchemeBatched,
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
	if got.Scheme != batched.SchemeBatched {
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
	storage       *InMemoryClientSessionStorage
	signer        *mockSigner
	voucherSigner *mockSigner
	config        batched.ChannelConfig
	recoverErr    error
	recovered     *BatchedClientContext
}

func (f *fakeRefundContext) Storage() ClientSessionStorage   { return f.storage }
func (f *fakeRefundContext) Signer() evm.ClientEvmSigner     { return f.signer }
func (f *fakeRefundContext) VoucherSigner() evm.ClientEvmSigner {
	if f.voucherSigner == nil {
		return nil
	}
	return f.voucherSigner
}
func (f *fakeRefundContext) BuildChannelConfig(_ types.PaymentRequirements) batched.ChannelConfig {
	return f.config
}
func (f *fakeRefundContext) RecoverSession(_ context.Context, _ types.PaymentRequirements) (*BatchedClientContext, error) {
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

func defaultConfig() batched.ChannelConfig {
	return batched.ChannelConfig{
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
		storage: NewInMemoryClientSessionStorage(),
		signer:  &mockSigner{address: "0x1"},
		config:  defaultConfig(),
	}
	_, err := buildRefundVoucherPayload(context.Background(), fctx, types.PaymentRequirements{Network: "eip155:8453"}, "")
	if err == nil || !strings.Contains(err.Error(), "existing channel session") {
		t.Fatalf("expected missing-session error, got %v", err)
	}
}

func TestBuildRefundVoucherPayload_HasSession(t *testing.T) {
	channelId, err := batched.ComputeChannelId(defaultConfig())
	if err != nil {
		t.Fatalf("compute: %v", err)
	}
	storage := NewInMemoryClientSessionStorage()
	_ = storage.Set(batched.NormalizeChannelId(channelId), &BatchedClientContext{
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
	if body["type"] != "voucher" || body["refund"] != true || body["refundAmount"] != "100" {
		t.Fatalf("payload = %+v", body)
	}
	if body["maxClaimableAmount"] != "200" {
		t.Fatalf("expected charged echoed back as max, got %v", body["maxClaimableAmount"])
	}
}

func TestBuildRefundVoucherPayload_DefaultsChargedZero(t *testing.T) {
	channelId, _ := batched.ComputeChannelId(defaultConfig())
	storage := NewInMemoryClientSessionStorage()
	_ = storage.Set(batched.NormalizeChannelId(channelId), &BatchedClientContext{})

	fctx := &fakeRefundContext{
		storage: storage,
		signer:  &mockSigner{address: "0x1", sig: []byte{0x88}},
		config:  defaultConfig(),
	}
	payload, err := buildRefundVoucherPayload(context.Background(), fctx, types.PaymentRequirements{Network: "eip155:8453"}, "")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if payload.Payload["maxClaimableAmount"] != "0" {
		t.Fatalf("expected 0, got %v", payload.Payload["maxClaimableAmount"])
	}
}

func TestBuildRefundVoucherPayload_SignerError(t *testing.T) {
	channelId, _ := batched.ComputeChannelId(defaultConfig())
	storage := NewInMemoryClientSessionStorage()
	_ = storage.Set(batched.NormalizeChannelId(channelId), &BatchedClientContext{ChargedCumulativeAmount: "1"})

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
		storage: NewInMemoryClientSessionStorage(),
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
		storage: NewInMemoryClientSessionStorage(),
		signer:  &mockSigner{address: "0x1"},
		config:  defaultConfig(),
	}
	_, err := RefundChannel(context.Background(), fctx, srv.URL, nil)
	if err == nil {
		t.Fatal("expected probe error")
	}
}
