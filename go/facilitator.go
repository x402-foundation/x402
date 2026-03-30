package x402

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/coinbase/x402/go/types"
)

// schemeData stores facilitator and its registered networks
type schemeData struct {
	facilitator interface{} // Either SchemeNetworkFacilitator or SchemeNetworkFacilitatorV1
	networks    map[Network]bool
	pattern     Network
}

// x402Facilitator manages payment verification and settlement
// Supports both V1 and V2 for legacy interoperability
type x402Facilitator struct {
	mu sync.RWMutex

	// Separate arrays for V1 and V2 (V2 uses default name, no suffix)
	// Arrays support multiple facilitators with same scheme name
	schemesV1  []*schemeData
	schemes    []*schemeData // V2 (default)
	extensions map[string]FacilitatorExtension

	// Lifecycle hooks
	beforeVerifyHooks    []FacilitatorBeforeVerifyHook
	afterVerifyHooks     []FacilitatorAfterVerifyHook
	onVerifyFailureHooks []FacilitatorOnVerifyFailureHook
	beforeSettleHooks    []FacilitatorBeforeSettleHook
	afterSettleHooks     []FacilitatorAfterSettleHook
	onSettleFailureHooks []FacilitatorOnSettleFailureHook
}

func Newx402Facilitator() *x402Facilitator {
	return &x402Facilitator{
		schemesV1:  []*schemeData{},
		schemes:    []*schemeData{},
		extensions: make(map[string]FacilitatorExtension),
	}
}

// RegisterV1 registers a V1 facilitator mechanism for multiple networks (legacy)
// Networks are stored and used for GetSupported() - no need to specify them later.
func (f *x402Facilitator) RegisterV1(networks []Network, facilitator SchemeNetworkFacilitatorV1) *x402Facilitator {
	f.mu.Lock()
	defer f.mu.Unlock()

	// Create network set
	networkSet := make(map[Network]bool)
	for _, network := range networks {
		networkSet[network] = true
	}

	// Append to array (supports multiple facilitators with same scheme name)
	f.schemesV1 = append(f.schemesV1, &schemeData{
		facilitator: facilitator,
		networks:    networkSet,
		pattern:     derivePattern(networks),
	})

	return f
}

// Register registers a facilitator mechanism for multiple networks (V2, default)
// Networks are stored and used for GetSupported() - no need to specify them later.
func (f *x402Facilitator) Register(networks []Network, facilitator SchemeNetworkFacilitator) *x402Facilitator {
	f.mu.Lock()
	defer f.mu.Unlock()

	// Create network set
	networkSet := make(map[Network]bool)
	for _, network := range networks {
		networkSet[network] = true
	}

	// Append to array (supports multiple facilitators with same scheme name)
	f.schemes = append(f.schemes, &schemeData{
		facilitator: facilitator,
		networks:    networkSet,
		pattern:     derivePattern(networks),
	})

	return f
}

// RegisterExtension registers a protocol extension.
func (f *x402Facilitator) RegisterExtension(extension FacilitatorExtension) *x402Facilitator {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.extensions[extension.Key()] = extension
	return f
}

// GetExtension returns the extension registered under the given key, or nil.
func (f *x402Facilitator) GetExtension(key string) FacilitatorExtension {
	f.mu.RLock()
	defer f.mu.RUnlock()

	return f.extensions[key]
}

// ============================================================================
// Hook Registration Methods
// ============================================================================

func (f *x402Facilitator) OnBeforeVerify(hook FacilitatorBeforeVerifyHook) *x402Facilitator {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.beforeVerifyHooks = append(f.beforeVerifyHooks, hook)
	return f
}

func (f *x402Facilitator) OnAfterVerify(hook FacilitatorAfterVerifyHook) *x402Facilitator {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.afterVerifyHooks = append(f.afterVerifyHooks, hook)
	return f
}

func (f *x402Facilitator) OnVerifyFailure(hook FacilitatorOnVerifyFailureHook) *x402Facilitator {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.onVerifyFailureHooks = append(f.onVerifyFailureHooks, hook)
	return f
}

func (f *x402Facilitator) OnBeforeSettle(hook FacilitatorBeforeSettleHook) *x402Facilitator {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.beforeSettleHooks = append(f.beforeSettleHooks, hook)
	return f
}

func (f *x402Facilitator) OnAfterSettle(hook FacilitatorAfterSettleHook) *x402Facilitator {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.afterSettleHooks = append(f.afterSettleHooks, hook)
	return f
}

