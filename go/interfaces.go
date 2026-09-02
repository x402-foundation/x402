package x402

import (
	"context"

	"github.com/x402-foundation/x402/go/v2/types"
)

// MoneyParser is a function that converts a decimal amount to an AssetAmount
// If the parser cannot handle the conversion, it should return nil
// Multiple parsers can be registered and will be tried in order
// The default parser is always used as a fallback
//
// Args:
//
//	amount: Decimal string (e.g., "1.50" for $1.50)
//	network: Network identifier
//
// Returns:
//
//	AssetAmount or nil if this parser cannot handle the conversion
type MoneyParser func(amount string, network Network) (*AssetAmount, error)

// ============================================================================
// V1 Interfaces (Legacy - explicitly versioned)
// ============================================================================

// SchemeNetworkClientV1 is implemented by client-side V1 payment mechanisms
type SchemeNetworkClientV1 interface {
	Scheme() string
	CreatePaymentPayload(ctx context.Context, requirements types.PaymentRequirementsV1) (types.PaymentPayloadV1, error)
}

// SchemeNetworkFacilitatorV1 is implemented by facilitator-side V1 payment mechanisms
type SchemeNetworkFacilitatorV1 interface {
	Scheme() string

	// CaipFamily returns the CAIP family pattern this facilitator supports.
	// Used to group signers by blockchain family in the supported response.
	//
	// Examples:
	//   - EVM facilitators return "eip155:*"
	//   - SVM facilitators return "solana:*"
	CaipFamily() string

	// GetExtra returns mechanism-specific extra data for the supported kinds endpoint.
	// This method is called when building the facilitator's supported response.
	//
	// For EVM schemes, return nil (no extra data needed).
	// For SVM schemes, return map with feePayer address.
	//
	// Args:
	//   network: Network identifier for context
	//
	// Returns:
	//   Extra data map or nil if no extra data is needed
	GetExtra(network Network) map[string]interface{}

	// GetSigners returns signer addresses used by this facilitator for a given network.
	// These are included in the supported response to help clients understand
	// which addresses might sign/pay for transactions.
	//
	// Supports multiple addresses for load balancing, key rotation, and high availability.
	//
	// Args:
	//   network: Network identifier
	//
	// Returns:
	//   Array of signer addresses
	//
	// Examples:
	//   - EVM: Returns facilitator wallet addresses
	//   - SVM: Returns fee payer addresses
	GetSigners(network Network) []string

	Verify(ctx context.Context, payload types.PaymentPayloadV1, requirements types.PaymentRequirementsV1, fctx *FacilitatorContext) (*VerifyResponse, error)
	Settle(ctx context.Context, payload types.PaymentPayloadV1, requirements types.PaymentRequirementsV1, fctx *FacilitatorContext) (*SettleResponse, error)
}

// Note: No SchemeNetworkServerV1 - new SDK servers are V2 only

// ============================================================================
// V2 Interfaces (Current - default, no version suffix)
// ============================================================================

// SchemeNetworkClient is implemented by client-side payment mechanisms (V2)
type SchemeNetworkClient interface {
	Scheme() string
	CreatePaymentPayload(ctx context.Context, requirements types.PaymentRequirements) (types.PaymentPayload, error)
}

// ExtensionAwareClient is an optional interface for schemes that can handle extensions.
// When a scheme implements this, x402Client will call CreatePaymentPayloadWithExtensions
// instead of CreatePaymentPayload, passing the server-declared extensions so the scheme
// can enrich the payload (e.g., EIP-2612 gas sponsoring).
type ExtensionAwareClient interface {
	SchemeNetworkClient
	CreatePaymentPayloadWithExtensions(ctx context.Context, requirements types.PaymentRequirements, extensions map[string]interface{}) (types.PaymentPayload, error)
}

// DefaultAssetFinder is an optional reverse lookup for USD spend caps.
// Not the same as AssetDecimalsProvider.
type DefaultAssetFinder interface {
	FindDefaultAsset(asset string, network Network) *DefaultAsset
}

// PaymentResponseContext is passed to PaymentResponseHandler implementations after
// the transport receives the response to a paid request. Exactly one of SettleResponse
// or PaymentRequired is populated:
//
//   - SettleResponse: the request succeeded (HTTP 200) and the server returned a
//     PAYMENT-RESPONSE header carrying the settle outcome.
//   - PaymentRequired: the request was rejected (HTTP 402) with a corrective
//     PAYMENT-REQUIRED header (e.g. cumulative_amount_mismatch).
//
// Mirrors the TS PaymentResponseContext shape consumed by SchemeClientHooks.onPaymentResponse.
type PaymentResponseContext struct {
	PaymentPayload  types.PaymentPayload
	Requirements    types.PaymentRequirements
	SettleResponse  *SettleResponse
	PaymentRequired *types.PaymentRequired
}

