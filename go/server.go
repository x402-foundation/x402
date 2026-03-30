package x402

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coinbase/x402/go/types"
)

var (
	percentRegex = regexp.MustCompile(`^(\d+(?:\.\d{0,2})?)%$`)
	dollarRegex  = regexp.MustCompile(`^\$(\d+(?:\.\d+)?)$`)
)

// ResolveSettlementOverrideAmount resolves a settlement override amount string
// to a final atomic-unit string. Supports three formats:
//   - Raw atomic units: "1000"
//   - Percent of requirements.Amount: "50%"  (up to 2 decimal places, floored)
//   - Dollar price: "$0.05" (converted using the provided decimals)
func ResolveSettlementOverrideAmount(rawAmount string, requirements types.PaymentRequirements, decimals int) (string, error) {
	if m := percentRegex.FindStringSubmatch(rawAmount); m != nil {
		parts := strings.SplitN(m[1], ".", 2)
		intPart, _ := strconv.ParseInt(parts[0], 10, 64)
		decPart := int64(0)
		if len(parts) == 2 {
			padded := (parts[1] + "00")[:2]
			decPart, _ = strconv.ParseInt(padded, 10, 64)
		}
		scaledPercent := big.NewInt(intPart*100 + decPart)
		base, ok := new(big.Int).SetString(requirements.Amount, 10)
		if !ok {
			return "", fmt.Errorf("invalid requirements amount: %s", requirements.Amount)
		}
		result := new(big.Int).Mul(base, scaledPercent)
		result.Div(result, big.NewInt(10000))
		return result.String(), nil
	}

	if m := dollarRegex.FindStringSubmatch(rawAmount); m != nil {
		dollarFloat, ok := new(big.Float).SetPrec(256).SetString(m[1])
		if !ok {
			return "", fmt.Errorf("invalid dollar amount: %s", rawAmount)
		}
		multiplier := new(big.Float).SetPrec(256).SetInt(
			new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil),
		)
		atomicFloat := new(big.Float).SetPrec(256).Mul(dollarFloat, multiplier)
		atomicInt, _ := atomicFloat.Int(nil) // truncates toward zero (floor for positive values)
		return atomicInt.String(), nil
	}

	return rawAmount, nil
}

// x402ResourceServer manages payment requirements and verification for protected resources
// V2 ONLY - This server only produces and accepts V2 payments
type x402ResourceServer struct {
	mu sync.RWMutex

	// V2 only - server only produces/accepts V2 (default, no suffix)
	schemes map[Network]map[string]SchemeNetworkServer

	// Facilitator clients by network/scheme (can handle both V1 and V2)
	facilitatorClients     map[Network]map[string]FacilitatorClient
	tempFacilitatorClients []FacilitatorClient // Temp storage until Initialize

	registeredExtensions map[string]types.ResourceServerExtension
	supportedCache       *SupportedCache

	// Lifecycle hooks
	beforeVerifyHooks    []BeforeVerifyHook
	afterVerifyHooks     []AfterVerifyHook
	onVerifyFailureHooks []OnVerifyFailureHook
	beforeSettleHooks    []BeforeSettleHook
	afterSettleHooks     []AfterSettleHook
	onSettleFailureHooks []OnSettleFailureHook
}

// SupportedCache caches facilitator capabilities
type SupportedCache struct {
	mu     sync.RWMutex
	data   map[string]SupportedResponse // key is facilitator identifier
	expiry map[string]time.Time
	ttl    time.Duration
}

// Set stores a supported response in the cache
func (c *SupportedCache) Set(key string, response SupportedResponse) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.data[key] = response
	c.expiry[key] = time.Now().Add(c.ttl)
}

// Get retrieves a supported response from the cache
func (c *SupportedCache) Get(key string) (SupportedResponse, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	response, exists := c.data[key]
	if !exists {
		return SupportedResponse{}, false
	}

	// Check if expired
	if time.Now().After(c.expiry[key]) {
		return SupportedResponse{}, false
	}

	return response, true
}

// ResourceServerOption configures the server
type ResourceServerOption func(*x402ResourceServer)

