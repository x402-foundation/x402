package server

import (
	"context"
	"encoding/base64"
	"encoding/json"

	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	"github.com/x402-foundation/x402/go/v2/types"
)

// MasumiPaymentOption returns an HTTP payment option for a Masumi route. Its
// price callback issues a fresh seller-signed quote, or resumes the stored
// quote the PAYMENT-SIGNATURE carries. Go core matches paid retries against
// the option it builds per request, so per-request Masumi terms must come
// from the price callback (TypeScript does this in enrichPaymentRequiredResponse).
func (s *ExactCardanoScheme) MasumiPaymentOption(route MasumiRoute) (x402http.PaymentOption, error) {
	if s.issuer == nil {
		return x402http.PaymentOption{}, errNoIssuer
	}
	template, err := s.template(route)
	if err != nil {
		return x402http.PaymentOption{}, err
	}
	price := x402http.DynamicPriceFunc(func(ctx context.Context, reqCtx x402http.HTTPRequestContext) (x402.Price, error) {
		var paid *types.PaymentPayload
		resource := route.Resource
		if reqCtx.Adapter != nil {
			paid = paymentFromHeader(reqCtx.Adapter)
			if resource == "" {
				resource = reqCtx.Adapter.GetURL()
			}
		}
		quote, err := s.quoteFor(ctx, template, paid, MasumiIssueContext{
			Resource:  &types.ResourceInfo{URL: resource},
			Transport: reqCtx,
		})
		if err != nil {
			return nil, err
		}
		return x402.AssetAmount{Asset: quote.Asset, Amount: quote.Amount, Extra: quote.Extra}, nil
	})
	return x402http.PaymentOption{
		Scheme:            cardano.SchemeExact,
		Network:           x402.Network(template.Network),
		PayTo:             template.PayTo,
		Price:             price,
		MaxTimeoutSeconds: template.MaxTimeoutSeconds,
		Extra:             map[string]interface{}{"assetTransferMethod": cardano.AssetTransferMethodMasumi},
	}, nil
}

// paymentFromHeader decodes PAYMENT-SIGNATURE as core does; malformed headers
// read as unpaid and core reports them itself.
func paymentFromHeader(adapter x402http.HTTPAdapter) *types.PaymentPayload {
	header := adapter.GetHeader("PAYMENT-SIGNATURE")
	if header == "" {
		header = adapter.GetHeader("payment-signature")
	}
	if header == "" {
		return nil
	}
	raw, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		return nil
	}
	var payload types.PaymentPayload
	if err := json.Unmarshal(raw, &payload); err != nil || payload.X402Version != 2 {
		return nil
	}
	return &payload
}
