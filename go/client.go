package x402

import (
	"context"
	"fmt"
	"sync"

	"github.com/x402-foundation/x402/go/types"
)

// x402Client manages payment mechanisms and creates payment payloads
// This is used by applications that need to make payments (have wallets/signers)
type x402Client struct {
	mu sync.RWMutex

	// Separate maps for V1 and V2 (V2 uses default name, no suffix)
	schemesV1 map[Network]map[string]SchemeNetworkClientV1
	schemes   map[Network]map[string]SchemeNetworkClient // V2 (default)

	// Single selector/policies - work with unified view
	requirementsSelector PaymentRequirementsSelector
	policies             []PaymentPolicy

	// Registered client extensions (keyed by extension key)
	extensions map[string]ClientExtension

	// Lifecycle hooks
	beforePaymentCreationHooks    []BeforePaymentCreationHook
	afterPaymentCreationHooks     []AfterPaymentCreationHook
	onPaymentCreationFailureHooks []OnPaymentCreationFailureHook
	onPaymentResponseHooks        []OnPaymentResponseHook
}

// ClientOption configures the client
type ClientOption func(*x402Client)

// WithPaymentSelector sets a custom payment requirements selector
func WithPaymentSelector(selector PaymentRequirementsSelector) ClientOption {
	return func(c *x402Client) {
		c.requirementsSelector = selector
	}
}

// WithPolicy registers a payment policy at creation time
func WithPolicy(policy PaymentPolicy) ClientOption {
	return func(c *x402Client) {
		c.policies = append(c.policies, policy)
	}
}

// Newx402Client creates a new x402 client
func Newx402Client(opts ...ClientOption) *x402Client {
	c := &x402Client{
		schemesV1:            make(map[Network]map[string]SchemeNetworkClientV1),
		schemes:              make(map[Network]map[string]SchemeNetworkClient),
		requirementsSelector: DefaultPaymentSelector,
		policies:             []PaymentPolicy{},
		extensions:           make(map[string]ClientExtension),
	}

	for _, opt := range opts {
		opt(c)
	}

	return c
}

// RegisterV1 registers a V1 payment mechanism
func (c *x402Client) RegisterV1(network Network, client SchemeNetworkClientV1) *x402Client {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.schemesV1[network] == nil {
		c.schemesV1[network] = make(map[string]SchemeNetworkClientV1)
	}
	c.schemesV1[network][client.Scheme()] = client
	return c
}

// Register registers a payment mechanism (V2, default)
func (c *x402Client) Register(network Network, client SchemeNetworkClient) *x402Client {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.schemes[network] == nil {
		c.schemes[network] = make(map[string]SchemeNetworkClient)
	}
	c.schemes[network][client.Scheme()] = client
	return c
}

// RegisterPolicy registers a policy to filter or transform payment requirements
func (c *x402Client) RegisterPolicy(policy PaymentPolicy) *x402Client {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.policies = append(c.policies, policy)
	return c
}

// RegisterExtension registers a client extension that can enrich payment payloads.
// Extensions are invoked after the scheme creates the base payload. If the extension's
// key is present in paymentRequired.Extensions, the extension's EnrichPaymentPayload
// method is called to modify the payload.
func (c *x402Client) RegisterExtension(ext ClientExtension) *x402Client {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.extensions[ext.Key()] = ext
	return c
}

// OnBeforePaymentCreation registers a hook to execute before payment payload creation
func (c *x402Client) OnBeforePaymentCreation(hook BeforePaymentCreationHook) *x402Client {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.beforePaymentCreationHooks = append(c.beforePaymentCreationHooks, hook)
	return c
}

// OnAfterPaymentCreation registers a hook to execute after successful payment payload creation
func (c *x402Client) OnAfterPaymentCreation(hook AfterPaymentCreationHook) *x402Client {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.afterPaymentCreationHooks = append(c.afterPaymentCreationHooks, hook)
	return c
}

// OnPaymentCreationFailure registers a hook to execute when payment payload creation fails
func (c *x402Client) OnPaymentCreationFailure(hook OnPaymentCreationFailureHook) *x402Client {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onPaymentCreationFailureHooks = append(c.onPaymentCreationFailureHooks, hook)
	return c
}

// OnPaymentResponse registers a hook fired by the transport after each paid
// response. Returning Recovered=true on a corrective 402 instructs the transport
// to retry once with a freshly built payment payload.
func (c *x402Client) OnPaymentResponse(hook OnPaymentResponseHook) *x402Client {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onPaymentResponseHooks = append(c.onPaymentResponseHooks, hook)
	return c
}