// PaymentResponseResult is returned by PaymentResponseHandler.OnPaymentResponse.
// When Recovered is true, the transport may attempt one additional retry with a
// freshly built payment payload. Used to handle corrective 402 responses where
// the scheme has resynced its session state.
type PaymentResponseResult struct {
	Recovered bool
}

// PaymentResponseHandler is an optional interface that SchemeNetworkClient
// implementations satisfy to reconcile local state after a paid response.
// The transport (PaymentRoundTripper) invokes this hook automatically — user
// code does not need to update local channel state manually.
//
// Mirrors the TS schemeHooks.onPaymentResponse field on SchemeClientHooks.
type PaymentResponseHandler interface {
	OnPaymentResponse(ctx context.Context, prCtx PaymentResponseContext) (PaymentResponseResult, error)
}

// ClientExtension can enrich payment payloads on the client side.
// Client extensions are invoked after the scheme creates the base payload
// but before it is returned. Optional transport-specific capabilities can be
// exposed through package-level provider interfaces such as the HTTP client's
// payment-required hook provider.
type ClientExtension interface {
	// Key returns the unique extension identifier (e.g., "eip2612GasSponsoring").
	// Must match the extension key used in PaymentRequired.Extensions.
	Key() string

	// EnrichPaymentPayload is called after payload creation for every registered
	// extension. Allows the extension to enrich the payload with extension-specific
	// data (e.g., builder-code service codes). Extensions that require a server
	// declaration must no-op when the server did not advertise them.
	EnrichPaymentPayload(ctx context.Context, payload types.PaymentPayload, required types.PaymentRequired) (types.PaymentPayload, error)
}

// FacilitatorExtension is the base interface for extensions registered with x402Facilitator.
// Extensions are stored by key and made available to mechanism implementations via FacilitatorContext.
// Specific extensions embed this and add their own capabilities (e.g., a batch signer).
type FacilitatorExtension interface {
	Key() string
}

// facilitatorExtension is a simple concrete implementation of FacilitatorExtension.
type facilitatorExtension struct {
	key string
}

func (e facilitatorExtension) Key() string { return e.key }

// NewFacilitatorExtension creates a FacilitatorExtension with the given key.
func NewFacilitatorExtension(key string) FacilitatorExtension {
	return facilitatorExtension{key: key}
}

// FacilitatorContext provides access to registered facilitator extensions.
// Passed to SchemeNetworkFacilitator.Verify/Settle so mechanism implementations
// can retrieve extension-provided capabilities.
type FacilitatorContext struct {
	extensions map[string]FacilitatorExtension
}

// NewFacilitatorContext creates a FacilitatorContext from the given extensions map.
func NewFacilitatorContext(extensions map[string]FacilitatorExtension) *FacilitatorContext {
	return &FacilitatorContext{extensions: extensions}
}

// GetExtension returns the extension registered under the given key, or nil.
func (c *FacilitatorContext) GetExtension(key string) FacilitatorExtension {
	if c == nil || c.extensions == nil {
		return nil
	}
	return c.extensions[key]
}

// PaymentFlowName is a closed set of payment-flow orchestration modes.
//
// Multi-settle flows (escrow) fire settle lifecycle hooks once per settle.
// Side-effecting hooks should branch on SettleContext.Phase.
type PaymentFlowName string

const (
	PaymentFlowAuthorization PaymentFlowName = "authorization"
	PaymentFlowUpfront       PaymentFlowName = "upfront"
	PaymentFlowEscrow        PaymentFlowName = "escrow"
)

// PaymentFlowPhases are the verify/settle phase flags for a PaymentFlowName.
type PaymentFlowPhases struct {
	VerifyBeforeHandler bool
	SettleBeforeHandler bool
	SettleAfterHandler  bool
}

// PaymentFlowConfig lists supported payment flows for one assetTransferMethod,
// plus the default when extra.paymentFlow is omitted.
type PaymentFlowConfig struct {
	Supported []PaymentFlowName
	// Default must be a member of Supported.
	Default PaymentFlowName
}

// SchemeNetworkServer is implemented by server-side payment mechanisms (V2)
type SchemeNetworkServer interface {
	Scheme() string
	// DefaultAssetTransferMethod is used when requirements.extra.assetTransferMethod
	// is absent. Use SDKDefaultAssetTransferMethod only as SDK plumbing when the
	// scheme has no on-wire ATM.
	DefaultAssetTransferMethod() string
	// PaymentFlows returns payment flows supported per assetTransferMethod.
	// Every ATM the scheme accepts must appear here.
	PaymentFlows() map[string]PaymentFlowConfig
	ParsePrice(price Price, network Network) (AssetAmount, error)
	EnhancePaymentRequirements(
		ctx context.Context,
		requirements types.PaymentRequirements,
		supportedKind types.SupportedKind,
		extensions []string,
	) (types.PaymentRequirements, error)
}

