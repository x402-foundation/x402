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

	"github.com/x402-foundation/x402/go/types"
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

	// Manual lifecycle hooks registered via OnBeforeVerify / OnAfterVerify / etc.
	// These fire for every request regardless of scheme/network. Mirrors TS
	// `beforeVerifyHooks: BeforeVerifyHook[]` arrays.
	beforeVerifyHooks              []BeforeVerifyHook
	afterVerifyHooks               []AfterVerifyHook
	onVerifyFailureHooks           []OnVerifyFailureHook
	beforeSettleHooks              []BeforeSettleHook
	afterSettleHooks               []AfterSettleHook
	onSettleFailureHooks           []OnSettleFailureHook
	onVerifiedPaymentCanceledHooks []OnVerifiedPaymentCanceledHook

	// Per-scheme hook adapters: only the matched (network, scheme) entry
	// fires for a given request. Mirrors TS `schemeHookAdapters: Map<Network,
	// Map<scheme, SchemeAdapterHandles>>`. Replaces the previous behavior of
	// appending scheme hooks into the global lists, which leaked hooks across
	// unrelated schemes registered on the same server.
	schemeHookAdapters map[Network]map[string]*hookAdapterHandles

	// Per-extension hook adapters: only fire when the extension key is
	// declared on the route via `declaredExtensions`. Mirrors TS
	// `extensionHookAdapters: Map<string, ExtensionAdapterHandles>`.
	extensionHookAdapters map[string]*hookAdapterHandles
}

// hookAdapterHandles bundles the optional per-phase hook funcs contributed
// by a scheme or extension. Phases left nil are skipped at invocation time.
// Mirrors TS `HookAdapterHandles`.
type hookAdapterHandles struct {
	BeforeVerify              BeforeVerifyHook
	AfterVerify               AfterVerifyHook
	OnVerifyFailure           OnVerifyFailureHook
	BeforeSettle              BeforeSettleHook
	AfterSettle               AfterSettleHook
	OnSettleFailure           OnSettleFailureHook
	OnVerifiedPaymentCanceled OnVerifiedPaymentCanceledHook
}