func (f *x402Facilitator) OnSettleFailure(hook FacilitatorOnSettleFailureHook) *x402Facilitator {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.onSettleFailureHooks = append(f.onSettleFailureHooks, hook)
	return f
}

// ============================================================================
// Core Payment Methods (Network Boundary - uses bytes, routes internally)
// ============================================================================

// Verify verifies a payment (detects version from bytes, routes to typed mechanism)
func (f *x402Facilitator) Verify(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*VerifyResponse, error) {
	// Detect version
	version, err := types.DetectVersion(payloadBytes)
	if err != nil {
		return nil, NewVerifyError(ErrInvalidVersion, "", fmt.Sprintf("failed to detect version: %s", err.Error()))
	}

	// Unmarshal to typed structs for hooks
	var hookPayload PaymentPayloadView
	var hookRequirements PaymentRequirementsView

	// Route to version-specific method
	switch version {
	case 1:
		payload, err := types.ToPaymentPayloadV1(payloadBytes)
		if err != nil {
			return nil, NewVerifyError(ErrInvalidV1Payload, "", err.Error())
		}
		requirements, err := types.ToPaymentRequirementsV1(requirementsBytes)
		if err != nil {
			return nil, NewVerifyError(ErrInvalidV1Requirements, "", err.Error())
		}

		hookPayload = *payload
		hookRequirements = *requirements

		// Execute beforeVerify hooks
		hookCtx := FacilitatorVerifyContext{
			Ctx:               ctx,
			Payload:           hookPayload,
			Requirements:      hookRequirements,
			PayloadBytes:      payloadBytes,
			RequirementsBytes: requirementsBytes,
		}
		for _, hook := range f.beforeVerifyHooks {
			result, err := hook(hookCtx)
			if err != nil {
				return nil, err
			}
			if result != nil && result.Abort {
				return nil, NewVerifyError(result.Reason, "", result.Message)
			}
		}

		// Call mechanism
		verifyResult, verifyErr := f.verifyV1(ctx, *payload, *requirements)

		// Handle failure
		if verifyErr != nil {
			failureCtx := FacilitatorVerifyFailureContext{FacilitatorVerifyContext: hookCtx, Error: verifyErr}
			for _, hook := range f.onVerifyFailureHooks {
				result, _ := hook(failureCtx)
				if result != nil && result.Recovered {
					return result.Result, nil
				}
			}
			return nil, verifyErr
		}

		// Execute afterVerify hooks
		resultCtx := FacilitatorVerifyResultContext{FacilitatorVerifyContext: hookCtx, Result: verifyResult}
		for _, hook := range f.afterVerifyHooks {
			_ = hook(resultCtx) // Log errors but don't fail
		}

		return verifyResult, nil

	case 2:
		payload, err := types.ToPaymentPayload(payloadBytes)
		if err != nil {
			return nil, NewVerifyError(ErrInvalidV2Payload, "", err.Error())
		}
		requirements, err := types.ToPaymentRequirements(requirementsBytes)
		if err != nil {
			return nil, NewVerifyError(ErrInvalidV2Requirements, "", err.Error())
		}

		hookPayload = *payload
		hookRequirements = *requirements

		// Execute beforeVerify hooks
		hookCtx := FacilitatorVerifyContext{
			Ctx:               ctx,
			Payload:           hookPayload,
			Requirements:      hookRequirements,
			PayloadBytes:      payloadBytes,
			RequirementsBytes: requirementsBytes,
		}
		for _, hook := range f.beforeVerifyHooks {
			result, err := hook(hookCtx)
			if err != nil {
				return nil, err
			}
			if result != nil && result.Abort {
				return nil, NewVerifyError(result.Reason, "", "")
			}
		}

		// Call mechanism
		verifyResult, verifyErr := f.verifyV2(ctx, *payload, *requirements)

		// Handle failure
		if verifyErr != nil {
			failureCtx := FacilitatorVerifyFailureContext{FacilitatorVerifyContext: hookCtx, Error: verifyErr}
			for _, hook := range f.onVerifyFailureHooks {
				result, _ := hook(failureCtx)
				if result != nil && result.Recovered {
					return result.Result, nil
				}
			}
			return nil, verifyErr
		}

		// Execute afterVerify hooks
		resultCtx := FacilitatorVerifyResultContext{FacilitatorVerifyContext: hookCtx, Result: verifyResult}
		for _, hook := range f.afterVerifyHooks {
			_ = hook(resultCtx) // Log errors but don't fail
		}

		return verifyResult, nil

	default:
		return nil, NewVerifyError(ErrInvalidVersion, "", fmt.Sprintf("unsupported version: %d", version))
	}
}