// WithFacilitatorClient adds a facilitator client
func WithFacilitatorClient(client FacilitatorClient) ResourceServerOption {
	return func(s *x402ResourceServer) {
		// Store temporarily - will populate map in Initialize
		if s.tempFacilitatorClients == nil {
			s.tempFacilitatorClients = []FacilitatorClient{}
		}
		s.tempFacilitatorClients = append(s.tempFacilitatorClients, client)
	}
}

// WithSchemeServer registers a scheme server implementation (V2, default)
func WithSchemeServer(network Network, schemeServer SchemeNetworkServer) ResourceServerOption {
	return func(s *x402ResourceServer) {
		s.Register(network, schemeServer)
	}
}

// WithCacheTTL sets the cache TTL for supported kinds
func WithCacheTTL(ttl time.Duration) ResourceServerOption {
	return func(s *x402ResourceServer) {
		s.supportedCache.ttl = ttl
	}
}

func Newx402ResourceServer(opts ...ResourceServerOption) *x402ResourceServer {
	s := &x402ResourceServer{
		schemes:              make(map[Network]map[string]SchemeNetworkServer),
		facilitatorClients:   make(map[Network]map[string]FacilitatorClient),
		registeredExtensions: make(map[string]types.ResourceServerExtension),
		supportedCache: &SupportedCache{
			data:   make(map[string]SupportedResponse),
			expiry: make(map[string]time.Time),
			ttl:    5 * time.Minute,
		},
	}

	for _, opt := range opts {
		opt(s)
	}

	return s
}

// Initialize populates facilitator clients by querying GetSupported
func (s *x402ResourceServer) Initialize(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, client := range s.tempFacilitatorClients {
		// Get supported kinds
		supported, err := client.GetSupported(ctx)
		if err != nil {
			return fmt.Errorf("failed to get supported from facilitator: %w", err)
		}

		// Populate facilitatorClients map from kinds (now flat array with version in each element)
		for _, kind := range supported.Kinds {
			network := Network(kind.Network)
			scheme := kind.Scheme

			if s.facilitatorClients[network] == nil {
				s.facilitatorClients[network] = make(map[string]FacilitatorClient)
			}

			// Only set if not already present (precedence to earlier clients)
			if s.facilitatorClients[network][scheme] == nil {
				s.facilitatorClients[network][scheme] = client
			}
		}

		// Cache the supported response
		s.supportedCache.Set(fmt.Sprintf("facilitator_%p", client), supported)
	}

	return nil
}

// HasRegisteredScheme checks if a scheme is registered for a given network
func (s *x402ResourceServer) HasRegisteredScheme(network Network, scheme string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	networkSchemes, ok := s.schemes[network]
	if !ok {
		return false
	}
	_, exists := networkSchemes[scheme]
	return exists
}

// HasFacilitatorSupport checks if a facilitator client supports a given network/scheme combination
func (s *x402ResourceServer) HasFacilitatorSupport(network Network, scheme string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	networkClients, ok := s.facilitatorClients[network]
	if !ok {
		return false
	}
	_, exists := networkClients[scheme]
	return exists
}

// Register registers a payment mechanism (V2, default)
func (s *x402ResourceServer) Register(network Network, schemeServer SchemeNetworkServer) *x402ResourceServer {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.schemes[network] == nil {
		s.schemes[network] = make(map[string]SchemeNetworkServer)
	}

	s.schemes[network][schemeServer.Scheme()] = schemeServer
	return s
}

func (s *x402ResourceServer) RegisterExtension(extension types.ResourceServerExtension) *x402ResourceServer {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.registeredExtensions[extension.Key()] = extension
	return s
}

// ============================================================================
// Hook Registration Methods (Chainable)
// ============================================================================

func (s *x402ResourceServer) OnBeforeVerify(hook BeforeVerifyHook) *x402ResourceServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.beforeVerifyHooks = append(s.beforeVerifyHooks, hook)
	return s
}

func (s *x402ResourceServer) OnAfterVerify(hook AfterVerifyHook) *x402ResourceServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.afterVerifyHooks = append(s.afterVerifyHooks, hook)
	return s
}

