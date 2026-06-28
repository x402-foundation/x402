package offerreceipt

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/types"
)

// ExtractOffersFromPaymentRequired extracts signed offers from a PaymentRequired response.
func ExtractOffersFromPaymentRequired(required types.PaymentRequired) ([]SignedOffer, error) {
	if required.Extensions == nil {
		return []SignedOffer{}, nil
	}

	ext, err := extractExtension(required.Extensions)
	if err != nil || ext == nil {
		return []SignedOffer{}, err
	}
	if ext.Info.Offers == nil {
		return []SignedOffer{}, nil
	}

	return ext.Info.Offers, nil
}

// ExtractReceiptFromSettleResponse extracts a signed receipt from a settle response.
func ExtractReceiptFromSettleResponse(response x402.SettleResponse) (*SignedReceipt, error) {
	return ExtractReceiptFromExtensions(response.Extensions)
}

// ExtractReceiptFromExtensions extracts a signed receipt from an extensions map.
func ExtractReceiptFromExtensions(extensions map[string]interface{}) (*SignedReceipt, error) {
	if extensions == nil {
		return nil, nil
	}

	ext, err := extractExtension(extensions)
	if err != nil || ext == nil {
		return nil, err
	}

	return ext.Info.Receipt, nil
}

// DecodeSignedOffers extracts payloads from signed offers.
func DecodeSignedOffers(offers []SignedOffer) ([]DecodedOffer, error) {
	decoded := make([]DecodedOffer, 0, len(offers))
	for _, offer := range offers {
		payload, err := ExtractOfferPayload(offer)
		if err != nil {
			return nil, err
		}
		decoded = append(decoded, DecodedOffer{
			OfferPayload: payload,
			SignedOffer:  offer,
			Format:       offer.Format,
			AcceptIndex:  offer.AcceptIndex,
		})
	}
	return decoded, nil
}

// ExtractOfferPayload returns the signed offer payload without verifying the signature.
func ExtractOfferPayload(offer SignedOffer) (OfferPayload, error) {
	switch offer.Format {
	case FormatEIP712:
		if offer.Payload == nil {
			return OfferPayload{}, errors.New("offer-receipt: eip712 offer missing payload")
		}
		return *offer.Payload, nil
	case FormatJWS:
		var payload OfferPayload
		if err := extractJWSPayload(offer.Signature, &payload); err != nil {
			return OfferPayload{}, fmt.Errorf("offer-receipt: decode jws offer payload: %w", err)
		}
		return payload, nil
	default:
		return OfferPayload{}, fmt.Errorf("offer-receipt: unsupported offer format %q", offer.Format)
	}
}

// ExtractReceiptPayload returns the signed receipt payload without verifying the signature.
func ExtractReceiptPayload(receipt SignedReceipt) (ReceiptPayload, error) {
	switch receipt.Format {
	case FormatEIP712:
		if receipt.Payload == nil {
			return ReceiptPayload{}, errors.New("offer-receipt: eip712 receipt missing payload")
		}
		return *receipt.Payload, nil
	case FormatJWS:
		var payload ReceiptPayload
		if err := extractJWSPayload(receipt.Signature, &payload); err != nil {
			return ReceiptPayload{}, fmt.Errorf("offer-receipt: decode jws receipt payload: %w", err)
		}
		return payload, nil
	default:
		return ReceiptPayload{}, fmt.Errorf("offer-receipt: unsupported receipt format %q", receipt.Format)
	}
}

func extractExtension(extensions map[string]interface{}) (*offerReceiptExtension, error) {
	extRaw, ok := extensions[OFFER_RECEIPT]
	if !ok {
		return nil, nil
	}

	extJSON, err := json.Marshal(extRaw)
	if err != nil {
		return nil, fmt.Errorf("offer-receipt: marshal extension: %w", err)
	}

	var ext offerReceiptExtension
	if err := json.Unmarshal(extJSON, &ext); err != nil {
		return nil, fmt.Errorf("offer-receipt: unmarshal extension: %w", err)
	}

	return &ext, nil
}

func extractJWSPayload(jws string, target interface{}) error {
	parts := strings.Split(jws, ".")
	if len(parts) != 3 {
		return errors.New("invalid jws compact serialization")
	}

	payloadJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return err
	}

	if err := json.Unmarshal(payloadJSON, target); err != nil {
		return err
	}
	return nil
}
