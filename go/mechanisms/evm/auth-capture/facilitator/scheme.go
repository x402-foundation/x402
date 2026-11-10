package facilitator

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	gethtypes "github.com/ethereum/go-ethereum/core/types"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

// OperatorAddressWildcard admits every contract operator of an entry's type.
const OperatorAddressWildcard = "*"

// OperatorAllowlistEntry admits a contract operator, or every one with OperatorAddressWildcard,
// under the given operator type. Only "custom" is relayed.
type OperatorAllowlistEntry struct {
	Address      string `json:"address"`
	OperatorType string `json:"operatorType"`
}

// AuthCaptureEvmSchemeConfig configures the facilitator for the delegated operator type
// (authorize, charge, capture, void, refund) and, with an allowlist, custom operators.
type AuthCaptureEvmSchemeConfig struct {
	// CaptureAuthorizers is the pool of operator addresses /supported advertises one at a time as
	// extra.captureAuthorizer. Each MUST be one of signer.GetAddresses(), and stay usable (and
	// funded when RefundFunding is on) until its payments pass refundDeadline. Leave it and
	// CaptureAuthorizer empty for a relay-only facilitator that serves only Operators.
	CaptureAuthorizers []string
	// CaptureAuthorizer is a one-element shorthand for CaptureAuthorizers.
	CaptureAuthorizer string
	// SelectCaptureAuthorizer picks the pool member for one /supported response. A nil selector,
	// or a result outside candidates, falls back to a random pick.
	SelectCaptureAuthorizer func(network x402.Network, candidates []string) string
	// FeeRecipient, MinFeeBps and MaxFeeBps are the fee terms advertised in /supported; omit for no fee.
	FeeRecipient string
	MinFeeBps    uint16
	MaxFeeBps    uint16
	// EIP6492AllowedFactories allowlists factories called to deploy counterfactual wallets; empty denies all.
	EIP6492AllowedFactories []string
	// SimulateInSettle reruns collect/lifecycle simulation during settle. Verify always simulates,
	// and settle always does for a charge and for a custom operator.
	SimulateInSettle bool
	// Operators is the allowlist of custom contract operators the facilitator relays collects
	// for. Empty admits none. Custom operators also need a signer implementing CallSimulator
	// and GasLimitWriter.
	Operators []OperatorAllowlistEntry
	// CustomOperatorGasLimit caps simulated and submitted calls into a custom operator; zero
	// selects authcapture.DefaultCustomOperatorGasLimit.
	CustomOperatorGasLimit uint64
	// RefundFunding permits relaying refunds for delegated operators. The refund collector pulls
	// the refunded tokens from the captureAuthorizer, so enable it only with an out-of-band
	// funding agreement that keeps every advertised submitter funded and approved.
	RefundFunding bool

	// AuthorizerSigner enables facilitator-delegated receiver authorization. Its address is
	// advertised as /supported extra.receiverAuthorizer, and the facilitator signs charge and
	// lifecycle digests with it when the server omits authorizerSignature. It requires
	// ResolveCallerIdentity, DelegatedAuthStorage and OnStorageError together;
	// NewAuthCaptureEvmSchemeWithError rejects a config where only some of the four are set.
	AuthorizerSigner evm.ClientEvmSigner
	// ResolveCallerIdentity authenticates the caller of a delegated settle out of band and
	// returns a stable identity. An empty identity or an error rejects the settle. The identity
	// must be the same across the authorize and the later lifecycle settles of one payment.
	ResolveCallerIdentity ResolveCallerIdentity
	// DelegatedAuthStorage holds the caller bindings for delegated payments.
	DelegatedAuthStorage AuthCaptureDelegatedAuthStorage
	// OnStorageError is called when reverting or deleting a binding fails. It must not replace
	// the settle result.
	OnStorageError OnDelegatedAuthStorageError
}

// SimulatedCall is one call of a CallSimulator batch. A zero Gas leaves the limit unset.
type SimulatedCall struct {
	To   string
	Data []byte
	Gas  uint64
}

// SimulatedCallResult is the outcome of one SimulatedCall, with the logs of nested calls.
type SimulatedCallResult struct {
	Success    bool
	ReturnData []byte
	GasUsed    uint64
	Logs       []*gethtypes.Log
}