func (s *x402ResourceServer) OnVerifyFailure(hook OnVerifyFailureHook) *x402ResourceServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onVerifyFailureHooks = append(s.onVerifyFailureHooks, hook)
	return s
}

func (s *x402ResourceServer) OnBeforeSettle(hook BeforeSettleHook) *x402ResourceServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.beforeSettleHooks = append(s.beforeSettleHooks, hook)
	return s
}

func (s *x402ResourceServer) OnAfterSettle(hook AfterSettleHook) *x402ResourceServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.afterSettleHooks = append(s.afterSettleHooks, hook)
	return s
}

func (s *x402ResourceServer) OnSettleFailure(hook OnSettleFailureHook) *x402ResourceServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onSettleFailureHooks = append(s.onSettleFailureHooks, hook)
	return s
}

// ============================================================================
// Core Payment Methods (V2 Only)
// ============================================================================

func mergeExtraFields(parsedExtra map[string]interface{}, configExtra map[string]interface{}) map[string]interface{} {
	if len(parsedExtra) == 0 && len(configExtra) == 0 {
		return nil
	}

	merged := make(map[string]interface{}, len(parsedExtra)+len(configExtra))
	for key, value := range parsedExtra {
		merged[key] = value
	}
	for key, value := range configExtra {
		merged[key] = value
	}

	return merged
}

// BuildPaymentRequirements creates payment requirements for a resource
func (s *x402ResourceServer) BuildPaymentRequirements(
	ctx context.Context,
	config ResourceConfig,
	supportedKind types.SupportedKind,
	extensions []string,
) (types.PaymentRequirements, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Find the scheme server
	scheme := config.Scheme
	network := config.Network

	schemeServer := s.schemes[network][scheme]
	if schemeServer == nil {
		return types.PaymentRequirements{}, &PaymentError{
			Code:    ErrCodeUnsupportedScheme,
			Message: fmt.Sprintf("no scheme server for %s on %s", scheme, network),
		}
	}

	// Parse price to get asset/amount
	assetAmount, err := schemeServer.ParsePrice(config.Price, network)
	if err != nil {
		return types.PaymentRequirements{}, err
	}

	// Apply default timeout if not specified
	maxTimeout := config.MaxTimeoutSeconds
	if maxTimeout == 0 {
		maxTimeout = 60 // Default to 60 seconds
	}

	// Build base requirements
	requirements := types.PaymentRequirements{
		Scheme:            scheme,
		Network:           string(network),
		Asset:             assetAmount.Asset,
		Amount:            assetAmount.Amount,
		PayTo:             config.PayTo,
		MaxTimeoutSeconds: maxTimeout,
		Extra:             mergeExtraFields(assetAmount.Extra, config.Extra),
	}

	// Enhance with scheme-specific details
	enhanced, err := schemeServer.EnhancePaymentRequirements(ctx, requirements, supportedKind, extensions)
	if err != nil {
		return types.PaymentRequirements{}, err
	}

	return enhanced, nil
}

// FindMatchingRequirements finds requirements that match a payment payload
func (s *x402ResourceServer) FindMatchingRequirements(available []types.PaymentRequirements, payload types.PaymentPayload) *types.PaymentRequirements {
	for _, req := range available {
		if payload.Accepted.Scheme == req.Scheme &&
			payload.Accepted.Network == req.Network &&
			payload.Accepted.Amount == req.Amount &&
			payload.Accepted.Asset == req.Asset &&
			payload.Accepted.PayTo == req.PayTo {
			return &req
		}
	}
	return nil
}

