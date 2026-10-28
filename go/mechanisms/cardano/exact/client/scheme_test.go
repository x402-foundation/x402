package client

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	"github.com/x402-foundation/x402/go/v2/types"
)

type stubSigner struct {
	result *cardano.ClientSignResult
	err    error
	got    cardano.ClientSignInput
}

func (s *stubSigner) Address() string { return "addr_test1x" }
func (s *stubSigner) BuildAndSignPaymentTransaction(_ context.Context, in cardano.ClientSignInput) (*cardano.ClientSignResult, error) {
	s.got = in
	return s.result, s.err
}

var nonce = strings.Repeat("ab", 32) + "#1"

func requirements() types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme: "exact", Network: cardano.CardanoPreprodCAIP2, Asset: "lovelace", Amount: "5000000",
		PayTo: "addr_test1qpdp327fu3hpm8ljwkvjy7lfqj80x469rukv8q83jegrxumkegy93sy8slex9xny7z7cj3hgdx0ly3elexy4pgd2m4hqflxyfj", MaxTimeoutSeconds: 300,
	}
}

func TestCreatePaymentPayload(t *testing.T) {
	signer := &stubSigner{result: &cardano.ClientSignResult{Transaction: "dHg=", Nonce: nonce}}
	scheme := NewExactCardanoScheme(signer)
	payload, err := scheme.CreatePaymentPayload(context.Background(), requirements(), x402.PaymentPayloadContext{})
	require.NoError(t, err)
	assert.Equal(t, 2, payload.X402Version)
	assert.Equal(t, map[string]interface{}{"transaction": "dHg=", "nonce": nonce}, payload.Payload)
	assert.Equal(t, 300, signer.got.MaxTimeoutSeconds)
	assert.Equal(t, "exact", scheme.Scheme())
	assert.NotNil(t, scheme.FindDefaultAsset(cardano.USDMPreprodAsset, cardano.CardanoPreprodCAIP2))
	assert.Nil(t, scheme.FindDefaultAsset("lovelace", cardano.CardanoPreprodCAIP2))
}

func TestCreatePaymentPayloadRejects(t *testing.T) {
	cases := map[string]func(r *types.PaymentRequirements){
		"network":      func(r *types.PaymentRequirements) { r.Network = "eip155:1" },
		"empty payTo":  func(r *types.PaymentRequirements) { r.PayTo = "" },
		"bad payTo":    func(r *types.PaymentRequirements) { r.PayTo = "stake1x" },
		"empty asset":  func(r *types.PaymentRequirements) { r.Asset = "" },
		"asset case":   func(r *types.PaymentRequirements) { r.Asset = "LOVELACE" },
		"empty amount": func(r *types.PaymentRequirements) { r.Amount = "" },
		"amount zero":  func(r *types.PaymentRequirements) { r.Amount = "0" },
		"policy":       func(r *types.PaymentRequirements) { r.Extra = map[string]interface{}{"confirmationPolicy": "x"} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			r := requirements()
			mutate(&r)
			_, err := NewExactCardanoScheme(&stubSigner{}).CreatePaymentPayload(context.Background(), r, x402.PaymentPayloadContext{})
			assert.Error(t, err)
		})
	}
	for name, signer := range map[string]*stubSigner{
		"signer error":  {err: errors.New("boom")},
		"empty tx":      {result: &cardano.ClientSignResult{Nonce: nonce}},
		"invalid nonce": {result: &cardano.ClientSignResult{Transaction: "dHg=", Nonce: "x"}},
		"nil result":    {},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := NewExactCardanoScheme(signer).CreatePaymentPayload(context.Background(), requirements(), x402.PaymentPayloadContext{})
			assert.Error(t, err)
		})
	}
}