// Signer is the facilitator signer the scheme needs. The escrow gates authorize, capture and void
// on msg.sender, so simulations and writes must be sent from a chosen operator address, which
// must be one of GetAddresses().
type Signer interface {
	evm.FacilitatorEvmSigner

	ReadContractFrom(ctx context.Context, from, address string, abi []byte, functionName string, args ...interface{}) (interface{}, error)
	WriteContractFrom(ctx context.Context, from, address string, abi []byte, functionName string, dataSuffix []byte, args ...interface{}) (string, error)
}

// CallSimulator is an optional capability of a FacilitatorEvmSigner: run an ordered batch of calls
// against one simulated state (eth_simulateV1), so each call sees the effects of the earlier ones.
// Custom operators need it to check the outcome of a relayed call before it is broadcast.
type CallSimulator interface {
	SimulateCalls(ctx context.Context, from string, calls []SimulatedCall) ([]SimulatedCallResult, error)
}

// GasLimitWriter is an optional capability of a FacilitatorEvmSigner: WriteContract with an
// explicit gas limit. Custom operators need it so a relayed call cannot drain the gas budget.
type GasLimitWriter interface {
	WriteContractWithGas(ctx context.Context, address string, abi []byte, functionName string, dataSuffix []byte, gas uint64, args ...interface{}) (string, error)
}

// AuthCaptureEvmScheme implements SchemeNetworkFacilitator for the auth-capture EVM scheme.
// Escrow simulations and writes are sent from the payment's operator.
type AuthCaptureEvmScheme struct {
	signer             Signer
	config             AuthCaptureEvmSchemeConfig
	captureAuthorizers []string
	pendingStore       x402.PendingSettlementStore
}

// NewAuthCaptureEvmScheme is NewAuthCaptureEvmSchemeWithError that panics on an invalid config.
func NewAuthCaptureEvmScheme(signer Signer, config AuthCaptureEvmSchemeConfig) *AuthCaptureEvmScheme {
	scheme, err := NewAuthCaptureEvmSchemeWithError(signer, config)
	if err != nil {
		panic(err.Error())
	}
	return scheme
}

// NewAuthCaptureEvmSchemeWithError creates a new AuthCaptureEvmScheme. It rejects partial
// delegated-authorizer config and a captureAuthorizer the signer does not hold.
func NewAuthCaptureEvmSchemeWithError(signer Signer, config AuthCaptureEvmSchemeConfig) (*AuthCaptureEvmScheme, error) {
	if err := validateDelegatedReceiverAuthorizerConfig(config); err != nil {
		return nil, err
	}
	pool, err := resolveCaptureAuthorizerPool(signer, config)
	if err != nil {
		return nil, err
	}
	return &AuthCaptureEvmScheme{
		signer:             signer,
		config:             config,
		captureAuthorizers: pool,
		pendingStore:       x402.NewInMemoryPendingSettlementStore(),
	}, nil
}