// Settle settles a payment (detects version from bytes, routes to typed mechanism)
func (f *x402Facilitator) Settle(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*SettleResponse, error) {
	// Detect version
	version, err := types.DetectVersion(payloadBytes)
	if err != nil {
		return nil, NewSettleError(ErrInvalidVersion, "", "", "", err.Error())
	}

	// Unmarshal to typed structs for hooks
	var hookPayload PaymentPayloadView
	var hookRequirements PaymentRequirementsView

	// Route to version-specific method
	switch version {
	case 1:
		payload, err := types.ToPaymentPayloadV1(payloadBytes)
		if err != nil {
			return nil, NewSettleError(ErrInvalidV1Payload, "", "", "", err.Error())
		}
		requirements, err := types.ToPaymentRequirementsV1(requirementsBytes)
		if err != nil {
			return nil, NewSettleError(ErrInvalidV1Requirements, "", "", "", err.Error())
		}

		hookPayload = *payload
		hookRequirements = *requirements

		// Execute beforeSettle hooks
		hookCtx := FacilitatorSettleContext{
			Ctx:               ctx,
			Payload:           hookPayload,
			Requirements:      hookRequirements,
			PayloadBytes:      payloadBytes,
			RequirementsBytes: requirementsBytes,
		}
		for _, hook := range f.beforeSettleHooks {
			result, err := hook(hookCtx)
			if err != nil {
				return nil, err
			}
			if result != nil && result.Abort {
				return nil, NewSettleError(result.Reason, "", "", "", result.Message)
			}
		}

		// Call mechanism
		settleResult, settleErr := f.settleV1(ctx, *payload, *requirements)

		// Handle failure
		if settleErr != nil {
			failureCtx := FacilitatorSettleFailureContext{FacilitatorSettleContext: hookCtx, Error: settleErr}
			for _, hook := range f.onSettleFailureHooks {
				result, _ := hook(failureCtx)
				if result != nil && result.Recovered {
					return result.Result, nil
				}
			}
			return nil, settleErr
		}

		// Execute afterSettle hooks
		resultCtx := FacilitatorSettleResultContext{FacilitatorSettleContext: hookCtx, Result: settleResult}
		for _, hook := range f.afterSettleHooks {
			_ = hook(resultCtx) // Log errors but don't fail
		}

		return settleResult, nil

	case 2:
		payload, err := types.ToPaymentPayload(payloadBytes)
		if err != nil {
			return nil, NewSettleError(ErrInvalidV2Payload, "", "", "", err.Error())
		}
		requirements, err := types.ToPaymentRequirements(requirementsBytes)
		if err != nil {
			return nil, NewSettleError(ErrInvalidV2Requirements, "", "", "", err.Error())
		}

		hookPayload = *payload
		hookRequirements = *requirements

		// Execute beforeSettle hooks
		hookCtx := FacilitatorSettleContext{
			Ctx:               ctx,
			Payload:           hookPayload,
			Requirements:      hookRequirements,
			PayloadBytes:      payloadBytes,
			RequirementsBytes: requirementsBytes,
		}
		for _, hook := range f.beforeSettleHooks {
			result, err := hook(hookCtx)
			if err != nil {
				return nil, err
			}
			if result != nil && result.Abort {
				return nil, NewSettleError(result.Reason, "", "", "", "")
			}
		}

		// Call mechanism
		settleResult, settleErr := f.settleV2(ctx, *payload, *requirements)

		// Handle failure
		if settleErr != nil {
			failureCtx := FacilitatorSettleFailureContext{FacilitatorSettleContext: hookCtx, Error: settleErr}
			for _, hook := range f.onSettleFailureHooks {
				result, _ := hook(failureCtx)
				if result != nil && result.Recovered {
					return result.Result, nil
				}
			}
			return nil, settleErr
		}

		// Execute afterSettle hooks
		resultCtx := FacilitatorSettleResultContext{FacilitatorSettleContext: hookCtx, Result: settleResult}
		for _, hook := range f.afterSettleHooks {
			_ = hook(resultCtx) // Log errors but don't fail
		}

		return settleResult, nil

	default:
		return nil, NewSettleError(fmt.Sprintf("unsupported_version_%d", version), "", "", "", "")
	}
}

// ============================================================================
// Internal Typed Methods (called after version detection)
// ============================================================================

