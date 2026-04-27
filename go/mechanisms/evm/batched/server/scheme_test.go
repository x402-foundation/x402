package server

import (
	"context"
	"errors"
	"math/big"
	"testing"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
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

func TestNewBatchedEvmScheme_NilConfigDefaults(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	if s.GetReceiverAddress() != "0xreceiver" {
		t.Fatalf("receiver = %q", s.GetReceiverAddress())
	}
	if s.GetWithdrawDelay() != batched.MinWithdrawDelay {
		t.Fatalf("withdrawDelay = %d", s.GetWithdrawDelay())
	}
	if s.GetReceiverAuthorizerAddress() != "" {
		t.Fatalf("expected empty receiverAuthorizer, got %q", s.GetReceiverAuthorizerAddress())
	}
	if s.GetStorage() == nil {
		t.Fatal("expected default in-memory storage")
	}
	if s.Scheme() != batched.SchemeBatched {
		t.Fatalf("scheme = %s", s.Scheme())
	}
}

func TestNewBatchedEvmScheme_OverridesApplied(t *testing.T) {
	storage := NewInMemorySessionStorage()
	auth := &mockAuthorizerSigner{address: "0xauth"}
	s := NewBatchedEvmScheme("0xreceiver", &BatchedEvmSchemeConfig{
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

func TestNewBatchedEvmScheme_ZeroWithdrawDelayFallsBackToMin(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", &BatchedEvmSchemeConfig{WithdrawDelay: 0})
	if s.GetWithdrawDelay() != batched.MinWithdrawDelay {
		t.Fatalf("withdrawDelay = %d", s.GetWithdrawDelay())
	}
}

func TestParsePrice_AssetAmountMap(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
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
	s := NewBatchedEvmScheme("0xreceiver", nil)
	_, err := s.ParsePrice(map[string]interface{}{
		"amount": 1000,
		"asset":  "0xtoken",
	}, x402.Network("eip155:8453"))
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestParsePrice_AssetAmountMap_MissingAsset(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	_, err := s.ParsePrice(map[string]interface{}{"amount": "1000"}, x402.Network("eip155:8453"))
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestParsePrice_String(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	got, err := s.ParsePrice("$0.01", x402.Network("eip155:8453"))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got.Amount == "" || got.Asset == "" {
		t.Fatalf("got = %+v", got)
	}
}

func TestParsePrice_UnsupportedType(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	_, err := s.ParsePrice(struct{}{}, x402.Network("eip155:8453"))
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestRegisterMoneyParser_OverridesDefault(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
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
	s := NewBatchedEvmScheme("0xreceiver", &BatchedEvmSchemeConfig{
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

func TestEnhancePaymentRequirements_DecimalAmountNormalized(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	req := types.PaymentRequirements{
		Network: "eip155:8453",
		Asset:   "0x1234567890abcdef1234567890abcdef12345678",
		Amount:  "1.5",
	}
	out, err := s.EnhancePaymentRequirements(context.Background(), req, types.SupportedKind{}, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if out.Amount == "1.5" {
		t.Fatalf("amount not normalized: %s", out.Amount)
	}
}

func TestSignRefund_NoSignerErrors(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	_, err := s.SignRefund(context.Background(), "0xabcd", "100", "1", "eip155:8453")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSignRefund_BadNetwork(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", sig: []byte{0x01}}
	s := NewBatchedEvmScheme("0xreceiver", &BatchedEvmSchemeConfig{ReceiverAuthorizerSigner: auth})
	_, err := s.SignRefund(context.Background(), "0xabcd", "100", "1", "not-a-network")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSignRefund_BadAmount(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", sig: []byte{0x01}}
	s := NewBatchedEvmScheme("0xreceiver", &BatchedEvmSchemeConfig{ReceiverAuthorizerSigner: auth})
	_, err := s.SignRefund(context.Background(), "0xabcd", "not-a-number", "1", "eip155:8453")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSignRefund_BadNonce(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", sig: []byte{0x01}}
	s := NewBatchedEvmScheme("0xreceiver", &BatchedEvmSchemeConfig{ReceiverAuthorizerSigner: auth})
	_, err := s.SignRefund(context.Background(), "0xabcd", "100", "not-a-number", "eip155:8453")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSignRefund_BadChannelId(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", sig: []byte{0x01}}
	s := NewBatchedEvmScheme("0xreceiver", &BatchedEvmSchemeConfig{ReceiverAuthorizerSigner: auth})
	_, err := s.SignRefund(context.Background(), "not-hex", "100", "1", "eip155:8453")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSignRefund_OK(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", sig: []byte{0xde, 0xad}}
	s := NewBatchedEvmScheme("0xreceiver", &BatchedEvmSchemeConfig{ReceiverAuthorizerSigner: auth})
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
	s := NewBatchedEvmScheme("0xreceiver", &BatchedEvmSchemeConfig{ReceiverAuthorizerSigner: auth})
	_, err := s.SignRefund(context.Background(), "0xabcd", "100", "1", "eip155:8453")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSignClaimBatch_NoSignerErrors(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
	_, err := s.SignClaimBatch(context.Background(), nil, "eip155:8453")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSignClaimBatch_BadNetwork(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", sig: []byte{0x01}}
	s := NewBatchedEvmScheme("0xreceiver", &BatchedEvmSchemeConfig{ReceiverAuthorizerSigner: auth})
	_, err := s.SignClaimBatch(context.Background(), nil, "not-a-network")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSignClaimBatch_OK(t *testing.T) {
	auth := &mockAuthorizerSigner{address: "0xauth", sig: []byte{0xbe, 0xef}}
	s := NewBatchedEvmScheme("0xreceiver", &BatchedEvmSchemeConfig{ReceiverAuthorizerSigner: auth})
	claim := batched.BatchedVoucherClaim{Signature: "0xsig", TotalClaimed: "0"}
	claim.Voucher.Channel = batched.ChannelConfig{
		Payer:              "0x1111111111111111111111111111111111111111",
		PayerAuthorizer:    "0x2222222222222222222222222222222222222222",
		Receiver:           "0x3333333333333333333333333333333333333333",
		ReceiverAuthorizer: "0xauth",
		Token:              "0x5555555555555555555555555555555555555555",
		WithdrawDelay:      900,
		Salt:               "0x01",
	}
	claim.Voucher.MaxClaimableAmount = "100"
	sig, err := s.SignClaimBatch(context.Background(), []batched.BatchedVoucherClaim{claim}, "eip155:8453")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(sig) != 2 || sig[1] != 0xef {
		t.Fatalf("sig = %x", sig)
	}
}

func TestSession_RoundTrip_CaseInsensitive(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
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
	s := NewBatchedEvmScheme("0xreceiver", nil)
	if got := s.GetAssetDecimals("0xunknown", x402.Network("nope")); got != 6 {
		t.Fatalf("got %d", got)
	}
}

func TestCreateChannelManager_NotNil(t *testing.T) {
	s := NewBatchedEvmScheme("0xreceiver", nil)
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
