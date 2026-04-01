package facilitator

import (
	"context"
	"fmt"
	"math/rand"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/mechanisms/evm"
	"github.com/coinbase/x402/go/types"
)

type UptoEvmSchemeConfig struct {
	SimulateInSettle bool
}

// UptoEvmScheme implements the SchemeNetworkFacilitator interface for EVM upto payments (V2).
// Only supports Permit2 (no EIP-3009 path).
type UptoEvmScheme struct {
	signer evm.FacilitatorEvmSigner
	config UptoEvmSchemeConfig
}

func NewUptoEvmScheme(signer evm.FacilitatorEvmSigner, config *UptoEvmSchemeConfig) *UptoEvmScheme {
	cfg := UptoEvmSchemeConfig{}
	if config != nil {
		cfg = *config
	}
	return &UptoEvmScheme{
		signer: signer,
		config: cfg,
	}
}

func (f *UptoEvmScheme) Scheme() string {
	return evm.SchemeUpto
}

// CaipFamily returns the CAIP family pattern this facilitator supports
func (f *UptoEvmScheme) CaipFamily() string {
	return "eip155:*"
}

// GetExtra returns mechanism-specific extra data for the supported kinds endpoint.
// For upto, returns the facilitatorAddress so clients include it in their signed witness.
func (f *UptoEvmScheme) GetExtra(_ x402.Network) map[string]interface{} {
	addresses := f.signer.GetAddresses()
	if len(addresses) == 0 {
		return nil
	}
	return map[string]interface{}{
		"facilitatorAddress": addresses[rand.Intn(len(addresses))],
	}
}

// GetSigners returns signer addresses used by this facilitator.
func (f *UptoEvmScheme) GetSigners(_ x402.Network) []string {
	return f.signer.GetAddresses()
}

// Verify verifies a V2 upto payment payload against requirements.
func (f *UptoEvmScheme) Verify(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	if !evm.IsUptoPermit2Payload(payload.Payload) {
		return nil, x402.NewVerifyError(ErrUptoInvalidPayload, "", "unsupported payload type: expected upto permit2 payload")
	}

	permit2Payload, err := evm.UptoPermit2PayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrUptoInvalidPayload, "", fmt.Sprintf("failed to parse upto Permit2 payload: %s", err.Error()))
	}

	return VerifyUptoPermit2(ctx, f.signer, payload, requirements, permit2Payload, fctx, true)
}

// Settle settles a V2 upto payment on-chain.
func (f *UptoEvmScheme) Settle(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	if !evm.IsUptoPermit2Payload(payload.Payload) {
		network := x402.Network(payload.Accepted.Network)
		return nil, x402.NewSettleError(ErrUptoInvalidPayload, "", network, "", "unsupported payload type: expected upto permit2 payload")
	}

	permit2Payload, err := evm.UptoPermit2PayloadFromMap(payload.Payload)
	if err != nil {
		network := x402.Network(payload.Accepted.Network)
		return nil, x402.NewSettleError(ErrUptoInvalidPayload, "", network, "", fmt.Sprintf("failed to parse upto Permit2 payload: %s", err.Error()))
	}

	return SettleUptoPermit2(ctx, f.signer, payload, requirements, permit2Payload, fctx, f.config.SimulateInSettle)
}
