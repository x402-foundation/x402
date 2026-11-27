// Package client implements the Cardano exact scheme for clients.
package client

import (
	"context"
	"errors"
	"fmt"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	"github.com/x402-foundation/x402/go/v2/types"
)

// ExactCardanoScheme implements x402.SchemeNetworkClient for Cardano.
type ExactCardanoScheme struct {
	signer cardano.ClientCardanoSigner
}

// NewExactCardanoScheme creates the client scheme around a signer.
func NewExactCardanoScheme(signer cardano.ClientCardanoSigner) *ExactCardanoScheme {
	return &ExactCardanoScheme{signer: signer}
}

// Scheme implements x402.SchemeNetworkClient.
func (c *ExactCardanoScheme) Scheme() string { return cardano.SchemeExact }

// FindDefaultAsset implements x402.DefaultAssetFinder.
func (c *ExactCardanoScheme) FindDefaultAsset(asset string, network x402.Network) *x402.DefaultAsset {
	info := cardano.FindDefaultAsset(asset, string(network))
	if info == nil {
		return nil
	}
	return &x402.DefaultAsset{Asset: info.Asset, Decimals: info.Decimals, Symbol: info.Symbol}
}

type resourceKey struct{}

// WithResource returns a context carrying the protected resource being paid
// for (the 402's resource). Go core does not pass it to schemes, and Masumi
// quotes carrying a registry agentIdentifier need it to validate the seller's
// claim. With x402http, set it on the request's context before sending.
func WithResource(ctx context.Context, resource *types.ResourceInfo) context.Context {
	return context.WithValue(ctx, resourceKey{}, resource)
}

// CreatePaymentPayload validates the requirements and has the signer build and
// sign (not broadcast) the payment transaction.
func (c *ExactCardanoScheme) CreatePaymentPayload(ctx context.Context, requirements types.PaymentRequirements, _ x402.PaymentPayloadContext) (types.PaymentPayload, error) {
	switch {
	case !cardano.IsCardanoNetwork(requirements.Network):
		return types.PaymentPayload{}, fmt.Errorf("unsupported Cardano network: %s", requirements.Network)
	case requirements.PayTo == "":
		return types.PaymentPayload{}, errors.New("pay-to address is required")
	case !cardano.IsAddress(requirements.PayTo):
		return types.PaymentPayload{}, fmt.Errorf("invalid Cardano pay-to address: %s", requirements.PayTo)
	case requirements.Asset == "":
		return types.PaymentPayload{}, errors.New("asset is required")
	case !cardano.IsCanonicalAsset(requirements.Asset):
		return types.PaymentPayload{}, fmt.Errorf("cardano asset must use canonical lowercase form: %s", requirements.Asset)
	case requirements.Amount == "":
		return types.PaymentPayload{}, errors.New("amount is required")
	case !cardano.IsPositiveCanonicalAmount(requirements.Amount):
		return types.PaymentPayload{}, fmt.Errorf("amount must be a positive canonical integer, got: %s", requirements.Amount)
	}
	if _, ok := cardano.ResolveConfirmationPolicy(requirements.Extra); !ok {
		return types.PaymentPayload{}, errors.New("cardano payment requirements carry an invalid confirmation policy")
	}
	result, err := c.signer.BuildAndSignPaymentTransaction(ctx, cardano.ClientSignInput{
		Network:           requirements.Network,
		PayTo:             requirements.PayTo,
		Asset:             requirements.Asset,
		Amount:            requirements.Amount,
		MaxTimeoutSeconds: requirements.MaxTimeoutSeconds,
		Extra:             requirements.Extra,
		Resource:          resourceFrom(ctx),
	})
	if err != nil {
		return types.PaymentPayload{}, err
	}
	if result == nil || result.Transaction == "" {
		return types.PaymentPayload{}, errors.New("cardano signer returned an empty transaction")
	}
	if _, _, err := cardano.ParseUtxoRef(result.Nonce); err != nil {
		return types.PaymentPayload{}, fmt.Errorf("cardano signer returned an invalid nonce: %s", result.Nonce)
	}
	payload := cardano.ExactCardanoPayload{Transaction: result.Transaction, Nonce: result.Nonce}
	return types.PaymentPayload{X402Version: 2, Payload: payload.ToMap()}, nil
}

func resourceFrom(ctx context.Context) *types.ResourceInfo {
	resource, _ := ctx.Value(resourceKey{}).(*types.ResourceInfo)
	return resource
}