// VerifyPayment verifies a V2 payment
func (s *x402ResourceServer) VerifyPayment(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements) (*VerifyResponse, error) {
	// Marshal to bytes early for hooks (escape hatch for extensions)
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, NewVerifyError(ErrFailedToMarshalPayload, "", err.Error())
	}

	requirementsBytes, err := json.Marshal(requirements)
	if err != nil {
		return nil, NewVerifyError(ErrFailedToMarshalRequirements, "", err.Error())
	}

	// Execute beforeVerify hooks
	hookCtx := VerifyContext{
		Ctx:               ctx,
		Payload:           payload,
		Requirements:      requirements,
		PayloadBytes:      payloadBytes,
		RequirementsBytes: requirementsBytes,
	}

	for _, hook := range s.beforeVerifyHooks {
		result, err := hook(hookCtx)
		if err != nil {
			return nil, err
		}
		if result != nil && result.Abort {
			return nil, NewVerifyError(result.Reason, "", result.Message)
		}
	}

	s.mu.RLock()
	scheme := requirements.Scheme
	network := Network(requirements.Network)

	facilitator := s.facilitatorClients[network][scheme]
	s.mu.RUnlock()

	if facilitator == nil {
		return nil, NewVerifyError(ErrNoFacilitatorForNetwork, "", fmt.Sprintf("no facilitator for %s on %s", scheme, network))
	}

	// Use already marshaled bytes for network call
	verifyResult, verifyErr := facilitator.Verify(ctx, payloadBytes, requirementsBytes)

	// Handle failure
	if verifyErr != nil {
		failureCtx := VerifyFailureContext{VerifyContext: hookCtx, Error: verifyErr}
		for _, hook := range s.onVerifyFailureHooks {
			result, _ := hook(failureCtx)
			if result != nil && result.Recovered {
				return result.Result, nil
			}
		}
		return verifyResult, verifyErr
	}

	// Execute afterVerify hooks
	resultCtx := VerifyResultContext{VerifyContext: hookCtx, Result: verifyResult}
	for _, hook := range s.afterVerifyHooks {
		_ = hook(resultCtx) // Log errors but don't fail
	}

	return verifyResult, nil
}

// SettlePayment settles a V2 payment.
// If overrides is non-nil and overrides.Amount is set, the effective requirements amount
// is replaced before settlement (partial settlement for upto scheme).
func (s *x402ResourceServer) SettlePayment(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements, overrides *SettlementOverrides) (*SettleResponse, error) {
	effectiveRequirements := requirements
	if overrides != nil && overrides.Amount != "" {
		decimals := 6
		s.mu.RLock()
		network := Network(requirements.Network)
		if networkSchemes, ok := s.schemes[network]; ok {
			if scheme, ok := networkSchemes[requirements.Scheme]; ok {
				if dp, ok := scheme.(AssetDecimalsProvider); ok {
					decimals = dp.GetAssetDecimals(requirements.Asset, network)
				}
			}
		}
		s.mu.RUnlock()
		resolved, err := ResolveSettlementOverrideAmount(overrides.Amount, requirements, decimals)
		if err != nil {
			return nil, NewSettleError("invalid_settlement_override", "", Network(requirements.Network), "", err.Error())
		}
		effectiveRequirements.Amount = resolved
	}

	// Marshal to bytes early for hooks (escape hatch for extensions)
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, NewSettleError("failed_to_marshal_payload", "", Network(effectiveRequirements.Network), "", err.Error())
	}

	requirementsBytes, err := json.Marshal(effectiveRequirements)
	if err != nil {
		return nil, NewSettleError("failed_to_marshal_requirements", "", Network(effectiveRequirements.Network), "", err.Error())
	}

	// Execute beforeSettle hooks
	hookCtx := SettleContext{
		Ctx:               ctx,
		Payload:           payload,
		Requirements:      effectiveRequirements,
		PayloadBytes:      payloadBytes,
		RequirementsBytes: requirementsBytes,
	}

	for _, hook := range s.beforeSettleHooks {
		result, err := hook(hookCtx)
		if err != nil {
			return nil, err
		}
		if result != nil && result.Abort {
			return nil, NewSettleError(result.Reason, "", Network(effectiveRequirements.Network), "", "")
		}
	}

	s.mu.RLock()
	scheme := effectiveRequirements.Scheme
	network := Network(effectiveRequirements.Network)

	facilitator := s.facilitatorClients[network][scheme]
	s.mu.RUnlock()

	if facilitator == nil {
		return nil, NewSettleError("no_facilitator", "", network, "", fmt.Sprintf("no facilitator for %s on %s", scheme, network))
	}

	// Use already marshaled bytes for network call
	settleResult, settleErr := facilitator.Settle(ctx, payloadBytes, requirementsBytes)

	// Handle failure
	if settleErr != nil {
		failureCtx := SettleFailureContext{SettleContext: hookCtx, Error: settleErr}
		for _, hook := range s.onSettleFailureHooks {
			result, _ := hook(failureCtx)
			if result != nil && result.Recovered {
				return result.Result, nil
			}
		}
		return settleResult, settleErr
	}

	// Execute afterSettle hooks
	resultCtx := SettleResultContext{SettleContext: hookCtx, Result: settleResult}
	for _, hook := range s.afterSettleHooks {
		_ = hook(resultCtx) // Log errors but don't fail
	}

	return settleResult, nil
}