// resolveCaptureAuthorizerPool returns the deduplicated pool, checked against the signer.
func resolveCaptureAuthorizerPool(signer Signer, config AuthCaptureEvmSchemeConfig) ([]string, error) {
	pool := make([]string, 0, len(config.CaptureAuthorizers)+1)
	seen := make(map[string]bool)
	for _, candidate := range config.CaptureAuthorizers {
		if !authcapture.IsNonZeroAddress(candidate) {
			return nil, fmt.Errorf("CaptureAuthorizers contains an empty or zero address: %q", candidate)
		}
		if key := evm.NormalizeAddress(candidate); !seen[key] {
			seen[key] = true
			pool = append(pool, candidate)
		}
	}
	if config.CaptureAuthorizer != "" {
		if !authcapture.IsNonZeroAddress(config.CaptureAuthorizer) {
			return nil, fmt.Errorf("CaptureAuthorizer is a zero address: %q", config.CaptureAuthorizer)
		}
		key := evm.NormalizeAddress(config.CaptureAuthorizer)
		switch {
		case len(pool) == 0:
			pool = append(pool, config.CaptureAuthorizer)
		case !seen[key]:
			return nil, errors.New("CaptureAuthorizer must be a member of CaptureAuthorizers when both are set")
		}
	}
	if len(pool) == 0 {
		return pool, nil
	}

	controlled := make(map[string]bool)
	for _, address := range signer.GetAddresses() {
		controlled[evm.NormalizeAddress(address)] = true
	}
	for _, candidate := range pool {
		if !controlled[evm.NormalizeAddress(candidate)] {
			return nil, fmt.Errorf("captureAuthorizer %s is not one of the signer's addresses", candidate)
		}
	}
	return pool, nil
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

// supportsCustomOperators reports whether the signer has what relaying into a custom operator needs.
func (f *AuthCaptureEvmScheme) supportsCustomOperators() bool {
	_, simulates := f.signer.(CallSimulator)
	_, capsGas := f.signer.(GasLimitWriter)
	return len(f.config.Operators) > 0 && simulates && capsGas
}

// operatorAdmitted reports whether the allowlist admits address as a custom operator.
func (f *AuthCaptureEvmScheme) operatorAdmitted(address string) bool {
	if !f.supportsCustomOperators() {
		return false
	}
	for _, entry := range f.config.Operators {
		if entry.OperatorType != authcapture.OperatorTypeCustom {
			continue
		}
		if entry.Address == OperatorAddressWildcard || strings.EqualFold(entry.Address, address) {
			return true
		}
	}
	return false
}

// pickCaptureAuthorizer returns the captureAuthorizer to advertise, or "" without a pool.
func (f *AuthCaptureEvmScheme) pickCaptureAuthorizer(network x402.Network) string {
	switch len(f.captureAuthorizers) {
	case 0:
		return ""
	case 1:
		return f.captureAuthorizers[0]
	}
	if f.config.SelectCaptureAuthorizer != nil {
		candidates := append([]string(nil), f.captureAuthorizers...)
		selected := f.config.SelectCaptureAuthorizer(network, candidates)
		for _, candidate := range f.captureAuthorizers {
			if evm.NormalizeAddress(candidate) == evm.NormalizeAddress(selected) {
				return candidate
			}
		}
	}
	return f.captureAuthorizers[rand.IntN(len(f.captureAuthorizers))]
}

// GetExtra returns the facilitator's advertised auth-capture terms for /supported: the capture
// authorizer (a pool member), the receiver authorizer when this facilitator can authenticate delegated requests,
// the fee terms, and the custom-operator allowlist.
func (f *AuthCaptureEvmScheme) GetExtra(network x402.Network) map[string]interface{} {
	extra := map[string]interface{}{}
	if captureAuthorizer := f.pickCaptureAuthorizer(network); captureAuthorizer != "" {
		extra["captureAuthorizer"] = captureAuthorizer
	}
	if f.config.AuthorizerSigner != nil {
		extra["receiverAuthorizer"] = common.HexToAddress(f.config.AuthorizerSigner.Address()).Hex()
	}
	if f.config.FeeRecipient != "" {
		extra["feeRecipient"] = f.config.FeeRecipient
		extra["minFeeBps"] = f.config.MinFeeBps
		extra["maxFeeBps"] = f.config.MaxFeeBps
	}
	if f.supportsCustomOperators() {
		extra["operators"] = f.config.Operators
	}
	if len(extra) == 0 {
		return nil
	}
	return extra
}

// GetSigners returns signer addresses used by this facilitator.
func (f *AuthCaptureEvmScheme) GetSigners(_ x402.Network) []string {
	return f.signer.GetAddresses()
}

// Verify routes to collect or lifecycle (capture, void, refund) verification by payload shape.
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
		return f.verifyCapture(ctx, payload, requirements, fctx)
	case authcapture.IsVoidPayload(payload.Payload):
		return f.verifyVoid(ctx, payload, requirements, fctx)
	case authcapture.IsRefundPayload(payload.Payload):
		return f.verifyRefund(ctx, payload, requirements, fctx)
	default:
		return nil, x402.NewVerifyError(unknownShapeReason(payload.Payload), "", "payload matches no known auth-capture shape")
	}
}

// Settle routes to collect or lifecycle (capture, void, refund) settlement by payload shape.
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
		return f.settleLifecycle(ctx, payload, requirements, fctx, f.settleCapture)
	case authcapture.IsVoidPayload(payload.Payload):
		return f.settleLifecycle(ctx, payload, requirements, fctx, f.settleVoid)
	case authcapture.IsRefundPayload(payload.Payload):
		return f.settleLifecycle(ctx, payload, requirements, fctx, f.settleRefund)
	default:
		network := x402.Network(payload.Accepted.Network)
		return nil, x402.NewSettleError(unknownShapeReason(payload.Payload), "", network, "", "payload matches no known auth-capture shape")
	}
}

// unknownShapeReason is payload_type for a payload naming a lifecycle type we do not know, and
// payload_format for a malformed payload of a known shape.
func unknownShapeReason(payload map[string]interface{}) string {
	switch payload["type"] {
	case nil, opCapture, opVoid, opRefund:
		return ErrPayloadFormat
	}
	return ErrPayloadType
}
