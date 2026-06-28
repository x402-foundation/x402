package offerreceipt_test

import (
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/extensions/offerreceipt"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestExtractOffersFromPaymentRequired(t *testing.T) {
	t.Run("returns empty when extensions are nil", func(t *testing.T) {
		offers, err := offerreceipt.ExtractOffersFromPaymentRequired(types.PaymentRequired{})

		require.NoError(t, err)
		assert.Empty(t, offers)
	})

	t.Run("returns empty when extension is absent", func(t *testing.T) {
		offers, err := offerreceipt.ExtractOffersFromPaymentRequired(types.PaymentRequired{
			Extensions: map[string]interface{}{"other": map[string]interface{}{}},
		})

		require.NoError(t, err)
		assert.Empty(t, offers)
	})

	t.Run("extracts signed offers", func(t *testing.T) {
		index := 0
		expected := offerreceipt.SignedOffer{
			Format:      offerreceipt.FormatEIP712,
			AcceptIndex: &index,
			Payload:     &testOfferPayload,
			Signature:   "0xsig",
		}

		offers, err := offerreceipt.ExtractOffersFromPaymentRequired(types.PaymentRequired{
			Extensions: map[string]interface{}{
				offerreceipt.OFFER_RECEIPT: map[string]interface{}{
					"info": map[string]interface{}{
						"offers": []offerreceipt.SignedOffer{expected},
					},
				},
			},
		})

		require.NoError(t, err)
		require.Len(t, offers, 1)
		assert.Equal(t, expected, offers[0])
	})
}

func TestExtractReceiptFromSettleResponse(t *testing.T) {
	t.Run("returns nil when extension is absent", func(t *testing.T) {
		receipt, err := offerreceipt.ExtractReceiptFromSettleResponse(x402.SettleResponse{})

		require.NoError(t, err)
		assert.Nil(t, receipt)
	})

	t.Run("extracts signed receipt", func(t *testing.T) {
		expected := offerreceipt.SignedReceipt{
			Format:    offerreceipt.FormatEIP712,
			Payload:   &testReceiptPayload,
			Signature: "0xsig",
		}

		receipt, err := offerreceipt.ExtractReceiptFromSettleResponse(x402.SettleResponse{
			Extensions: map[string]interface{}{
				offerreceipt.OFFER_RECEIPT: map[string]interface{}{
					"info": map[string]interface{}{
						"receipt": expected,
					},
				},
			},
		})

		require.NoError(t, err)
		require.NotNil(t, receipt)
		assert.Equal(t, expected, *receipt)
	})
}

func TestExtractOfferPayload(t *testing.T) {
	t.Run("returns eip712 payload", func(t *testing.T) {
		payload, err := offerreceipt.ExtractOfferPayload(offerreceipt.SignedOffer{
			Format:    offerreceipt.FormatEIP712,
			Payload:   &testOfferPayload,
			Signature: "0xsig",
		})

		require.NoError(t, err)
		assert.Equal(t, testOfferPayload, payload)
	})

	t.Run("decodes jws payload", func(t *testing.T) {
		payload, err := offerreceipt.ExtractOfferPayload(offerreceipt.SignedOffer{
			Format:    offerreceipt.FormatJWS,
			Signature: compactJWS(t, testOfferPayload),
		})

		require.NoError(t, err)
		assert.Equal(t, testOfferPayload, payload)
	})

	t.Run("rejects malformed jws", func(t *testing.T) {
		_, err := offerreceipt.ExtractOfferPayload(offerreceipt.SignedOffer{
			Format:    offerreceipt.FormatJWS,
			Signature: "not-a-jws",
		})

		require.Error(t, err)
	})

	t.Run("rejects eip712 without payload", func(t *testing.T) {
		_, err := offerreceipt.ExtractOfferPayload(offerreceipt.SignedOffer{
			Format:    offerreceipt.FormatEIP712,
			Signature: "0xsig",
		})

		require.Error(t, err)
	})
}

func TestExtractReceiptPayload(t *testing.T) {
	t.Run("returns eip712 payload", func(t *testing.T) {
		payload, err := offerreceipt.ExtractReceiptPayload(offerreceipt.SignedReceipt{
			Format:    offerreceipt.FormatEIP712,
			Payload:   &testReceiptPayload,
			Signature: "0xsig",
		})

		require.NoError(t, err)
		assert.Equal(t, testReceiptPayload, payload)
	})

	t.Run("decodes jws payload", func(t *testing.T) {
		payload, err := offerreceipt.ExtractReceiptPayload(offerreceipt.SignedReceipt{
			Format:    offerreceipt.FormatJWS,
			Signature: compactJWS(t, testReceiptPayload),
		})

		require.NoError(t, err)
		assert.Equal(t, testReceiptPayload, payload)
	})
}

func TestDecodeSignedOffers(t *testing.T) {
	index := 0
	decoded, err := offerreceipt.DecodeSignedOffers([]offerreceipt.SignedOffer{
		{
			Format:      offerreceipt.FormatEIP712,
			AcceptIndex: &index,
			Payload:     &testOfferPayload,
			Signature:   "0xsig",
		},
	})

	require.NoError(t, err)
	require.Len(t, decoded, 1)
	assert.Equal(t, testOfferPayload, decoded[0].OfferPayload)
	assert.Equal(t, offerreceipt.FormatEIP712, decoded[0].Format)
	assert.Equal(t, &index, decoded[0].AcceptIndex)
}

