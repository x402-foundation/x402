package offerreceipt

import (
	"strings"
	"time"

	"github.com/x402-foundation/x402/go/v2/types"
)

const DefaultMaxReceiptAgeSeconds int64 = 3600

// FindAcceptsObjectFromSignedOffer finds the payment requirements matching a signed offer.
func FindAcceptsObjectFromSignedOffer(
	offer SignedOffer,
	accepts []types.PaymentRequirements,
) (*types.PaymentRequirements, error) {
	payload, err := ExtractOfferPayload(offer)
	if err != nil {
		return nil, err
	}

	decoded := DecodedOffer{
		OfferPayload: payload,
		SignedOffer:  offer,
		Format:       offer.Format,
		AcceptIndex:  offer.AcceptIndex,
	}

	return FindAcceptsObjectFromDecodedOffer(decoded, accepts), nil
}

// FindAcceptsObjectFromDecodedOffer finds the payment requirements matching a decoded offer.
func FindAcceptsObjectFromDecodedOffer(
	offer DecodedOffer,
	accepts []types.PaymentRequirements,
) *types.PaymentRequirements {
	if offer.AcceptIndex != nil && *offer.AcceptIndex >= 0 && *offer.AcceptIndex < len(accepts) {
		if offerMatchesRequirements(offer.OfferPayload, accepts[*offer.AcceptIndex]) {
			return &accepts[*offer.AcceptIndex]
		}
	}

	for i := range accepts {
		if offerMatchesRequirements(offer.OfferPayload, accepts[i]) {
			return &accepts[i]
		}
	}

	return nil
}

// VerifyReceiptMatchesOffer checks receipt payload consistency with an accepted offer.
//
// This does not verify the receipt signature or signer authorization.
func VerifyReceiptMatchesOffer(
	receipt SignedReceipt,
	offer DecodedOffer,
	payerAddresses []string,
	maxAgeSeconds int64,
	now time.Time,
) (bool, error) {
	payload, err := ExtractReceiptPayload(receipt)
	if err != nil {
		return false, err
	}

	if now.IsZero() {
		now = time.Now()
	}
	if maxAgeSeconds <= 0 {
		maxAgeSeconds = DefaultMaxReceiptAgeSeconds
	}

	age := now.Unix() - payload.IssuedAt

	return payload.ResourceURL == offer.ResourceURL &&
		payload.Network == offer.Network &&
		payerMatches(payload.Payer, payerAddresses) &&
		age >= 0 &&
		age < maxAgeSeconds, nil
}

func offerMatchesRequirements(payload OfferPayload, requirements types.PaymentRequirements) bool {
	return requirements.Network == payload.Network &&
		requirements.Scheme == payload.Scheme &&
		requirements.Asset == payload.Asset &&
		requirements.PayTo == payload.PayTo &&
		requirements.Amount == payload.Amount
}

func payerMatches(payer string, payerAddresses []string) bool {
	for _, address := range payerAddresses {
		if strings.EqualFold(payer, address) {
			return true
		}
	}
	return false
}