// labeledHook tags a hook function with its source for diagnostics. The
// source string is one of "manual #N", `scheme "X"`, or `extension "Y"`.
type labeledHook[F any] struct {
	Label string
	Hook  F
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

// Clear removes all cached supported responses and expiry entries
func (c *SupportedCache) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()

	clear(c.data)
	clear(c.expiry)
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
		schemes:               make(map[Network]map[string]SchemeNetworkServer),
		facilitatorClients:    make(map[Network]map[string]FacilitatorClient),
		registeredExtensions:  make(map[string]types.ResourceServerExtension),
		schemeHookAdapters:    make(map[Network]map[string]*hookAdapterHandles),
		extensionHookAdapters: make(map[string]*hookAdapterHandles),
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

// Register registers a payment mechanism (V2, default).
//
// Auto-wires lifecycle hooks contributed by the scheme via the optional
// BeforeVerifyHookProvider / AfterVerifyHookProvider / BeforeSettleHookProvider
// / AfterSettleHookProvider / OnVerifyFailureHookProvider / OnSettleFailureHookProvider
// / OnVerifiedPaymentCanceledHookProvider interfaces (mirrors the TS schemeHooks field).
//
// Scheme hooks are stored per (network, scheme) and fire ONLY when the
// matched requirements use that scheme/network — they do NOT leak across
// other registered schemes. Manual hooks registered via OnBeforeVerify etc.
// run for every request and execute BEFORE the matched scheme's hooks
// (mirrors TS hook ordering: manual → matched scheme → declared extensions).
func (s *x402ResourceServer) Register(network Network, schemeServer SchemeNetworkServer) *x402ResourceServer {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.schemes[network] == nil {
		s.schemes[network] = make(map[string]SchemeNetworkServer)
	}
	s.schemes[network][schemeServer.Scheme()] = schemeServer

	handles := &hookAdapterHandles{}
	if h, ok := schemeServer.(BeforeVerifyHookProvider); ok {
		if hook := h.BeforeVerifyHook(); hook != nil {
			handles.BeforeVerify = hook
		}
	}
	if h, ok := schemeServer.(AfterVerifyHookProvider); ok {
		if hook := h.AfterVerifyHook(); hook != nil {
			handles.AfterVerify = hook
		}
	}
	if h, ok := schemeServer.(OnVerifyFailureHookProvider); ok {
		if hook := h.OnVerifyFailureHook(); hook != nil {
			handles.OnVerifyFailure = hook
		}
	}
	if h, ok := schemeServer.(BeforeSettleHookProvider); ok {
		if hook := h.BeforeSettleHook(); hook != nil {
			handles.BeforeSettle = hook
		}
	}
	if h, ok := schemeServer.(AfterSettleHookProvider); ok {
		if hook := h.AfterSettleHook(); hook != nil {
			handles.AfterSettle = hook
		}
	}
	if h, ok := schemeServer.(OnSettleFailureHookProvider); ok {
		if hook := h.OnSettleFailureHook(); hook != nil {
			handles.OnSettleFailure = hook
		}
	}
	if h, ok := schemeServer.(OnVerifiedPaymentCanceledHookProvider); ok {
		if hook := h.OnVerifiedPaymentCanceledHook(); hook != nil {
			handles.OnVerifiedPaymentCanceled = hook
		}
	}

	if handles.isEmpty() {
		// No scheme hooks; clear any prior registration for this slot so
		// re-registering a scheme without hooks doesn't keep stale entries.
		if byScheme, ok := s.schemeHookAdapters[network]; ok {
			delete(byScheme, schemeServer.Scheme())
			if len(byScheme) == 0 {
				delete(s.schemeHookAdapters, network)
			}
		}
	} else {
		if s.schemeHookAdapters[network] == nil {
			s.schemeHookAdapters[network] = make(map[string]*hookAdapterHandles)
		}
		s.schemeHookAdapters[network][schemeServer.Scheme()] = handles
	}

	return s
}

// isEmpty reports whether no hook phases are populated.
func (h *hookAdapterHandles) isEmpty() bool {
	return h.BeforeVerify == nil && h.AfterVerify == nil && h.OnVerifyFailure == nil &&
		h.BeforeSettle == nil && h.AfterSettle == nil && h.OnSettleFailure == nil &&
		h.OnVerifiedPaymentCanceled == nil
}

func (s *x402ResourceServer) RegisterExtension(extension types.ResourceServerExtension) *x402ResourceServer {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := extension.Key()
	s.registeredExtensions[key] = extension

	hp, ok := extension.(ResourceServerExtensionHookProvider)
	if !ok {
		delete(s.extensionHookAdapters, key)
		return s
	}

	// Wire optional per-extension lifecycle hooks. Each phase is wrapped so it
	// only fires when `ctx.DeclaredExtensions[key]` is set — mirrors TS
	// `bindExtensionHookAdapter`.
	hooks := hp.ResourceServerExtensionHooks()
	handles := &hookAdapterHandles{
		BeforeVerify:              gateExtensionHook(key, hooks.OnBeforeVerify, func(c VerifyContext) map[string]interface{} { return c.DeclaredExtensions }),
		AfterVerify:               gateExtensionHook(key, hooks.OnAfterVerify, func(c VerifyResultContext) map[string]interface{} { return c.DeclaredExtensions }),
		OnVerifyFailure:           gateExtensionHook(key, hooks.OnVerifyFailure, func(c VerifyFailureContext) map[string]interface{} { return c.DeclaredExtensions }),
		BeforeSettle:              gateExtensionHook(key, hooks.OnBeforeSettle, func(c SettleContext) map[string]interface{} { return c.DeclaredExtensions }),
		AfterSettle:               gateExtensionVoidHook(key, hooks.OnAfterSettle, func(c SettleResultContext) map[string]interface{} { return c.DeclaredExtensions }),
		OnSettleFailure:           gateExtensionHook(key, hooks.OnSettleFailure, func(c SettleFailureContext) map[string]interface{} { return c.DeclaredExtensions }),
		OnVerifiedPaymentCanceled: gateExtensionVoidHook(key, hooks.OnVerifiedPaymentCanceled, func(c VerifiedPaymentCanceledContext) map[string]interface{} { return c.DeclaredExtensions }),
	}
	if handles.isEmpty() {
		delete(s.extensionHookAdapters, key)
	} else {
		s.extensionHookAdapters[key] = handles
	}
	return s
}

// gateExtensionHook returns a wrapper that invokes `impl` only when the
// declared-extension map carries `key`. Mirrors TS `bindExtensionHookAdapter`'s
// `if (ctx.declaredExtensions[extensionKey] === undefined) return;` guard.
// Returns nil when `impl` is nil so RegisterExtension can drop the phase.
func gateExtensionHook[Ctx any, Result any](
	key string,
	impl func(Ctx) (*Result, error),
	declared func(Ctx) map[string]interface{},
) func(Ctx) (*Result, error) {
	if impl == nil {
		return nil
	}
	return func(ctx Ctx) (*Result, error) {
		ext := declared(ctx)
		if ext == nil {
			return nil, nil
		}
		if _, ok := ext[key]; !ok {
			return nil, nil
		}
		return impl(ctx)
	}
}

// gateExtensionVoidHook is the error-only variant of gateExtensionHook for
// hooks that don't return a result struct (AfterSettle, OnVerifiedPaymentCanceled).
func gateExtensionVoidHook[Ctx any](
	key string,
	impl func(Ctx) error,
	declared func(Ctx) map[string]interface{},
) func(Ctx) error {
	if impl == nil {
		return nil
	}
	return func(ctx Ctx) error {
		ext := declared(ctx)
		if ext == nil {
			return nil
		}
		if _, ok := ext[key]; !ok {
			return nil
		}
		return impl(ctx)
	}
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

func (s *x402ResourceServer) OnVerifiedPaymentCanceled(hook OnVerifiedPaymentCanceledHook) *x402ResourceServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onVerifiedPaymentCanceledHooks = append(s.onVerifiedPaymentCanceledHooks, hook)
	return s
}

// matchedSchemeHooks returns the per-(network, scheme) hook handles for the
// scheme that matched the current request, or nil when no scheme is registered
// for that pair. Caller must hold s.mu (read).
func (s *x402ResourceServer) matchedSchemeHooks(network Network, scheme string) *hookAdapterHandles {
	if byScheme, ok := s.schemeHookAdapters[network]; ok {
		if h, ok := byScheme[scheme]; ok {
			return h
		}
	}
	return nil
}

// orderedHooks returns the hooks for `phase` in the canonical execution order:
// manual → matched scheme → declared extensions. Mirrors TS `getLabeledHooks`.
//
// `pickPhase` extracts the per-phase hook from a `*hookAdapterHandles` (passing
// nil-safe). Caller must hold s.mu (read).
func orderedHooks[F any](
	s *x402ResourceServer,
	phase string,
	manual []F,
	scheme *hookAdapterHandles,
	declaredExtensions map[string]interface{},
	pickPhase func(*hookAdapterHandles) F,
	isNil func(F) bool,
) []labeledHook[F] {
	out := make([]labeledHook[F], 0, len(manual)+1+len(declaredExtensions))
	for i, h := range manual {
		out = append(out, labeledHook[F]{Label: fmt.Sprintf("manual %s hook #%d", phase, i), Hook: h})
	}
	if scheme != nil {
		if h := pickPhase(scheme); !isNil(h) {
			out = append(out, labeledHook[F]{Label: fmt.Sprintf("scheme %s", phase), Hook: h})
		}
	}
	for key := range declaredExtensions {
		if handles, ok := s.extensionHookAdapters[key]; ok {
			if h := pickPhase(handles); !isNil(h) {
				out = append(out, labeledHook[F]{Label: fmt.Sprintf("extension %q %s", key, phase), Hook: h})
			}
		}
	}
	return out
}

// CreatePaymentCancellationDispatcher returns a dispatcher with no declared
// extensions. Equivalent to CreatePaymentCancellationDispatcherWithExtensions(...,
// nil). Kept for callers that don't track route extension declarations.
func (s *x402ResourceServer) CreatePaymentCancellationDispatcher(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
) *PaymentCancellationDispatcher {
	return s.CreatePaymentCancellationDispatcherWithExtensions(ctx, payload, requirements, nil)
}

// CreatePaymentCancellationDispatcherWithExtensions returns a dispatcher
// that, when Cancel'd, invokes onVerifiedPaymentCanceled hooks exactly once.
// The HTTP transport calls this after a successful Verify but before/instead
// of Settle when the resource handler errors or returns a non-2xx response.
//
// Hook execution order (mirrors verify/settle): manual → matched scheme →
// declared extensions. Extension hooks gate on `declaredExtensions[key]`
// being set on the route.
func (s *x402ResourceServer) CreatePaymentCancellationDispatcherWithExtensions(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	declaredExtensions map[string]interface{},
) *PaymentCancellationDispatcher {
	payloadBytes, _ := json.Marshal(payload)
	requirementsBytes, _ := json.Marshal(requirements)
	settleCtx := SettleContext{
		Ctx:                ctx,
		Payload:            payload,
		Requirements:       requirements,
		DeclaredExtensions: declaredExtensions,
		PayloadBytes:       payloadBytes,
		RequirementsBytes:  requirementsBytes,
	}
	return &PaymentCancellationDispatcher{
		fire: func(opts VerifiedPaymentCancelOptions) {
			cancelCtx := VerifiedPaymentCanceledContext{
				SettleContext:  settleCtx,
				Reason:         opts.Reason,
				Err:            opts.Err,
				ResponseStatus: opts.ResponseStatus,
			}
			s.mu.RLock()
			matchedScheme := s.matchedSchemeHooks(Network(requirements.Network), requirements.Scheme)
			hooks := orderedHooks(s, "onVerifiedPaymentCanceled", s.onVerifiedPaymentCanceledHooks, matchedScheme,
				declaredExtensions, func(h *hookAdapterHandles) OnVerifiedPaymentCanceledHook { return h.OnVerifiedPaymentCanceled },
				func(f OnVerifiedPaymentCanceledHook) bool { return f == nil })
			s.mu.RUnlock()
			for _, lh := range hooks {
				_ = lh.Hook(cancelCtx)
			}
		},
	}
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

// VerifyPayment verifies a V2 payment with no declared extensions.
// Equivalent to VerifyPaymentWithExtensions(ctx, payload, requirements, nil).
func (s *x402ResourceServer) VerifyPayment(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements) (*VerifyResponse, error) {
	return s.VerifyPaymentWithExtensions(ctx, payload, requirements, nil)
}

// VerifyPaymentWithExtensions verifies a V2 payment, gating extension hooks
// on the supplied `declaredExtensions` map (keys must be present for the
// extension's hook to fire). Hook execution order: manual → matched scheme →
// declared extensions.
func (s *x402ResourceServer) VerifyPaymentWithExtensions(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	declaredExtensions map[string]interface{},
) (*VerifyResponse, error) {
	// Marshal to bytes early for hooks (escape hatch for extensions)
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, NewVerifyError(ErrFailedToMarshalPayload, "", err.Error())
	}

	requirementsBytes, err := json.Marshal(requirements)
	if err != nil {
		return nil, NewVerifyError(ErrFailedToMarshalRequirements, "", err.Error())
	}

	hookCtx := VerifyContext{
		Ctx:                ctx,
		Payload:            payload,
		Requirements:       requirements,
		DeclaredExtensions: declaredExtensions,
		PayloadBytes:       payloadBytes,
		RequirementsBytes:  requirementsBytes,
	}

	s.mu.RLock()
	scheme := requirements.Scheme
	network := Network(requirements.Network)
	matchedScheme := s.matchedSchemeHooks(network, scheme)
	beforeVerifyHooks := orderedHooks(s, "beforeVerify", s.beforeVerifyHooks, matchedScheme,
		declaredExtensions, func(h *hookAdapterHandles) BeforeVerifyHook { return h.BeforeVerify },
		func(f BeforeVerifyHook) bool { return f == nil })
	afterVerifyHooks := orderedHooks(s, "afterVerify", s.afterVerifyHooks, matchedScheme,
		declaredExtensions, func(h *hookAdapterHandles) AfterVerifyHook { return h.AfterVerify },
		func(f AfterVerifyHook) bool { return f == nil })
	verifyFailureHooks := orderedHooks(s, "onVerifyFailure", s.onVerifyFailureHooks, matchedScheme,
		declaredExtensions, func(h *hookAdapterHandles) OnVerifyFailureHook { return h.OnVerifyFailure },
		func(f OnVerifyFailureHook) bool { return f == nil })
	facilitator := s.facilitatorClients[network][scheme]
	s.mu.RUnlock()

	var skipVerifyResult *VerifyResponse
	for _, lh := range beforeVerifyHooks {
		result, err := lh.Hook(hookCtx)
		if err != nil {
			return nil, err
		}
		if result == nil {
			continue
		}
		if result.Abort {
			return nil, NewVerifyError(result.Reason, "", result.Message)
		}
		if result.Skip && result.SkipVerifyResult != nil {
			// Last skip wins, like SettleResponse for after-hooks
			skipVerifyResult = result.SkipVerifyResult
		}
	}

	// Short-circuit: a BeforeVerify hook produced a local verify result. Still run
	// AfterVerify hooks so cooperative-refund SkipHandler signaling works.
	if skipVerifyResult != nil {
		resultCtx := VerifyResultContext{VerifyContext: hookCtx, Result: skipVerifyResult}
		for _, lh := range afterVerifyHooks {
			directive, _ := lh.Hook(resultCtx)
			if directive != nil && directive.SkipHandler {
				resp := directive.Response
				if resp == nil {
					resp = &SkipHandlerDirective{}
				}
				skipVerifyResult.SkipHandler = resp
			}
		}
		return skipVerifyResult, nil
	}

	if facilitator == nil {
		return nil, NewVerifyError(ErrNoFacilitatorForNetwork, "", fmt.Sprintf("no facilitator for scheme=%q network=%q", scheme, network))
	}

	// Use already marshaled bytes for network call
	verifyResult, verifyErr := facilitator.Verify(ctx, payloadBytes, requirementsBytes)

	// Handle failure
	if verifyErr != nil {
		failureCtx := VerifyFailureContext{VerifyContext: hookCtx, Error: verifyErr}
		for _, lh := range verifyFailureHooks {
			result, _ := lh.Hook(failureCtx)
			if result != nil && result.Recovered {
				return result.Result, nil
			}
		}
		return verifyResult, verifyErr
	}

	// Execute afterVerify hooks. The last hook to return a SkipHandler directive
	// wins; this lets schemes signal that a self-contained operation (e.g.
	// cooperative refund) should bypass the resource handler and settle inline.
	resultCtx := VerifyResultContext{VerifyContext: hookCtx, Result: verifyResult}
	for _, lh := range afterVerifyHooks {
		directive, _ := lh.Hook(resultCtx) // Log errors but don't fail
		if directive != nil && directive.SkipHandler {
			resp := directive.Response
			if resp == nil {
				resp = &SkipHandlerDirective{}
			}
			verifyResult.SkipHandler = resp
		}
	}

	return verifyResult, nil
}

// SettlePayment settles a V2 payment with no declared extensions.
// Equivalent to SettlePaymentWithExtensions(ctx, payload, requirements, overrides, nil).
func (s *x402ResourceServer) SettlePayment(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements, overrides *SettlementOverrides) (*SettleResponse, error) {
	return s.SettlePaymentWithExtensions(ctx, payload, requirements, overrides, nil)
}

// SettlePaymentWithExtensions settles a V2 payment, gating extension hooks on
// the supplied `declaredExtensions` map (keys must be present for the
// extension's hook to fire). Hook execution order: manual → matched scheme →
// declared extensions. Mirrors TS `settlePayment(payload, requirements,
// overrides, declaredExtensions)`.
//
// If overrides is non-nil and overrides.Amount is set, the effective
// requirements amount is replaced before settlement (partial settlement for
// upto scheme).
func (s *x402ResourceServer) SettlePaymentWithExtensions(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	overrides *SettlementOverrides,
	declaredExtensions map[string]interface{},
) (*SettleResponse, error) {
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

	hookCtx := SettleContext{
		Ctx:                ctx,
		Payload:            payload,
		Requirements:       effectiveRequirements,
		DeclaredExtensions: declaredExtensions,
		PayloadBytes:       payloadBytes,
		RequirementsBytes:  requirementsBytes,
	}

	s.mu.RLock()
	scheme := effectiveRequirements.Scheme
	network := Network(effectiveRequirements.Network)
	matchedScheme := s.matchedSchemeHooks(network, scheme)
	beforeSettleHooks := orderedHooks(s, "beforeSettle", s.beforeSettleHooks, matchedScheme,
		declaredExtensions, func(h *hookAdapterHandles) BeforeSettleHook { return h.BeforeSettle },
		func(f BeforeSettleHook) bool { return f == nil })
	afterSettleHooks := orderedHooks(s, "afterSettle", s.afterSettleHooks, matchedScheme,
		declaredExtensions, func(h *hookAdapterHandles) AfterSettleHook { return h.AfterSettle },
		func(f AfterSettleHook) bool { return f == nil })
	settleFailureHooks := orderedHooks(s, "onSettleFailure", s.onSettleFailureHooks, matchedScheme,
		declaredExtensions, func(h *hookAdapterHandles) OnSettleFailureHook { return h.OnSettleFailure },
		func(f OnSettleFailureHook) bool { return f == nil })
	facilitator := s.facilitatorClients[network][scheme]
	s.mu.RUnlock()

	for _, lh := range beforeSettleHooks {
		result, err := lh.Hook(hookCtx)
		if err != nil {
			return nil, err
		}
		if result != nil {
			if result.Abort {
				return nil, NewSettleError(result.Reason, "", Network(effectiveRequirements.Network), "", result.Message)
			}
			if result.Skip && result.SkipResult != nil {
				// Execute afterSettle hooks even when skipping
				skipResultCtx := SettleResultContext{SettleContext: hookCtx, Result: result.SkipResult}
				for _, ah := range afterSettleHooks {
					_ = ah.Hook(skipResultCtx)
				}
				return result.SkipResult, nil
			}
		}
	}

	// Scheme-level settlement-payload enrichment. Mirrors TS
	// `enrichSettlementPayload`: schemes return additive fields that the
	// framework merges into payload.Payload after the additive policy has
	// rejected any attempt to overwrite existing keys.
	s.mu.RLock()
	matchedSchemeServer := s.schemes[network][scheme]
	s.mu.RUnlock()
	if enricher, ok := matchedSchemeServer.(EnrichSettlementPayloadProvider); ok {
		enrichment, err := enricher.EnrichSettlementPayload(hookCtx)
		if err != nil {
			return nil, NewSettleError("scheme_enrich_settlement_payload_failed", "", network, "", err.Error())
		}
		if len(enrichment) > 0 {
			rawPayload := payload.GetPayload()
			if err := AssertAdditivePayloadEnrichment(rawPayload, enrichment, fmt.Sprintf(`scheme %q`, scheme)); err != nil {
				return nil, NewSettleError("scheme_enrich_settlement_payload_policy_violation", "", network, "", err.Error())
			}
			for k, v := range enrichment {
				rawPayload[k] = v
			}
		}
	}

	if facilitator == nil {
		return nil, NewSettleError("no_facilitator", "", network, "", fmt.Sprintf("no facilitator for scheme=%q network=%q", scheme, network))
	}

	// Re-marshal payload after hooks: BeforeSettle hooks AND scheme enrichment
	// may have mutated payload.Payload (e.g., the batch-settlement refund
	// enrich path adds the refund authorizer signatures). The pre-hook bytes
	// would carry the original shape and the facilitator would reject it.
	payloadBytes, err = json.Marshal(payload)
	if err != nil {
		return nil, NewSettleError("failed_to_marshal_payload", "", Network(effectiveRequirements.Network), "", err.Error())
	}

	settleResult, settleErr := facilitator.Settle(ctx, payloadBytes, requirementsBytes)

	// Handle failure
	if settleErr != nil {
		failureCtx := SettleFailureContext{SettleContext: hookCtx, Error: settleErr}
		for _, lh := range settleFailureHooks {
			result, _ := lh.Hook(failureCtx)
			if result != nil && result.Recovered {
				return result.Result, nil
			}
		}
		return settleResult, settleErr
	}

	// Execute afterSettle hooks
	resultCtx := SettleResultContext{SettleContext: hookCtx, Result: settleResult}
	for _, lh := range afterSettleHooks {
		_ = lh.Hook(resultCtx) // Log errors but don't fail
	}

	// Scheme-level settlement-response enrichment. Mirrors TS
	// `enrichSettlementResponse`: returned fields are deep-merged into
	// settleResult.Extra after the additive policy has rejected any attempt
	// to overwrite existing extras (recursively for nested maps).
	if enricher, ok := matchedSchemeServer.(EnrichSettlementResponseProvider); ok {
		enrichment, err := enricher.EnrichSettlementResponse(resultCtx)
		if err != nil {
			return settleResult, NewSettleError("scheme_enrich_settlement_response_failed", "", network, "", err.Error())
		}
		if len(enrichment) > 0 {
			extra := settleResult.Extra
			if extra == nil {
				extra = map[string]interface{}{}
			}
			if err := AssertAdditiveSettlementExtra(extra, enrichment, fmt.Sprintf(`scheme %q`, scheme)); err != nil {
				return settleResult, NewSettleError("scheme_enrich_settlement_response_policy_violation", "", network, "", err.Error())
			}
			settleResult.Extra = MergeAdditiveSettlementExtra(extra, enrichment)
		}
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

// CreatePaymentRequiredResponse creates a V2 PaymentRequired response.
// Equivalent to CreatePaymentRequiredResponseWithPayload with a nil payload —
// scheme enrichers that depend on the failed payload (e.g. batched corrective
// ChannelState) become no-ops.
func (s *x402ResourceServer) CreatePaymentRequiredResponse(
	requirements []types.PaymentRequirements,
	resourceInfo *types.ResourceInfo,
	errorMsg string,
	extensions map[string]interface{},
) types.PaymentRequired {
	return s.CreatePaymentRequiredResponseWithPayload(requirements, resourceInfo, errorMsg, extensions, nil)
}

// CreatePaymentRequiredResponseWithPayload creates a V2 PaymentRequired response
// and runs each registered scheme's PaymentRequiredEnricher (when implemented).
// Pass the failing payment payload on the verify-failure branch so per-scheme
// enrichers can attach corrective recovery state (e.g. batched ChannelState)
// to matching requirements; pass nil otherwise.
func (s *x402ResourceServer) CreatePaymentRequiredResponseWithPayload(
	requirements []types.PaymentRequirements,
	resourceInfo *types.ResourceInfo,
	errorMsg string,
	extensions map[string]interface{},
	paymentPayload *types.PaymentPayload,
) types.PaymentRequired {
	response := types.PaymentRequired{
		X402Version: 2,
		Error:       errorMsg,
		Resource:    resourceInfo,
		Accepts:     requirements,
		Extensions:  extensions,
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	for i := range requirements {
		networkSchemes, ok := s.schemes[Network(requirements[i].Network)]
		if !ok {
			continue
		}
		scheme, ok := networkSchemes[requirements[i].Scheme]
		if !ok {
			continue
		}
		enricher, ok := scheme.(PaymentRequiredEnricher)
		if !ok {
			continue
		}
		enricher.EnrichPaymentRequiredResponse(PaymentRequiredContext{
			Requirements:            requirements,
			PaymentPayload:          paymentPayload,
			ResourceInfo:            resourceInfo,
			Error:                   errorMsg,
			PaymentRequiredResponse: &response,
		})
	}

	return response
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