func TestFindAcceptsObjectFromSignedOffer(t *testing.T) {
	accepts := []types.PaymentRequirements{
		{
			Scheme:  "exact",
			Network: "eip155:84532",
			Asset:   "0xother",
			PayTo:   "0xpayee",
			Amount:  "10000",
		},
		{
			Scheme:  testOfferPayload.Scheme,
			Network: testOfferPayload.Network,
			Asset:   testOfferPayload.Asset,
			PayTo:   testOfferPayload.PayTo,
			Amount:  testOfferPayload.Amount,
		},
	}

	t.Run("uses valid accept index", func(t *testing.T) {
		index := 1
		match, err := offerreceipt.FindAcceptsObjectFromSignedOffer(offerreceipt.SignedOffer{
			Format:      offerreceipt.FormatEIP712,
			AcceptIndex: &index,
			Payload:     &testOfferPayload,
			Signature:   "0xsig",
		}, accepts)

		require.NoError(t, err)
		require.NotNil(t, match)
		assert.Equal(t, accepts[1], *match)
	})

	t.Run("falls back when accept index is stale", func(t *testing.T) {
		index := 0
		match, err := offerreceipt.FindAcceptsObjectFromSignedOffer(offerreceipt.SignedOffer{
			Format:      offerreceipt.FormatEIP712,
			AcceptIndex: &index,
			Payload:     &testOfferPayload,
			Signature:   "0xsig",
		}, accepts)

		require.NoError(t, err)
		require.NotNil(t, match)
		assert.Equal(t, accepts[1], *match)
	})

	t.Run("returns nil when no accepts match", func(t *testing.T) {
		payload := testOfferPayload
		payload.Amount = "999"

		match, err := offerreceipt.FindAcceptsObjectFromSignedOffer(offerreceipt.SignedOffer{
			Format:    offerreceipt.FormatEIP712,
			Payload:   &payload,
			Signature: "0xsig",
		}, accepts)

		require.NoError(t, err)
		assert.Nil(t, match)
	})
}

func TestVerifyReceiptMatchesOffer(t *testing.T) {
	now := time.Unix(1_700_000_100, 0)
	offer := offerreceipt.DecodedOffer{
		OfferPayload: testOfferPayload,
		Format:       offerreceipt.FormatEIP712,
	}
	receipt := offerreceipt.SignedReceipt{
		Format: offerreceipt.FormatEIP712,
		Payload: &offerreceipt.ReceiptPayload{
			Version:     1,
			Network:     testOfferPayload.Network,
			ResourceURL: testOfferPayload.ResourceURL,
			Payer:       "0x857b06519E91e3A54538791bDbb0E22373e36b66",
			IssuedAt:    now.Unix() - 30,
		},
		Signature: "0xsig",
	}

	t.Run("returns true for matching receipt", func(t *testing.T) {
		ok, err := offerreceipt.VerifyReceiptMatchesOffer(
			receipt,
			offer,
			[]string{"0x857B06519e91e3A54538791bDBb0e22373E36B66"},
			3600,
			now,
		)

		require.NoError(t, err)
		assert.True(t, ok)
	})

	t.Run("returns false for wrong payer", func(t *testing.T) {
		ok, err := offerreceipt.VerifyReceiptMatchesOffer(
			receipt,
			offer,
			[]string{"0x0000000000000000000000000000000000000000"},
			3600,
			now,
		)

		require.NoError(t, err)
		assert.False(t, ok)
	})

	t.Run("returns false for expired receipt", func(t *testing.T) {
		ok, err := offerreceipt.VerifyReceiptMatchesOffer(
			receipt,
			offer,
			[]string{"0x857b06519E91e3A54538791bDbb0E22373e36b66"},
			10,
			now,
		)

		require.NoError(t, err)
		assert.False(t, ok)
	})

	t.Run("returns false for future issuedAt", func(t *testing.T) {
		futureReceipt := receipt
		payload := *receipt.Payload
		payload.IssuedAt = now.Unix() + 30
		futureReceipt.Payload = &payload

		ok, err := offerreceipt.VerifyReceiptMatchesOffer(
			futureReceipt,
			offer,
			[]string{"0x857b06519E91e3A54538791bDbb0E22373e36b66"},
			3600,
			now,
		)

		require.NoError(t, err)
		assert.False(t, ok)
	})

	t.Run("returns false for wrong resource", func(t *testing.T) {
		wrongReceipt := receipt
		payload := *receipt.Payload
		payload.ResourceURL = "https://api.example.com/other"
		wrongReceipt.Payload = &payload

		ok, err := offerreceipt.VerifyReceiptMatchesOffer(
			wrongReceipt,
			offer,
			[]string{"0x857b06519E91e3A54538791bDbb0E22373e36b66"},
			3600,
			now,
		)

		require.NoError(t, err)
		assert.False(t, ok)
	})
}

var testOfferPayload = offerreceipt.OfferPayload{
	Version:     1,
	ResourceURL: "https://api.example.com/premium-data",
	Scheme:      "exact",
	Network:     "eip155:8453",
	Asset:       "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
	PayTo:       "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
	Amount:      "10000",
	ValidUntil:  1_703_123_516,
}

var testReceiptPayload = offerreceipt.ReceiptPayload{
	Version:     1,
	Network:     "eip155:8453",
	ResourceURL: "https://api.example.com/premium-data",
	Payer:       "0x857b06519E91e3A54538791bDbb0E22373e36b66",
	IssuedAt:    1_703_123_456,
	Transaction: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
}

func compactJWS(t *testing.T, payload interface{}) string {
	t.Helper()

	headerJSON, err := json.Marshal(map[string]string{"alg": "ES256K", "kid": "did:web:api.example.com#key-1"})
	require.NoError(t, err)

	payloadJSON, err := json.Marshal(payload)
	require.NoError(t, err)

	header := base64.RawURLEncoding.EncodeToString(headerJSON)
	body := base64.RawURLEncoding.EncodeToString(payloadJSON)

	return header + "." + body + ".sig"
}