// HandlePaymentResponse dispatches the OnPaymentResponse lifecycle for a paid
// response: invokes the scheme's PaymentResponseHandler (if implemented) followed
// by every user-registered OnPaymentResponseHook. Returns Recovered=true if any
// hook recovered (first wins; subsequent hooks still run for instrumentation).
func (c *x402Client) HandlePaymentResponse(
	ctx context.Context,
	prCtx PaymentResponseContext,
) (PaymentResponseResult, error) {
	c.mu.RLock()
	schemes := findSchemesByNetwork(c.schemes, Network(prCtx.Requirements.Network))
	var schemeImpl SchemeNetworkClient
	if schemes != nil {
		schemeImpl = schemes[prCtx.Requirements.Scheme]
	}
	userHooks := append([]OnPaymentResponseHook(nil), c.onPaymentResponseHooks...)
	c.mu.RUnlock()

	combined := PaymentResponseResult{}
	if handler, ok := schemeImpl.(PaymentResponseHandler); ok {
		res, err := handler.OnPaymentResponse(ctx, prCtx)
		if err != nil {
			return PaymentResponseResult{}, fmt.Errorf("scheme OnPaymentResponse: %w", err)
		}
		if res.Recovered {
			combined.Recovered = true
		}
	}
	for _, hook := range userHooks {
		res, err := hook(ctx, prCtx)
		if err != nil {
			return combined, fmt.Errorf("user OnPaymentResponse hook: %w", err)
		}
		if res.Recovered {
			combined.Recovered = true
		}
	}
	return combined, nil
}

// SelectPaymentRequirementsV1 selects a V1 payment requirement
func (c *x402Client) SelectPaymentRequirementsV1(requirements []types.PaymentRequirementsV1) (types.PaymentRequirementsV1, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	// Filter to supported (use wildcard matching helper)
	var supported []types.PaymentRequirementsV1
	for _, req := range requirements {
		network := Network(req.Network)
		schemes := findSchemesByNetwork(c.schemesV1, network)
		if schemes != nil {
			if _, ok := schemes[req.Scheme]; ok {
				supported = append(supported, req)
			}
		}
	}

	if len(supported) == 0 {
		return types.PaymentRequirementsV1{}, &PaymentError{
			Code:    ErrCodeUnsupportedScheme,
			Message: "no supported payment schemes available",
		}
	}

	// Convert to views for selector/policies
	views := toViews(supported)

	// Apply policies
	filtered := views
	for _, policy := range c.policies {
		filtered = policy(filtered)
		if len(filtered) == 0 {
			return types.PaymentRequirementsV1{}, &PaymentError{
				Code:    ErrCodeUnsupportedScheme,
				Message: "all payment requirements were filtered out by policies",
			}
		}
	}

	// Select final and convert back
	selected := c.requirementsSelector(filtered)
	return fromView[types.PaymentRequirementsV1](selected), nil
}

// SelectPaymentRequirements selects a payment requirement (V2, default)
func (c *x402Client) SelectPaymentRequirements(requirements []types.PaymentRequirements) (types.PaymentRequirements, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	// Filter to supported (use wildcard matching helper)
	var supported []types.PaymentRequirements
	for _, req := range requirements {
		network := Network(req.Network)
		schemes := findSchemesByNetwork(c.schemes, network)
		if schemes != nil {
			if _, ok := schemes[req.Scheme]; ok {
				supported = append(supported, req)
			}
		}
	}

	if len(supported) == 0 {
		return types.PaymentRequirements{}, &PaymentError{
			Code:    ErrCodeUnsupportedScheme,
			Message: "no supported payment schemes available",
		}
	}

	// Convert to views for selector/policies
	views := toViews(supported)

	// Apply policies
	filtered := views
	for _, policy := range c.policies {
		filtered = policy(filtered)
		if len(filtered) == 0 {
			return types.PaymentRequirements{}, &PaymentError{
				Code:    ErrCodeUnsupportedScheme,
				Message: "all payment requirements were filtered out by policies",
			}
		}
	}

	// Select final and convert back
	selected := c.requirementsSelector(filtered)
	return fromView[types.PaymentRequirements](selected), nil
}

// CreatePaymentPayloadV1 creates a V1 payment payload
func (c *x402Client) CreatePaymentPayloadV1(
	ctx context.Context,
	requirements types.PaymentRequirementsV1,
) (types.PaymentPayloadV1, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	// Direct field access for routing
	scheme := requirements.Scheme
	network := Network(requirements.Network)

	// Use wildcard matching helper
	schemes := findSchemesByNetwork(c.schemesV1, network)
	if schemes == nil {
		return types.PaymentPayloadV1{}, &PaymentError{
			Code:    ErrCodeUnsupportedScheme,
			Message: fmt.Sprintf("no client registered for network %s", network),
		}
	}

	client := schemes[scheme]
	if client == nil {
		return types.PaymentPayloadV1{}, &PaymentError{
			Code:    ErrCodeUnsupportedScheme,
			Message: fmt.Sprintf("no client registered for scheme %s on network %s", scheme, network),
		}
	}

	return client.CreatePaymentPayload(ctx, requirements)
}