// AssetDecimalsProvider is an optional interface that SchemeNetworkServer implementations
// can satisfy to report the decimal precision of the asset for a given network.
// SettlePayment uses this to convert dollar-format settlement overrides to atomic units.
// ok is false when the asset is not a known default (TS undefined).
type AssetDecimalsProvider interface {
	GetAssetDecimals(asset string, network Network) (decimals int, ok bool)
}

// SettleOnCancelProvider is an optional interface for schemes that settle once when a
// verified payment is canceled (handler failure/throw or post-verify abort).
// Core calls SettlePayment with the returned requirements and SettlePhaseCancel.
// Return nil, nil to skip cancel settle.
type SettleOnCancelProvider interface {
	SettleOnCancel(ctx VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error)
}

// DynamicExtraFieldsProvider is an optional interface for schemes that regenerate
// per-response keys under PaymentRequirements.Extra (e.g. recentBlockhash).
// FindMatchingRequirements omits these fields from the v2 extra comparison.
type DynamicExtraFieldsProvider interface {
	DynamicExtraFields() []string
}

// PaymentRequiredContext is passed to PaymentRequiredEnricher.EnrichPaymentRequiredResponse.
// PaymentPayload is non-nil only on the verify-failure branch.
type PaymentRequiredContext struct {
	Requirements            []types.PaymentRequirements
	PaymentPayload          *types.PaymentPayload
	ResourceInfo            *types.ResourceInfo
	Error                   string
	PaymentRequiredResponse *types.PaymentRequired
}

// PaymentRequiredEnricher is an optional interface for SchemeNetworkServer
// implementations that want to add per-scheme corrective state to the 402
// response. Invoked once per matching scheme during PaymentRequired construction;
// implementations may mutate ctx.Requirements entries in place.
type PaymentRequiredEnricher interface {
	EnrichPaymentRequiredResponse(ctx PaymentRequiredContext)
}

// FacilitatorSupportValidator is an optional interface that SchemeNetworkServer
// implementations can satisfy to validate facilitator capabilities at startup.
// Invoked during Initialize(), only when the facilitator supports the
// scheme/network. Returns a non-nil error describing the problem when the
// configuration cannot be fulfilled, or nil when valid.
type FacilitatorSupportValidator interface {
	ValidateFacilitatorSupport(network Network, supportedKind types.SupportedKind, facilitatorExtensions []string) error
}

// SchemeNetworkFacilitator is implemented by facilitator-side payment mechanisms (V2)
type SchemeNetworkFacilitator interface {
	Scheme() string

	// CaipFamily returns the CAIP family pattern this facilitator supports.
	// Used to group signers by blockchain family in the supported response.
	//
	// Examples:
	//   - EVM facilitators return "eip155:*"
	//   - SVM facilitators return "solana:*"
	CaipFamily() string

	// GetExtra returns mechanism-specific extra data for the supported kinds endpoint.
	// This method is called when building the facilitator's supported response.
	//
	// For EVM schemes, return nil (no extra data needed).
	// For SVM schemes, return map with feePayer address.
	//
	// Args:
	//   network: Network identifier for context
	//
	// Returns:
	//   Extra data map or nil if no extra data is needed
	GetExtra(network Network) map[string]interface{}

	// GetSigners returns signer addresses used by this facilitator for a given network.
	// These are included in the supported response to help clients understand
	// which addresses might sign/pay for transactions.
	//
	// Supports multiple addresses for load balancing, key rotation, and high availability.
	//
	// Args:
	//   network: Network identifier
	//
	// Returns:
	//   Array of signer addresses
	//
	// Examples:
	//   - EVM: Returns facilitator wallet addresses
	//   - SVM: Returns fee payer addresses
	GetSigners(network Network) []string

	Verify(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements, fctx *FacilitatorContext) (*VerifyResponse, error)
	Settle(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements, fctx *FacilitatorContext) (*SettleResponse, error)
}

// ============================================================================
// FacilitatorClient Interfaces (Network Boundary - uses bytes)
// ============================================================================

// FacilitatorClient interface for facilitators that support V1 and/or V2.
// Uses bytes at network boundary - SDK internal routing unmarshals and routes to typed mechanisms.
// Both modern facilitators (supporting V1+V2) and legacy facilitators (V1 only) implement this interface.
type FacilitatorClient interface {
	// Verify a payment (detects version from bytes, routes internally)
	Verify(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*VerifyResponse, error)

	// Settle a payment (detects version from bytes, routes internally)
	Settle(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*SettleResponse, error)

	// GetSupported returns supported payment kinds in flat array format with x402Version in each element (backward compatible)
	GetSupported(ctx context.Context) (SupportedResponse, error)
}
