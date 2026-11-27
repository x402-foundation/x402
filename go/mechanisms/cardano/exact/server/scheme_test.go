package server

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/masumi"
	"github.com/x402-foundation/x402/go/v2/types"
)

const network = cardano.CardanoPreprodCAIP2

func supportedKind() types.SupportedKind {
	return types.SupportedKind{X402Version: 2, Scheme: "exact", Network: network, Extra: map[string]interface{}{
		"assetTransferMethods": []interface{}{"default", "masumi", "script"},
		"areFeesSponsored":     false,
		"l1Confirmations":      map[string]interface{}{"minimum": float64(0), "maximum": float64(20)},
	}}
}

func TestParsePrice(t *testing.T) {
	s := NewExactCardanoScheme()
	amount, err := s.ParsePrice("$0.10", network)
	require.NoError(t, err)
	assert.Equal(t, x402.AssetAmount{Amount: "100000", Asset: cardano.USDMPreprodAsset, Extra: map[string]interface{}{}}, amount)
	amount, err = s.ParsePrice(map[string]interface{}{"amount": "5000000", "asset": "lovelace"}, network)
	require.NoError(t, err)
	assert.Equal(t, "lovelace", amount.Asset)
	amount, err = s.ParsePrice(x402.AssetAmount{Amount: "7", Asset: "lovelace", Extra: map[string]interface{}{"k": 1}}, network)
	require.NoError(t, err)
	assert.Equal(t, 1, amount.Extra["k"])

	for _, bad := range []x402.Price{
		map[string]interface{}{"amount": "5"},
		map[string]interface{}{"amount": "05", "asset": "lovelace"},
		map[string]interface{}{"amount": "5", "asset": "LOVELACE"},
		"not money",
	} {
		_, err := s.ParsePrice(bad, network)
		assert.Error(t, err, "%v", bad)
	}
	_, err = s.ParsePrice("$1", cardano.CardanoPreviewCAIP2)
	assert.Error(t, err, "preview has no default asset")

	s.RegisterMoneyParser(func(amount string, _ x402.Network) (*x402.AssetAmount, error) {
		return &x402.AssetAmount{Amount: "42", Asset: "lovelace"}, nil
	})
	amount, err = s.ParsePrice("$5", network)
	require.NoError(t, err)
	assert.Equal(t, "42", amount.Amount)
}

func TestSchemeBasics(t *testing.T) {
	s := NewExactCardanoScheme()
	assert.Equal(t, "exact", s.Scheme())
	assert.Equal(t, "default", s.DefaultAssetTransferMethod())
	assert.Len(t, s.PaymentFlows(), 3)
	decimals, ok := s.GetAssetDecimals(cardano.USDMPreprodAsset, network)
	assert.True(t, ok)
	assert.Equal(t, 6, decimals)
	_, ok = s.GetAssetDecimals("lovelace", network)
	assert.False(t, ok)
}

func TestEnhancePaymentRequirements(t *testing.T) {
	s := NewExactCardanoScheme()
	ctx := context.Background()
	base := types.PaymentRequirements{Scheme: "exact", Network: network, Asset: "lovelace", Amount: "1", PayTo: "addr_test1x", MaxTimeoutSeconds: 60}
	out, err := s.EnhancePaymentRequirements(ctx, base, supportedKind(), nil)
	require.NoError(t, err)
	assert.Equal(t, false, out.Extra["areFeesSponsored"])

	cases := map[string]func(r *types.PaymentRequirements, k *types.SupportedKind){
		"unsupported method": func(r *types.PaymentRequirements, k *types.SupportedKind) {
			k.Extra["assetTransferMethods"] = []interface{}{"masumi"}
		},
		"no methods advertised": func(_ *types.PaymentRequirements, k *types.SupportedKind) { delete(k.Extra, "assetTransferMethods") },
		"no range":              func(_ *types.PaymentRequirements, k *types.SupportedKind) { delete(k.Extra, "l1Confirmations") },
		"depth outside range": func(r *types.PaymentRequirements, _ *types.SupportedKind) {
			r.Extra = map[string]interface{}{"confirmationPolicy": map[string]interface{}{"l1Confirmations": float64(-1)}}
		},
		"bad policy": func(r *types.PaymentRequirements, _ *types.SupportedKind) {
			r.Extra = map[string]interface{}{"confirmationPolicy": 1}
		},
		"masumi template": func(r *types.PaymentRequirements, _ *types.SupportedKind) {
			r.Extra = map[string]interface{}{"assetTransferMethod": "masumi"}
		},
		"invalid masumi": func(r *types.PaymentRequirements, _ *types.SupportedKind) {
			r.Extra = map[string]interface{}{"assetTransferMethod": "masumi", "terms": map[string]interface{}{}}
		},
		"non-cardano kind": func(_ *types.PaymentRequirements, k *types.SupportedKind) { k.Network = "eip155:1" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			r, k := base, supportedKind()
			mutate(&r, &k)
			_, err := s.EnhancePaymentRequirements(ctx, r, k, nil)
			assert.Error(t, err)
		})
	}
	kind := supportedKind()
	kind.Extra = nil
	_, err = s.EnhancePaymentRequirements(ctx, base, kind, nil)
	assert.NoError(t, err, "a facilitator without capabilities is trusted")
}