// CreatePaymentPayload creates a payment payload (V2, default)
func (c *x402Client) CreatePaymentPayload(
	ctx context.Context,
	requirements types.PaymentRequirements,
	resource *types.ResourceInfo,
	extensions map[string]interface{},
) (types.PaymentPayload, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	scheme := requirements.Scheme
	network := Network(requirements.Network)

	// Use wildcard matching helper
	schemes := findSchemesByNetwork(c.schemes, network)
	if schemes == nil {
		return types.PaymentPayload{}, &PaymentError{
			Code:    ErrCodeUnsupportedScheme,
			Message: fmt.Sprintf("no client registered for network %s", network),
		}
	}

	client := schemes[scheme]
	if client == nil {
		return types.PaymentPayload{}, &PaymentError{
			Code:    ErrCodeUnsupportedScheme,
			Message: fmt.Sprintf("no client registered for scheme %s on network %s", scheme, network),
		}
	}

	// Get partial payload from mechanism.
	// If the scheme supports extensions (e.g., EIP-2612), pass them for enrichment.
	var partial types.PaymentPayload
	var err error
	if extAware, ok := client.(ExtensionAwareClient); ok && extensions != nil {
		partial, err = extAware.CreatePaymentPayloadWithExtensions(ctx, requirements, extensions)
	} else {
		partial, err = client.CreatePaymentPayload(ctx, requirements)
	}
	if err != nil {
		return types.PaymentPayload{}, err
	}

	// Wrap with accepted/resource/extensions
	partial.Accepted = requirements
	partial.Resource = resource
	// Merge server extensions with any scheme-provided extensions
	partial.Extensions = mergeExtensions(extensions, partial.Extensions)

	// Enrich payload via registered client extensions (for non-scheme extensions)
	partial, err = c.enrichPaymentPayloadWithExtensions(ctx, partial, types.PaymentRequired{
		X402Version: 2,
		Accepts:     []types.PaymentRequirements{requirements},
		Extensions:  partial.Extensions,
		Resource:    resource,
	})
	if err != nil {
		return types.PaymentPayload{}, err
	}

	return partial, nil
}

// GetRegisteredSchemes returns a list of registered schemes for debugging
func (c *x402Client) GetRegisteredSchemes() map[int][]struct {
	Network Network
	Scheme  string
} {
	c.mu.RLock()
	defer c.mu.RUnlock()

	result := make(map[int][]struct {
		Network Network
		Scheme  string
	})

	// V1 schemes
	for network, schemes := range c.schemesV1 {
		for scheme := range schemes {
			result[1] = append(result[1], struct {
				Network Network
				Scheme  string
			}{
				Network: network,
				Scheme:  scheme,
			})
		}
	}

	// V2 schemes
	for network, schemeMap := range c.schemes {
		for scheme := range schemeMap {
			result[2] = append(result[2], struct {
				Network Network
				Scheme  string
			}{
				Network: network,
				Scheme:  scheme,
			})
		}
	}

	return result
}

// enrichPaymentPayloadWithExtensions invokes registered client extensions
// to enrich the payment payload. For each registered extension whose key is
// present in the PaymentRequired extensions, calls EnrichPaymentPayload.
func (c *x402Client) enrichPaymentPayloadWithExtensions(
	ctx context.Context,
	payload types.PaymentPayload,
	required types.PaymentRequired,
) (types.PaymentPayload, error) {
	if len(required.Extensions) == 0 || len(c.extensions) == 0 {
		return payload, nil
	}

	enriched := payload
	for key, ext := range c.extensions {
		if _, exists := required.Extensions[key]; exists {
			var err error
			enriched, err = ext.EnrichPaymentPayload(ctx, enriched, required)
			if err != nil {
				return types.PaymentPayload{}, fmt.Errorf("extension %s enrichment failed: %w", key, err)
			}
		}
	}

	return enriched, nil
}

// mergeExtensions merges server-declared extensions with scheme-provided extensions.
// Scheme extensions overlay on top of server extensions at each key.
func mergeExtensions(server, scheme map[string]interface{}) map[string]interface{} {
	if scheme == nil {
		return server
	}
	if server == nil {
		return scheme
	}
	merged := make(map[string]interface{})
	for k, v := range server {
		merged[k] = v
	}
	for k, schemeVal := range scheme {
		if serverVal, exists := merged[k]; exists {
			serverMap, sOk := serverVal.(map[string]interface{})
			schemeMap, cOk := schemeVal.(map[string]interface{})
			if sOk && cOk {
				// Deep merge: scheme overlays server
				m := make(map[string]interface{})
				for mk, mv := range serverMap {
					m[mk] = mv
				}
				for mk, mv := range schemeMap {
					m[mk] = mv
				}
				merged[k] = m
				continue
			}
		}
		merged[k] = schemeVal
	}
	return merged
}

// Helper functions use the generic findSchemesByNetwork from utils.go
