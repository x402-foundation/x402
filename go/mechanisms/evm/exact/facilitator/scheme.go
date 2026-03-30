package facilitator

import (
	"context"
	"fmt"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/mechanisms/evm"
	"github.com/coinbase/x402/go/types"
)

// ExactEvmSchemeConfig holds configuration for the ExactEvmScheme facilitator
type ExactEvmSchemeConfig struct {
	// DeployERC4337WithEIP6492 enables automatic deployment of ERC-4337 smart wallets
	// via EIP-6492 when encountering undeployed contract signatures during settlement
	DeployERC4337WithEIP6492 bool
	// SimulateInSettle reruns transfer simulation during settle. Verify always simulates.
	SimulateInSettle bool
}

// ExactEvmScheme implements the SchemeNetworkFacilitator interface for EVM exact payments (V2)
type ExactEvmScheme struct {
	signer evm.FacilitatorEvmSigner
	config ExactEvmSchemeConfig
}

// NewExactEvmScheme creates a new ExactEvmScheme
// Args:
//
//	signer: The EVM signer for facilitator operations
//	config: Optional configuration (nil uses defaults)
//
// Returns:
//
//	Configured ExactEvmScheme instance
func NewExactEvmScheme(signer evm.FacilitatorEvmSigner, config *ExactEvmSchemeConfig) *ExactEvmScheme {
	cfg := ExactEvmSchemeConfig{}
	if config != nil {
		cfg = *config
	}
	return &ExactEvmScheme{
		signer: signer,
		config: cfg,
	}
}

// Scheme returns the scheme identifier
func (f *ExactEvmScheme) Scheme() string {
	return evm.SchemeExact
}

// CaipFamily returns the CAIP family pattern this facilitator supports
func (f *ExactEvmScheme) CaipFamily() string {
	return "eip155:*"
}

// GetExtra returns mechanism-specific extra data for the supported kinds endpoint.
// For EVM, no extra data is needed.
func (f *ExactEvmScheme) GetExtra(_ x402.Network) map[string]interface{} {
	return nil
}

// GetSigners returns signer addresses used by this facilitator.
// Returns all addresses this facilitator can use for signing/settling transactions.
func (f *ExactEvmScheme) GetSigners(_ x402.Network) []string {
	return f.signer.GetAddresses()
}

// Verify verifies a V2 payment payload against requirements.
// Routes to EIP-3009 or Permit2 verification based on payload type.
func (f *ExactEvmScheme) Verify(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	isPermit2 := evm.IsPermit2Payload(payload.Payload)

	if isPermit2 {
		permit2Payload, err := evm.Permit2PayloadFromMap(payload.Payload)
		if err != nil {
			return nil, x402.NewVerifyError(ErrInvalidPayload, "", fmt.Sprintf("failed to parse Permit2 payload: %s", err.Error()))
		}
		return VerifyPermit2(ctx, f.signer, payload, requirements, permit2Payload, fctx, nil)
	}

	return f.verifyEIP3009(ctx, payload, requirements, true)
}

// Settle settles a V2 payment on-chain.
// Routes to EIP-3009 or Permit2 settlement based on payload type.
func (f *ExactEvmScheme) Settle(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	isPermit2 := evm.IsPermit2Payload(payload.Payload)

	if isPermit2 {
		permit2Payload, err := evm.Permit2PayloadFromMap(payload.Payload)
		if err != nil {
			network := x402.Network(payload.Accepted.Network)
			return nil, x402.NewSettleError(ErrInvalidPayload, "", network, "", fmt.Sprintf("failed to parse Permit2 payload: %s", err.Error()))
		}
		return SettlePermit2(ctx, f.signer, payload, requirements, permit2Payload, fctx, &Permit2FacilitatorConfig{
			SimulateInSettle: f.config.SimulateInSettle,
		})
	}

	return f.settleEIP3009(ctx, payload, requirements)
}