// verifyV1 verifies a V1 payment (internal, typed)
func (f *x402Facilitator) verifyV1(ctx context.Context, payload types.PaymentPayloadV1, requirements types.PaymentRequirementsV1) (*VerifyResponse, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()

	scheme := requirements.Scheme
	network := Network(requirements.Network)
	fctx := NewFacilitatorContext(f.extensions)

	// Find matching facilitator from array
	for _, data := range f.schemesV1 {
		facilitator := data.facilitator.(SchemeNetworkFacilitatorV1)
		if facilitator.Scheme() != scheme {
			continue
		}

		// Check if network matches (exact or pattern)
		if matchesSchemeData(data, network) {
			return facilitator.Verify(ctx, payload, requirements, fctx)
		}
	}

	registered := f.registeredV1Summary()
	return nil, NewVerifyError(ErrNoFacilitatorForNetwork, "", fmt.Sprintf("no facilitator for scheme %q on network %q; registered: %s", scheme, network, registered))
}

// verifyV2 verifies a V2 payment (internal, typed)
func (f *x402Facilitator) verifyV2(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements) (*VerifyResponse, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()

	scheme := requirements.Scheme
	network := Network(requirements.Network)
	fctx := NewFacilitatorContext(f.extensions)

	// Find matching facilitator from array
	for _, data := range f.schemes {
		facilitator := data.facilitator.(SchemeNetworkFacilitator)
		if facilitator.Scheme() != scheme {
			continue
		}

		// Check if network matches (exact or pattern)
		if matchesSchemeData(data, network) {
			return facilitator.Verify(ctx, payload, requirements, fctx)
		}
	}

	registered := f.registeredV2Summary()
	return nil, NewVerifyError(ErrNoFacilitatorForNetwork, "", fmt.Sprintf("no facilitator for scheme %q on network %q; registered: %s", scheme, network, registered))
}

// settleV1 settles a V1 payment (internal, typed)
func (f *x402Facilitator) settleV1(ctx context.Context, payload types.PaymentPayloadV1, requirements types.PaymentRequirementsV1) (*SettleResponse, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()

	scheme := requirements.Scheme
	network := Network(requirements.Network)
	fctx := NewFacilitatorContext(f.extensions)

	// Find matching facilitator from array
	for _, data := range f.schemesV1 {
		facilitator := data.facilitator.(SchemeNetworkFacilitatorV1)
		if facilitator.Scheme() != scheme {
			continue
		}

		// Check if network matches (exact or pattern)
		if matchesSchemeData(data, network) {
			return facilitator.Settle(ctx, payload, requirements, fctx)
		}
	}

	registered := f.registeredV1Summary()
	return nil, NewSettleError(ErrNoFacilitatorForNetwork, "", network, "", fmt.Sprintf("no facilitator for scheme %q on network %q; registered: %s", scheme, network, registered))
}

// settleV2 settles a V2 payment (internal, typed)
func (f *x402Facilitator) settleV2(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements) (*SettleResponse, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()

	scheme := requirements.Scheme
	network := Network(requirements.Network)
	fctx := NewFacilitatorContext(f.extensions)

	// Find matching facilitator from array
	for _, data := range f.schemes {
		facilitator := data.facilitator.(SchemeNetworkFacilitator)
		if facilitator.Scheme() != scheme {
			continue
		}

		// Check if network matches (exact or pattern)
		if matchesSchemeData(data, network) {
			return facilitator.Settle(ctx, payload, requirements, fctx)
		}
	}

	registered := f.registeredV2Summary()
	return nil, NewSettleError(ErrNoFacilitatorForNetwork, "", network, "", fmt.Sprintf("no facilitator for scheme %q on network %q; registered: %s", scheme, network, registered))
}

// registeredV1Summary returns a human-readable list of registered V1 scheme/network pairs.
func (f *x402Facilitator) registeredV1Summary() string {
	if len(f.schemesV1) == 0 {
		return "(none)"
	}
	var parts []string
	for _, data := range f.schemesV1 {
		facilitator := data.facilitator.(SchemeNetworkFacilitatorV1)
		for network := range data.networks {
			parts = append(parts, fmt.Sprintf("%s@%s", facilitator.Scheme(), network))
		}
	}
	return strings.Join(parts, ", ")
}

// registeredV2Summary returns a human-readable list of registered V2 scheme/network pairs.
func (f *x402Facilitator) registeredV2Summary() string {
	if len(f.schemes) == 0 {
		return "(none)"
	}
	var parts []string
	for _, data := range f.schemes {
		facilitator := data.facilitator.(SchemeNetworkFacilitator)
		for network := range data.networks {
			parts = append(parts, fmt.Sprintf("%s@%s", facilitator.Scheme(), network))
		}
	}
	return strings.Join(parts, ", ")
}

