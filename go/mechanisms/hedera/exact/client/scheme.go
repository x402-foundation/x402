package client

import (
	"context"
	"fmt"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/hedera"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	ErrUnsupportedScheme              = "unsupported_scheme"
	ErrMissingFeePayer                = "missing_fee_payer"
	ErrUnsupportedAssetTransferMethod = "unsupported_asset_transfer_method"
)

// ExactHederaScheme implements SchemeNetworkClient for Hedera exact (V2).
type ExactHederaScheme struct {
	signer hedera.ClientHederaSigner
}

// NewExactHederaScheme creates a client-side Hedera exact scheme.
func NewExactHederaScheme(signer hedera.ClientHederaSigner) *ExactHederaScheme {
	return &ExactHederaScheme{signer: signer}
}

func (c *ExactHederaScheme) Scheme() string { return hedera.SchemeExact }

// FindDefaultAsset implements x402.DefaultAssetFinder for spend-cap resolution.
func (c *ExactHederaScheme) FindDefaultAsset(asset string, network x402.Network) *x402.DefaultAsset {
	info := hedera.FindDefaultAsset(asset, string(network))
	if info == nil {
		return nil
	}
	return &x402.DefaultAsset{Asset: info.Asset, Decimals: info.Decimals, Symbol: info.Symbol}
}

func (c *ExactHederaScheme) CreatePaymentPayload(
	ctx context.Context,
	requirements types.PaymentRequirements,
	_ x402.PaymentPayloadContext,
) (types.PaymentPayload, error) {
	if requirements.Scheme != hedera.SchemeExact {
		return types.PaymentPayload{}, fmt.Errorf("%s: %s", ErrUnsupportedScheme, requirements.Scheme)
	}
	if err := hedera.AssertSupportedNetwork(string(requirements.Network)); err != nil {
		return types.PaymentPayload{}, err
	}
	if method, ok := hedera.AssetTransferMethod(requirements.Extra); !ok || method != hedera.AssetTransferMethodCryptoTransfer {
		return types.PaymentPayload{}, fmt.Errorf("%s: %v", ErrUnsupportedAssetTransferMethod, requirements.Extra["assetTransferMethod"])
	}
	if _, ok := requirements.Extra["feePayer"].(string); !ok {
		return types.PaymentPayload{}, fmt.Errorf("%s: feePayer is required in paymentRequirements.extra", ErrMissingFeePayer)
	}

	txB64, err := c.signer.CreatePartiallySignedTransferTransaction(ctx, requirements)
	if err != nil {
		return types.PaymentPayload{}, err
	}

	return types.PaymentPayload{
		X402Version: 2,
		Payload: map[string]interface{}{
			"transaction": txB64,
		},
		Accepted: requirements,
	}, nil
}