func TestMasumiTemplateValidation(t *testing.T) {
	s := NewExactCardanoScheme(&Config{Masumi: &MasumiIssuerConfig{}})
	_, err := s.template(MasumiRoute{Network: network, Asset: "lovelace", Amount: "1", MaxTimeoutSeconds: 300})
	require.NoError(t, err)
	for name, route := range map[string]MasumiRoute{
		"zero timeout":    {Network: network, Asset: "lovelace", Amount: "1"},
		"bad network":     {Network: "eip155:1", Asset: "lovelace", Amount: "1", MaxTimeoutSeconds: 300},
		"bad amount":      {Network: network, Asset: "lovelace", Amount: "0", MaxTimeoutSeconds: 300},
		"preview default": {Network: cardano.CardanoPreviewCAIP2, Asset: "lovelace", Amount: "1", MaxTimeoutSeconds: 300},
		"past horizon":    {Network: network, Asset: "lovelace", Amount: "1", MaxTimeoutSeconds: 40 * 24 * 3600},
	} {
		_, err := s.template(route)
		assert.Error(t, err, name)
	}
	_, err = NewExactCardanoScheme().MasumiPaymentOption(MasumiRoute{Network: network, Asset: "lovelace", Amount: "1", MaxTimeoutSeconds: 300})
	assert.ErrorIs(t, err, errNoIssuer)
}

func TestBindMasumiTerms(t *testing.T) {
	s := NewExactCardanoScheme()
	ctx := context.Background()
	quote := loadQuote(t)
	tx := loadTx(t)
	payload := types.PaymentPayload{X402Version: 2, Accepted: quote, Payload: map[string]interface{}{"transaction": tx, "nonce": "x"}}

	result, err := s.bindMasumiTerms(ctx, payload)
	require.NoError(t, err)
	require.NotNil(t, result)
	assert.Equal(t, cardano.ErrMasumiTermsUnknown, result.Reason, "terms this server never issued")

	require.NoError(t, s.storeQuote(ctx, quote))
	result, err = s.bindMasumiTerms(ctx, payload)
	require.NoError(t, err)
	assert.Nil(t, result, "the first transaction binds the quote")
	result, err = s.bindMasumiTerms(ctx, payload)
	require.NoError(t, err)
	assert.Nil(t, result, "the same transaction resumes")

	digest, _ := masumi.TermsDigest(quote)
	_, err = s.storage.UpdateTerms(ctx, digest, func(current *masumi.StoredTerms) *masumi.StoredTerms {
		next := *current
		next.ClaimedTxHash = "another"
		return &next
	})
	require.NoError(t, err)
	result, _ = s.bindMasumiTerms(ctx, payload)
	assert.Equal(t, cardano.ErrDuplicateSettlement, result.Reason)

	altered := cloneRequirements(quote)
	altered.Extra["confirmationPolicy"] = map[string]interface{}{"l1Confirmations": float64(2)}
	result, _ = s.bindMasumiTerms(ctx, types.PaymentPayload{X402Version: 2, Accepted: altered, Payload: payload.Payload})
	assert.Equal(t, cardano.ErrMasumiTermsMismatch, result.Reason)

	result, _ = s.bindMasumiTerms(ctx, types.PaymentPayload{X402Version: 2, Accepted: quote, Payload: map[string]interface{}{"transaction": "AAAA"}})
	assert.Equal(t, cardano.ErrInvalidPayload, result.Reason)

	hook := s.AfterVerifyHook()
	raw, _ := json.Marshal(payload)
	out, err := hook(x402.VerifyResultContext{VerifyContext: x402.VerifyContext{Ctx: ctx, PayloadBytes: raw}, Result: &x402.VerifyResponse{IsValid: false}})
	require.NoError(t, err)
	assert.Nil(t, out, "invalid payments are not bound")
}

// quote_vectors.json (Masumi package testdata) holds TS-issued quotes.
func loadQuote(t *testing.T) types.PaymentRequirements {
	t.Helper()
	raw := readTestdata(t, "../masumi/testdata/quote_vectors.json")
	var vectors []map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &vectors))
	var requirements types.PaymentRequirements
	require.NoError(t, json.Unmarshal(vectors[0]["requirements"], &requirements))
	require.NotNil(t, requirements.Extra["terms"])
	return requirements
}

func readTestdata(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	return raw
}

func loadTx(t *testing.T) string {
	t.Helper()
	var vectors []struct {
		Transaction string `json:"transaction"`
	}
	require.NoError(t, json.Unmarshal(readTestdata(t, "../../testdata/decode_vectors.json"), &vectors))
	return vectors[0].Transaction
}