// GetSupported returns supported payment kinds
// Uses networks registered during Register() calls - no parameters needed.
// Returns flat array format for backward compatibility with V1 clients.
//
// Returns:
//
//	SupportedResponse with kinds as array (with version in each element), extensions, and signers
func (f *x402Facilitator) GetSupported() SupportedResponse {
	f.mu.RLock()
	defer f.mu.RUnlock()

	kinds := []SupportedKind{}
	signersByFamily := make(map[string]map[string]bool) // family → set of signers

	// V1 schemes
	for _, data := range f.schemesV1 {
		facilitator := data.facilitator.(SchemeNetworkFacilitatorV1)
		scheme := facilitator.Scheme()

		for network := range data.networks {
			kind := SupportedKind{
				X402Version: 1,
				Scheme:      scheme,
				Network:     string(network),
			}
			if extra := facilitator.GetExtra(network); extra != nil {
				kind.Extra = extra
			}
			kinds = append(kinds, kind)

			// Collect signers by CAIP family for this network
			family := facilitator.CaipFamily()
			if signersByFamily[family] == nil {
				signersByFamily[family] = make(map[string]bool)
			}
			for _, signer := range facilitator.GetSigners(network) {
				signersByFamily[family][signer] = true
			}
		}
	}

	// V2 schemes
	for _, data := range f.schemes {
		facilitator := data.facilitator.(SchemeNetworkFacilitator)
		scheme := facilitator.Scheme()

		for network := range data.networks {
			kind := SupportedKind{
				X402Version: 2,
				Scheme:      scheme,
				Network:     string(network),
			}
			if extra := facilitator.GetExtra(network); extra != nil {
				kind.Extra = extra
			}
			kinds = append(kinds, kind)

			// Collect signers by CAIP family for this network
			family := facilitator.CaipFamily()
			if signersByFamily[family] == nil {
				signersByFamily[family] = make(map[string]bool)
			}
			for _, signer := range facilitator.GetSigners(network) {
				signersByFamily[family][signer] = true
			}
		}
	}

	// Convert signer sets to arrays
	signers := make(map[string][]string)
	for family, signerSet := range signersByFamily {
		signerList := make([]string, 0, len(signerSet))
		for signer := range signerSet {
			signerList = append(signerList, signer)
		}
		signers[family] = signerList
	}

	extensionKeys := make([]string, 0, len(f.extensions))
	for key := range f.extensions {
		extensionKeys = append(extensionKeys, key)
	}

	return SupportedResponse{
		Kinds:      kinds,
		Extensions: extensionKeys,
		Signers:    signers,
	}
}

// derivePattern creates a wildcard pattern from an array of networks
// If all networks share the same namespace, returns wildcard pattern
// Otherwise returns the first network for exact matching
func derivePattern(networks []Network) Network {
	if len(networks) == 0 {
		return ""
	}
	if len(networks) == 1 {
		return networks[0]
	}

	// Extract namespaces (e.g., "eip155" from "eip155:84532")
	namespaces := make(map[string]bool)
	for _, network := range networks {
		parts := strings.Split(string(network), ":")
		if len(parts) == 2 {
			namespaces[parts[0]] = true
		}
	}

	// If all same namespace, use wildcard
	if len(namespaces) == 1 {
		for namespace := range namespaces {
			return Network(namespace + ":*")
		}
	}

	// Mixed namespaces - use first network for exact matching
	return networks[0]
}

// matchesSchemeData checks if a network matches the scheme data
// Returns true if network is in registered networks or matches the pattern
func matchesSchemeData(data *schemeData, network Network) bool {
	// Check exact match first
	if data.networks[network] {
		return true
	}

	// Try pattern matching
	return matchesNetworkPattern(string(network), string(data.pattern))
}

// matchesNetworkPattern checks if a concrete network matches a registered pattern
// Supports wildcards like "eip155:*" or exact matches
func matchesNetworkPattern(concreteNetwork, pattern string) bool {
	if pattern == concreteNetwork {
		return true // Exact match
	}

	// Handle wildcard patterns (e.g., "eip155:*", "solana:*")
	if len(pattern) > 0 && pattern[len(pattern)-1] == '*' {
		prefix := pattern[:len(pattern)-1]
		return len(concreteNetwork) >= len(prefix) && concreteNetwork[:len(prefix)] == prefix
	}

	return false
}
