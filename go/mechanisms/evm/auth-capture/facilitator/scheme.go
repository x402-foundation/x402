package facilitator

import (
	"context"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

// AuthCaptureEvmSchemeConfig configures the facilitator for the delegated operator type
// and the escrow flow (authorize, capture, void).
type AuthCaptureEvmSchemeConfig struct {
	// CaptureAuthorizer is the operator address; it MUST be one of signer.GetAddresses().
	CaptureAuthorizer string
	// FeeRecipient, MinFeeBps and MaxFeeBps are the fee terms advertised in /supported; omit for no fee.
	FeeRecipient string
	MinFeeBps    uint16
	MaxFeeBps    uint16
	// EIP6492AllowedFactories allowlists factories called to deploy counterfactual wallets; empty denies all.
	EIP6492AllowedFactories []string
	// SimulateInSettle reruns collect/lifecycle simulation during settle. Verify always simulates.
	SimulateInSettle bool
}

// SenderReader is an optional capability of a FacilitatorEvmSigner: ReadContract with an
// explicit eth_call sender. The scheme uses it to simulate every escrow call as the operator,
// because the escrow gates authorize, capture and void on msg.sender. A signer without it
// must make ReadContract itself call from the operator, which only works when the signer
// holds a single address.
type SenderReader interface {
	ReadContractFrom(ctx context.Context, from, address string, abi []byte, functionName string, args ...interface{}) (interface{}, error)
}

// AuthCaptureEvmScheme implements SchemeNetworkFacilitator for the auth-capture EVM scheme.
// Simulations call as the operator through SenderReader when the signer implements it, else
// the signer's ReadContract must eth_call from the operator address.
type AuthCaptureEvmScheme struct {
	signer       evm.FacilitatorEvmSigner
	config       AuthCaptureEvmSchemeConfig
	pendingStore x402.PendingSettlementStore
}

// NewAuthCaptureEvmScheme creates a new AuthCaptureEvmScheme.
func NewAuthCaptureEvmScheme(signer evm.FacilitatorEvmSigner, config AuthCaptureEvmSchemeConfig) *AuthCaptureEvmScheme {
	return &AuthCaptureEvmScheme{
		signer:       signer,
		config:       config,
		pendingStore: x402.NewInMemoryPendingSettlementStore(),
	}
}

// SetPendingSettlementStore overrides the default in-memory PendingSettlementStore.
func (f *AuthCaptureEvmScheme) SetPendingSettlementStore(store x402.PendingSettlementStore) {
	if store != nil {
		f.pendingStore = store
	}
}

// Scheme returns the scheme identifier.
func (f *AuthCaptureEvmScheme) Scheme() string {
	return authcapture.SchemeAuthCapture
}

// CaipFamily returns the CAIP family pattern this facilitator supports.
func (f *AuthCaptureEvmScheme) CaipFamily() string {
	return "eip155:*"
}

// GetExtra returns the facilitator's advertised auth-capture terms for /supported.
func (f *AuthCaptureEvmScheme) GetExtra(_ x402.Network) map[string]interface{} {
	if f.config.CaptureAuthorizer == "" {
		return nil
	}
	extra := map[string]interface{}{
		"captureAuthorizer": f.config.CaptureAuthorizer,
	}
	if f.config.FeeRecipient != "" {
		extra["feeRecipient"] = f.config.FeeRecipient
		extra["minFeeBps"] = f.config.MinFeeBps
		extra["maxFeeBps"] = f.config.MaxFeeBps
	}
	return extra
}

// GetSigners returns signer addresses used by this facilitator.
func (f *AuthCaptureEvmScheme) GetSigners(_ x402.Network) []string {
	return f.signer.GetAddresses()
}

// Verify routes to collect or lifecycle verification by payload shape.
func (f *AuthCaptureEvmScheme) Verify(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	switch {
	case authcapture.IsEip3009Payload(payload.Payload), authcapture.IsPermit2Payload(payload.Payload):
		return f.verifyCollect(ctx, payload, requirements)
	case authcapture.IsCapturePayload(payload.Payload):
		return f.verifyCapture(ctx, payload, requirements)
	case authcapture.IsVoidPayload(payload.Payload):
		return f.verifyVoid(ctx, payload, requirements)
	default:
		return nil, x402.NewVerifyError(ErrPayloadFormat, "", "payload matches no known auth-capture shape")
	}
}

// Settle routes to collect or lifecycle settlement by payload shape.
func (f *AuthCaptureEvmScheme) Settle(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	switch {
	case authcapture.IsEip3009Payload(payload.Payload), authcapture.IsPermit2Payload(payload.Payload):
		return f.settleCollect(ctx, payload, requirements, fctx)
	case authcapture.IsCapturePayload(payload.Payload):
		return f.settleCapture(ctx, payload, requirements, fctx)
	case authcapture.IsVoidPayload(payload.Payload):
		return f.settleVoid(ctx, payload, requirements, fctx)
	default:
		network := x402.Network(payload.Accepted.Network)
		return nil, x402.NewSettleError(ErrPayloadFormat, "", network, "", "payload matches no known auth-capture shape")
	}
}