// EnrichExtensions enriches declared extensions using registered extension hooks.
func (s *x402ResourceServer) EnrichExtensions(
	declaredExtensions map[string]interface{},
	transportContext interface{},
) map[string]interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()

	enriched := make(map[string]interface{})
	for key, declaration := range declaredExtensions {
		ext, ok := s.registeredExtensions[key]
		if ok {
			enriched[key] = ext.EnrichDeclaration(declaration, transportContext)
		} else {
			enriched[key] = declaration
		}
	}
	return enriched
}

// CreatePaymentRequiredResponse creates a V2 PaymentRequired response
func (s *x402ResourceServer) CreatePaymentRequiredResponse(
	requirements []types.PaymentRequirements,
	resourceInfo *types.ResourceInfo,
	errorMsg string,
	extensions map[string]interface{},
) types.PaymentRequired {
	return types.PaymentRequired{
		X402Version: 2,
		Error:       errorMsg,
		Resource:    resourceInfo,
		Accepts:     requirements,
		Extensions:  extensions,
	}
}

// ProcessPaymentRequest processes a payment request end-to-end
func (s *x402ResourceServer) ProcessPaymentRequest(
	ctx context.Context,
	config ResourceConfig,
	payload *types.PaymentPayload,
) (*types.PaymentRequirements, *VerifyResponse, error) {
	// This is a stub - needs full implementation
	// For now, return error
	return nil, nil, fmt.Errorf("not implemented")
}

// BuildPaymentRequirementsFromConfig builds payment requirements from config
// This wraps the single requirement builder with facilitator data
func (s *x402ResourceServer) BuildPaymentRequirementsFromConfig(ctx context.Context, config ResourceConfig) ([]types.PaymentRequirements, error) {
	// Find supported kind for this scheme/network
	s.mu.RLock()
	defer s.mu.RUnlock()

	schemeServer := s.schemes[config.Network][config.Scheme]
	if schemeServer == nil {
		return nil, fmt.Errorf("no scheme server for %s on %s", config.Scheme, config.Network)
	}

	// Look up cached supported kinds from facilitator
	// This was populated during Initialize() by querying facilitator's /supported endpoint
	var supportedKind types.SupportedKind
	foundKind := false

	// Check each cached facilitator response for matching supported kind
	s.supportedCache.mu.RLock()
	for _, cachedResponse := range s.supportedCache.data {
		// Iterate through flat kinds array (version is in each element)
		for _, kind := range cachedResponse.Kinds {
			// Match on scheme and network (only check V2 kinds)
			if kind.X402Version == 2 && kind.Scheme == config.Scheme && string(kind.Network) == string(config.Network) {
				supportedKind = types.SupportedKind{
					X402Version: kind.X402Version,
					Scheme:      kind.Scheme,
					Network:     string(kind.Network),
					Extra:       kind.Extra, // This includes feePayer for SVM!
				}
				foundKind = true
				break
			}
		}
		if foundKind {
			break
		}
	}
	s.supportedCache.mu.RUnlock()

	// If no cached kind found, create a basic one (fallback for cases without facilitator)
	if !foundKind {
		supportedKind = types.SupportedKind{
			Scheme:  config.Scheme,
			Network: string(config.Network),
			Extra:   make(map[string]interface{}),
		}
	}

	requirement, err := s.BuildPaymentRequirements(ctx, config, supportedKind, []string{})
	if err != nil {
		return nil, err
	}

	return []types.PaymentRequirements{requirement}, nil
}

// Helper functions use the generic findSchemesByNetwork from utils.go
