package http

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	x402 "github.com/coinbase/x402/go"
	exttypes "github.com/coinbase/x402/go/extensions/types"
	"github.com/coinbase/x402/go/types"
)

// Pre-compiled regex patterns to avoid recompilation on every call.
var (
	multiSlashRegex = regexp.MustCompile(`/+`)
	paramRegex      = regexp.MustCompile(`\\\[([^\]]+)\\\]`)
	colonParamRegex = exttypes.ColonParamRegex
)

// ============================================================================
// HTTP Adapter Interface
// ============================================================================

// HTTPAdapter provides framework-agnostic HTTP operations
// Implement this for each web framework (Gin, Echo, net/http, etc.)
type HTTPAdapter interface {
	GetHeader(name string) string
	GetMethod() string
	GetPath() string
	GetURL() string
	GetAcceptHeader() string
	GetUserAgent() string
}

// ============================================================================
// Configuration Types
// ============================================================================

// PaywallConfig configures the HTML paywall for browser requests
type PaywallConfig struct {
	AppName    string `json:"appName,omitempty"`
	AppLogo    string `json:"appLogo,omitempty"`
	CurrentURL string `json:"currentUrl,omitempty"`
	Testnet    bool   `json:"testnet,omitempty"`
}

// DynamicPayToFunc is a function that resolves payTo address dynamically based on request context
type DynamicPayToFunc func(context.Context, HTTPRequestContext) (string, error)

// DynamicPriceFunc is a function that resolves price dynamically based on request context
type DynamicPriceFunc func(context.Context, HTTPRequestContext) (x402.Price, error)

// UnpaidResponse represents the custom response for unpaid (402) API requests.
// This allows servers to return preview data, error messages, or other content
// when a request lacks payment.
type UnpaidResponse struct {
	// ContentType is the content type for the response (e.g., "application/json", "text/plain").
	ContentType string

	// Body is the response body to include in the 402 response.
	Body interface{}
}

// UnpaidResponseBodyFunc generates a custom response for unpaid API requests.
// It receives the HTTP request context and returns the content type and body for the 402 response.
//
// For browser requests (Accept: text/html), the paywall HTML takes precedence.
// This callback is only used for API clients.
//
// Args:
//
//	ctx: Context for cancellation
//	reqCtx: HTTP request context
//
// Returns:
//
//	UnpaidResponse with ContentType and Body for the 402 response
type UnpaidResponseBodyFunc func(ctx context.Context, reqCtx HTTPRequestContext) (*UnpaidResponse, error)

// PaymentOption represents a single payment option for a route
// Represents one way a client can pay for access to the resource
type PaymentOption struct {
	Scheme            string                 `json:"scheme"`
	PayTo             interface{}            `json:"payTo"` // string or DynamicPayToFunc
	Price             interface{}            `json:"price"` // x402.Price or DynamicPriceFunc
	Network           x402.Network           `json:"network"`
	MaxTimeoutSeconds int                    `json:"maxTimeoutSeconds,omitempty"`
	Extra             map[string]interface{} `json:"extra,omitempty"`
}

// PaymentOptions is a slice of PaymentOption for convenience
type PaymentOptions = []PaymentOption

// RouteConfig defines payment configuration for an HTTP endpoint
type RouteConfig struct {
	// Payment options for this route
	Accepts PaymentOptions `json:"accepts"`

	// HTTP-specific metadata
	Resource          string                 `json:"resource,omitempty"`
	Description       string                 `json:"description,omitempty"`
	MimeType          string                 `json:"mimeType,omitempty"`
	CustomPaywallHTML string                 `json:"customPaywallHtml,omitempty"`
	Extensions        map[string]interface{} `json:"extensions,omitempty"`

	// UnpaidResponseBody is an optional callback to generate a custom response for unpaid API requests.
	// For browser requests (Accept: text/html), the paywall HTML takes precedence.
	// If not provided, defaults to { ContentType: "application/json", Body: nil }.
	UnpaidResponseBody UnpaidResponseBodyFunc `json:"-"`
}

// RoutesConfig maps route patterns to configurations
type RoutesConfig map[string]RouteConfig

// CompiledRoute is a parsed route ready for matching
type CompiledRoute struct {
	Verb    string
	Regex   *regexp.Regexp
	Config  RouteConfig
	Pattern string
}

// ============================================================================
// Request/Response Types
// ============================================================================

// ProtectedRequestHookResult represents the result of a protected request hook.
// A nil result means the hook has no opinion and the next hook (or payment flow) should proceed.
type ProtectedRequestHookResult struct {
	// GrantAccess bypasses payment and grants free access to the resource.
	GrantAccess bool
	// Abort denies the request with a 403 status and the provided Reason.
	Abort  bool
	Reason string
}

// ProtectedRequestHook is called on every request to a protected route, before payment processing.
// It receives the request context and the matched route configuration.
// Return nil to continue to the next hook or payment flow.
// Return a result with GrantAccess=true to bypass payment.
// Return a result with Abort=true to deny the request with a 403 status.
type ProtectedRequestHook func(ctx context.Context, reqCtx HTTPRequestContext, routeConfig RouteConfig) (*ProtectedRequestHookResult, error)

// HTTPRequestContext encapsulates an HTTP request
type HTTPRequestContext struct {
	Adapter       HTTPAdapter
	Path          string
	Method        string
	PaymentHeader string
	RoutePattern  string
}

// HTTPTransportContext carries request and response data through settlement processing.
// ResponseHeaders must be an http.Header — use Header.Get/Del to preserve canonicalization.
type HTTPTransportContext struct {
	Request         *HTTPRequestContext
	ResponseBody    []byte
	ResponseHeaders http.Header
}

// HTTPResponseInstructions tells the framework how to respond
type HTTPResponseInstructions struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    interface{}       `json:"body,omitempty"`
	IsHTML  bool              `json:"isHtml,omitempty"`
}

// HTTPProcessResult indicates the result of processing a payment request
type HTTPProcessResult struct {
	Type                string
	Response            *HTTPResponseInstructions
	PaymentPayload      *types.PaymentPayload      // V2 only
	PaymentRequirements *types.PaymentRequirements // V2 only
}

// Result type constants
const (
	ResultNoPaymentRequired = "no-payment-required"
	ResultPaymentVerified   = "payment-verified"
	ResultPaymentError      = "payment-error"
)

// ProcessSettleResult represents the result of settlement processing
type ProcessSettleResult struct {
	Success     bool
	Headers     map[string]string
	ErrorReason string
	Transaction string
	Network     x402.Network
	Payer       string
	// Response contains HTTP instructions for the failure case (status 402, body, etc).
	// Set when Success is false; nil when Success is true.
	Response *HTTPResponseInstructions
}

// ============================================================================
// Route Validation Types
// ============================================================================

// RouteValidationError represents a single validation failure for a route's payment option
type RouteValidationError struct {
	// RoutePattern is the route pattern (e.g., "GET /api/weather")
	RoutePattern string

	// Scheme is the payment scheme that failed validation
	Scheme string

	// Network is the network that failed validation
	Network x402.Network

	// Reason is the type of validation failure: "missing_scheme" or "missing_facilitator"
	Reason string

	// Message is a human-readable error message
	Message string
}

// RouteConfigurationError collects all route validation errors
type RouteConfigurationError struct {
	// Errors contains all validation failures
	Errors []RouteValidationError
}

// Error returns a formatted error message listing all validation failures
func (e *RouteConfigurationError) Error() string {
	lines := make([]string, 0, len(e.Errors)+1)
	lines = append(lines, "x402 Route Configuration Errors:")
	for _, err := range e.Errors {
		lines = append(lines, "  - "+err.Message)
	}
	return strings.Join(lines, "\n")
}

// ============================================================================
// x402HTTPResourceServer
// ============================================================================

// x402HTTPResourceServer provides HTTP-specific payment handling
type x402HTTPResourceServer struct {
	*x402.X402ResourceServer
	compiledRoutes        []CompiledRoute
	paywallProvider       PaywallProvider
	protectedRequestHooks []ProtectedRequestHook
}

// Newx402HTTPResourceServer creates a new HTTP resource server
func Newx402HTTPResourceServer(routes RoutesConfig, opts ...x402.ResourceServerOption) *x402HTTPResourceServer {
	return Wrappedx402HTTPResourceServer(routes, x402.Newx402ResourceServer(opts...))
}

// Wrappedx402HTTPResourceServer wraps an existing resource server with HTTP functionality.
func Wrappedx402HTTPResourceServer(routes RoutesConfig, resourceServer *x402.X402ResourceServer) *x402HTTPResourceServer {
	server := &x402HTTPResourceServer{
		X402ResourceServer: resourceServer,
		compiledRoutes:     []CompiledRoute{},
	}

	// Handle both single route and multiple routes
	normalizedRoutes := routes
	if normalizedRoutes == nil {
		normalizedRoutes = make(RoutesConfig)
	}

	// Compile routes
	for pattern, config := range normalizedRoutes {
		verb, path, regex := parseRoutePattern(pattern)
		server.compiledRoutes = append(server.compiledRoutes, CompiledRoute{
			Verb:    verb,
			Regex:   regex,
			Config:  config,
			Pattern: path,
		})
	}

	return server
}

// RegisterPaywallProvider registers a custom PaywallProvider for generating paywall HTML.
// The provider takes precedence over the built-in EVM/SVM templates but is overridden
// by per-route CustomPaywallHTML. Returns the server for method chaining.
func (s *x402HTTPResourceServer) RegisterPaywallProvider(provider PaywallProvider) *x402HTTPResourceServer {
	s.paywallProvider = provider
	return s
}

// OnProtectedRequest registers a hook that runs on every request to a protected route,
// before payment processing. Hooks are executed in registration order; the first hook
// to return a non-nil result determines the outcome.
// Returns the server instance for method chaining.
func (s *x402HTTPResourceServer) OnProtectedRequest(hook ProtectedRequestHook) *x402HTTPResourceServer {
	s.protectedRequestHooks = append(s.protectedRequestHooks, hook)
	return s
}

// Initialize initializes the server by populating facilitator data and validating route configuration.
// It calls the parent server's Initialize to fetch facilitator support, then validates that all
// configured routes have matching scheme registrations and facilitator support.
func (s *x402HTTPResourceServer) Initialize(ctx context.Context) error {
	// First, initialize the parent (populates facilitatorClients from GetSupported)
	if err := s.X402ResourceServer.Initialize(ctx); err != nil {
		return err
	}

	// Then validate route configuration against registered schemes and facilitator support
	return s.validateRouteConfiguration()
}

// validateRouteConfiguration checks that all configured routes have matching scheme registrations
// and facilitator support. Returns a RouteConfigurationError if any mismatches are found.
func (s *x402HTTPResourceServer) validateRouteConfiguration() error {
	var errors []RouteValidationError

	for _, route := range s.compiledRoutes {
		// Warn if wildcard routes are used with discovery extensions
		if strings.Contains(route.Pattern, "*") && route.Config.Extensions != nil {
			if _, hasBazaar := route.Config.Extensions["bazaar"]; hasBazaar {
				log.Printf("[x402] Route %q %s: Wildcard (*) patterns with bazaar discovery extensions "+
					"will auto-generate parameter names (var1, var2, ...). "+
					"Consider using named parameters instead (e.g. /weather/:city) for better discovery metadata.",
					route.Verb, route.Pattern)
			}
		}

		for _, option := range route.Config.Accepts {
			// Check 1: Is the scheme registered for this network?
			if !s.HasRegisteredScheme(option.Network, option.Scheme) {
				errors = append(errors, RouteValidationError{
					RoutePattern: route.Verb + " " + route.Regex.String(),
					Scheme:       option.Scheme,
					Network:      option.Network,
					Reason:       "missing_scheme",
					Message:      fmt.Sprintf("Route %q: No scheme implementation registered for %q on network %q", route.Verb+" "+route.Regex.String(), option.Scheme, option.Network),
				})
				// Skip facilitator check if scheme isn't registered
				continue
			}

			// Check 2: Does a facilitator support this scheme/network combination?
			if !s.HasFacilitatorSupport(option.Network, option.Scheme) {
				errors = append(errors, RouteValidationError{
					RoutePattern: route.Verb + " " + route.Regex.String(),
					Scheme:       option.Scheme,
					Network:      option.Network,
					Reason:       "missing_facilitator",
					Message:      fmt.Sprintf("Route %q: Facilitator does not support scheme %q on network %q", route.Verb+" "+route.Regex.String(), option.Scheme, option.Network),
				})
			}
		}
	}

	if len(errors) > 0 {
		return &RouteConfigurationError{Errors: errors}
	}

	return nil
}

// BuildPaymentRequirementsFromOptions builds payment requirements from multiple payment options
// This method handles resolving dynamic values and building requirements for each option
//
// Args:
//
//	ctx: Context for cancellation
//	options: Payment options (may contain dynamic functions)
//	reqCtx: HTTP request context for dynamic resolution
//
// Returns:
//
//	Array of payment requirements (one per option)
func (s *x402HTTPResourceServer) BuildPaymentRequirementsFromOptions(ctx context.Context, options []PaymentOption, reqCtx HTTPRequestContext) ([]types.PaymentRequirements, error) {
	allRequirements := make([]types.PaymentRequirements, 0)

	for _, option := range options {
		// Resolve dynamic payTo and price if they are functions
		var resolvedPayTo string
		if payToFunc, ok := option.PayTo.(DynamicPayToFunc); ok {
			// It's a function, call it
			payTo, err := payToFunc(ctx, reqCtx)
			if err != nil {
				return nil, fmt.Errorf("failed to resolve dynamic payTo: %w", err)
			}
			resolvedPayTo = payTo
		} else if payToStr, ok := option.PayTo.(string); ok {
			// It's a static string
			resolvedPayTo = payToStr
		} else {
			return nil, fmt.Errorf("payTo must be string or DynamicPayToFunc, got %T", option.PayTo)
		}

		// Resolve Price (x402.Price or DynamicPriceFunc)
		var resolvedPrice x402.Price
		if priceFunc, ok := option.Price.(DynamicPriceFunc); ok {
			// It's a function, call it
			price, err := priceFunc(ctx, reqCtx)
			if err != nil {
				return nil, fmt.Errorf("failed to resolve dynamic price: %w", err)
			}
			resolvedPrice = price
		} else {
			// It's a static value (string, number, or AssetAmount)
			resolvedPrice = option.Price
		}

		// Build resource config from this option
		resourceConfig := x402.ResourceConfig{
			Scheme:            option.Scheme,
			PayTo:             resolvedPayTo,
			Price:             resolvedPrice,
			Network:           option.Network,
			MaxTimeoutSeconds: option.MaxTimeoutSeconds,
			Extra:             option.Extra,
		}

		// Use existing BuildPaymentRequirementsFromConfig for each option
		requirements, err := s.BuildPaymentRequirementsFromConfig(ctx, resourceConfig)
		if err != nil {
			return nil, fmt.Errorf("failed to build requirements for option %s on %s: %w", option.Scheme, option.Network, err)
		}

		allRequirements = append(allRequirements, requirements...)
	}

	return allRequirements, nil
}

// ProcessHTTPRequest handles an HTTP request and returns processing result
func (s *x402HTTPResourceServer) ProcessHTTPRequest(ctx context.Context, reqCtx HTTPRequestContext, paywallConfig *PaywallConfig) HTTPProcessResult {
	if reqCtx.Method == "" {
		reqCtx.Method = reqCtx.Adapter.GetMethod()
	}

	// Find matching route
	routeConfig, routePattern := s.getRouteConfig(reqCtx.Path, reqCtx.Method)
	if routeConfig == nil {
		return HTTPProcessResult{Type: ResultNoPaymentRequired}
	}
	reqCtx.RoutePattern = routePattern

	// Execute protected request hooks before any payment processing
	for _, hook := range s.protectedRequestHooks {
		result, err := hook(ctx, reqCtx, *routeConfig)
		if err != nil {
			return HTTPProcessResult{
				Type: ResultPaymentError,
				Response: &HTTPResponseInstructions{
					Status:  500,
					Headers: map[string]string{"Content-Type": "application/json"},
					Body:    map[string]string{"error": fmt.Sprintf("protected request hook error: %v", err)},
				},
			}
		}
		if result != nil {
			if result.GrantAccess {
				return HTTPProcessResult{Type: ResultNoPaymentRequired}
			}
			if result.Abort {
				return HTTPProcessResult{
					Type: ResultPaymentError,
					Response: &HTTPResponseInstructions{
						Status:  403,
						Headers: map[string]string{"Content-Type": "application/json"},
						Body:    map[string]string{"error": result.Reason},
					},
				}
			}
		}
	}

	// Get payment options from route config
	paymentOptions := routeConfig.Accepts
	if len(paymentOptions) == 0 {
		return HTTPProcessResult{Type: ResultNoPaymentRequired}
	}

	// Check for payment header (V2 only)
	typedPayload, err := s.extractPaymentV2(reqCtx.Adapter)
	if err != nil {
		return HTTPProcessResult{
			Type:     ResultPaymentError,
			Response: &HTTPResponseInstructions{Status: 400, Body: map[string]string{"error": "Invalid payment"}},
		}
	}

	// Build requirements from all payment options (resolves dynamic values inline)
	requirements, err := s.BuildPaymentRequirementsFromOptions(ctx, paymentOptions, reqCtx)
	if err != nil {
		return HTTPProcessResult{
			Type: ResultPaymentError,
			Response: &HTTPResponseInstructions{
				Status:  500,
				Headers: map[string]string{"Content-Type": "application/json"},
				Body:    map[string]string{"error": err.Error()},
			},
		}
	}

	// Create resource info from route config
	resourceURL := routeConfig.Resource
	if resourceURL == "" {
		resourceURL = reqCtx.Adapter.GetURL()
	}

	resourceInfo := &types.ResourceInfo{
		URL:         resourceURL,
		Description: routeConfig.Description,
		MimeType:    routeConfig.MimeType,
	}

	for i := range requirements {
		if requirements[i].Extra == nil {
			requirements[i].Extra = make(map[string]interface{})
		}
	}

	extensions := routeConfig.Extensions
	if len(extensions) > 0 {
		extensions = s.EnrichExtensions(extensions, reqCtx)
	}

	if typedPayload == nil {
		paymentRequired := s.CreatePaymentRequiredResponse(
			requirements,
			resourceInfo,
			"Payment required",
			extensions,
		)

		// Call the UnpaidResponseBody callback if provided
		var unpaidResponse *UnpaidResponse
		if routeConfig.UnpaidResponseBody != nil {
			unpaidResp, err := routeConfig.UnpaidResponseBody(ctx, reqCtx)
			if err != nil {
				return HTTPProcessResult{
					Type: ResultPaymentError,
					Response: &HTTPResponseInstructions{
						Status:  500,
						Headers: map[string]string{"Content-Type": "application/json"},
						Body:    map[string]string{"error": fmt.Sprintf("Failed to generate unpaid response: %v", err)},
					},
				}
			}
			unpaidResponse = unpaidResp
		}

		response, err := s.createHTTPResponseV2(
			paymentRequired,
			s.isWebBrowser(reqCtx.Adapter),
			paywallConfig,
			routeConfig.CustomPaywallHTML,
			unpaidResponse,
		)
		if err != nil {
			return HTTPProcessResult{
				Type: ResultPaymentError,
				Response: &HTTPResponseInstructions{
					Status:  500,
					Headers: map[string]string{"Content-Type": "application/json"},
					Body:    map[string]string{"error": fmt.Sprintf("Failed to create payment response: %v", err)},
				},
			}
		}
		return HTTPProcessResult{
			Type:     ResultPaymentError,
			Response: response,
		}
	}

	// Find matching requirements (type-safe)
	matchingReqs := s.FindMatchingRequirements(requirements, *typedPayload)
	if matchingReqs == nil {
		paymentRequired := s.CreatePaymentRequiredResponse(
			requirements,
			resourceInfo,
			"No matching payment requirements",
			extensions,
		)

		response, err := s.createHTTPResponseV2(paymentRequired, false, paywallConfig, "", nil)
		if err != nil {
			return HTTPProcessResult{
				Type: ResultPaymentError,
				Response: &HTTPResponseInstructions{
					Status:  500,
					Headers: map[string]string{"Content-Type": "application/json"},
					Body:    map[string]string{"error": fmt.Sprintf("Failed to create payment response: %v", err)},
				},
			}
		}
		return HTTPProcessResult{
			Type:     ResultPaymentError,
			Response: response,
		}
	}

	// Verify payment (type-safe)
	_, verifyErr := s.VerifyPayment(ctx, *typedPayload, *matchingReqs)
	if verifyErr != nil {
		err = verifyErr
		errorMsg := err.Error()

		paymentRequired := s.CreatePaymentRequiredResponse(
			requirements,
			resourceInfo,
			errorMsg,
			extensions,
		)

		response, err := s.createHTTPResponseV2(paymentRequired, false, paywallConfig, "", nil)
		if err != nil {
			return HTTPProcessResult{
				Type: ResultPaymentError,
				Response: &HTTPResponseInstructions{
					Status:  500,
					Headers: map[string]string{"Content-Type": "application/json"},
					Body:    map[string]string{"error": fmt.Sprintf("Failed to create payment response: %v", err)},
				},
			}
		}
		return HTTPProcessResult{
			Type:     ResultPaymentError,
			Response: response,
		}
	}

	// Payment verified
	return HTTPProcessResult{
		Type:                ResultPaymentVerified,
		PaymentPayload:      typedPayload,
		PaymentRequirements: matchingReqs,
	}
}

// RequiresPayment checks if a request requires payment based on route configuration
func (s *x402HTTPResourceServer) RequiresPayment(reqCtx HTTPRequestContext) bool {
	method := reqCtx.Method
	if method == "" {
		method = reqCtx.Adapter.GetMethod()
	}
	routeConfig, _ := s.getRouteConfig(reqCtx.Path, method)
	return routeConfig != nil
}

// SettlementOverridesHeader is the HTTP header name for settlement overrides.
// The value is the canonical HTTP header form (Title-Case) so it works correctly
// with both http.Header methods and direct map access.
const SettlementOverridesHeader = "Settlement-Overrides"

// MarshalSettlementOverrides serializes overrides to the JSON string suitable for
// the SettlementOverridesHeader value. Returns an empty string on marshal failure
// (which cannot happen for a well-formed SettlementOverrides value).
func MarshalSettlementOverrides(overrides *x402.SettlementOverrides) string {
	data, _ := json.Marshal(overrides)
	return string(data)
}

// ProcessSettlement handles settlement after successful response.
// If overrides is non-nil, it takes precedence. Otherwise, falls back to reading
// the settlement-overrides header from the transport context's ResponseHeaders
// (set by the route handler via SetSettlementOverrides). The header is deleted
// from ResponseHeaders to prevent it from being sent to the client.
func (s *x402HTTPResourceServer) ProcessSettlement(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements, overrides *x402.SettlementOverrides, transportContext *HTTPTransportContext) *ProcessSettleResult {
	resolved := overrides
	if resolved == nil && transportContext != nil && transportContext.ResponseHeaders != nil {
		if val := transportContext.ResponseHeaders.Get(SettlementOverridesHeader); val != "" {
			var parsed x402.SettlementOverrides
			if err := json.Unmarshal([]byte(val), &parsed); err == nil {
				resolved = &parsed
			}
			transportContext.ResponseHeaders.Del(SettlementOverridesHeader)
		}
	}

	settleResult, err := s.SettlePayment(ctx, payload, requirements, resolved)
	if err != nil {
		return s.buildSettlementFailureResult(err.Error(), x402.Network(requirements.Network), "", nil)
	}

	if !settleResult.Success {
		return s.buildSettlementFailureResult(settleResult.ErrorReason, settleResult.Network, settleResult.Payer, settleResult)
	}

	headers, err := s.createSettlementHeaders(settleResult)
	if err != nil {
		return s.buildSettlementFailureResult(
			fmt.Sprintf("failed to create settlement headers: %v", err),
			x402.Network(requirements.Network),
			settleResult.Payer,
			nil,
		)
	}

	return &ProcessSettleResult{
		Success:     true,
		Headers:     headers,
		Transaction: settleResult.Transaction,
		Network:     settleResult.Network,
		Payer:       settleResult.Payer,
	}
}

// buildSettlementFailureResult creates a ProcessSettleResult for settlement failure.
// It includes PAYMENT-RESPONSE header and empty body by default.
func (s *x402HTTPResourceServer) buildSettlementFailureResult(errorReason string, network x402.Network, payer string, settleResult *x402.SettleResponse) *ProcessSettleResult {
	failureResponse := x402.SettleResponse{
		Success:     false,
		ErrorReason: errorReason,
		Transaction: "",
		Network:     network,
		Payer:       payer,
	}
	if settleResult != nil {
		failureResponse.Network = settleResult.Network
		failureResponse.Payer = settleResult.Payer
	}

	headers, err := s.createSettlementHeaders(&failureResponse)
	if err != nil {
		// Fallback: return minimal result without PAYMENT-RESPONSE if encoding fails
		return &ProcessSettleResult{
			Success:     false,
			ErrorReason: errorReason,
			Response: &HTTPResponseInstructions{
				Status:  402,
				Headers: map[string]string{},
				Body:    map[string]interface{}{},
			},
		}
	}

	return &ProcessSettleResult{
		Success:     false,
		ErrorReason: errorReason,
		Headers:     headers,
		Response: &HTTPResponseInstructions{
			Status:  402,
			Headers: headers,
			Body:    map[string]interface{}{},
		},
	}
}

// ============================================================================
// Helper Methods
// ============================================================================

// getRouteConfig finds matching route configuration and returns the route pattern
func (s *x402HTTPResourceServer) getRouteConfig(path, method string) (*RouteConfig, string) {
	normalizedPath := normalizePath(path)
	upperMethod := strings.ToUpper(method)

	for _, route := range s.compiledRoutes {
		if route.Regex.MatchString(normalizedPath) &&
			(route.Verb == "*" || route.Verb == upperMethod) {
			config := route.Config // Make a copy
			return &config, route.Pattern
		}
	}

	return nil, ""
}

// extractPaymentV2 extracts V2 payment from headers (V2 only)
func (s *x402HTTPResourceServer) extractPaymentV2(adapter HTTPAdapter) (*types.PaymentPayload, error) {
	// Check v2 header
	header := adapter.GetHeader("PAYMENT-SIGNATURE")
	if header == "" {
		header = adapter.GetHeader("payment-signature")
	}

	if header == "" {
		return nil, nil // No payment header
	}

	// Decode base64 header
	jsonBytes, err := decodeBase64Header(header)
	if err != nil {
		return nil, fmt.Errorf("failed to decode payment header: %w", err)
	}

	// Detect version
	version, err := types.DetectVersion(jsonBytes)
	if err != nil {
		return nil, fmt.Errorf("failed to detect version: %w", err)
	}

	// V2 server only accepts V2 payments
	if version != 2 {
		return nil, fmt.Errorf("only V2 payments supported, got V%d", version)
	}

	// Unmarshal to V2 payload
	payload, err := types.ToPaymentPayload(jsonBytes)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal V2 payload: %w", err)
	}

	return payload, nil
}

// extractPayment extracts payment from headers (legacy method, now calls extractPaymentV2)
//
//nolint:unused // Legacy method kept for API compatibility
func (s *x402HTTPResourceServer) extractPayment(adapter HTTPAdapter) *x402.PaymentPayload {
	payload, err := s.extractPaymentV2(adapter)
	if err != nil || payload == nil {
		return nil
	}

	// Convert V2 to generic PaymentPayload for compatibility
	return &x402.PaymentPayload{
		X402Version: payload.X402Version,
		Payload:     payload.Payload,
		Accepted:    x402.PaymentRequirements{}, // TODO: Convert
		Resource:    nil,
		Extensions:  payload.Extensions,
	}
}

// decodeBase64Header decodes a base64 header to JSON bytes
func decodeBase64Header(header string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(header)
}

// isWebBrowser checks if request is from a web browser
func (s *x402HTTPResourceServer) isWebBrowser(adapter HTTPAdapter) bool {
	accept := adapter.GetAcceptHeader()
	userAgent := adapter.GetUserAgent()
	return strings.Contains(accept, "text/html") && strings.Contains(userAgent, "Mozilla")
}

// createHTTPResponseV2 creates response instructions for V2 PaymentRequired
//
// Args:
//
//	paymentRequired: The payment required response
//	isWebBrowser: Whether the request is from a web browser
//	paywallConfig: Optional paywall configuration
//	customHTML: Optional custom HTML for the paywall
//	unpaidResponse: Optional custom response for API clients (ignored for browser requests)
func (s *x402HTTPResourceServer) createHTTPResponseV2(paymentRequired types.PaymentRequired, isWebBrowser bool, paywallConfig *PaywallConfig, customHTML string, unpaidResponse *UnpaidResponse) (*HTTPResponseInstructions, error) {
	if isWebBrowser {
		html := s.generatePaywallHTMLV2(paymentRequired, paywallConfig, customHTML)
		return &HTTPResponseInstructions{
			Status: 402,
			Headers: map[string]string{
				"Content-Type": "text/html",
			},
			Body:   html,
			IsHTML: true,
		}, nil
	}

	// Use custom unpaid response if provided, otherwise default to JSON with no body
	contentType := "application/json"
	var body interface{}

	if unpaidResponse != nil {
		contentType = unpaidResponse.ContentType
		body = unpaidResponse.Body
	}

	encodedHeader, err := encodePaymentRequiredHeader(paymentRequired)
	if err != nil {
		return nil, fmt.Errorf("failed to encode payment required header: %w", err)
	}

	return &HTTPResponseInstructions{
		Status: 402,
		Headers: map[string]string{
			"Content-Type":     contentType,
			"PAYMENT-REQUIRED": encodedHeader,
		},
		Body: body,
	}, nil
}

// createHTTPResponse creates response instructions (legacy method)
//
//nolint:unused // Legacy method kept for API compatibility
func (s *x402HTTPResourceServer) createHTTPResponse(paymentRequired x402.PaymentRequired, isWebBrowser bool, paywallConfig *PaywallConfig, customHTML string) (*HTTPResponseInstructions, error) {
	// Convert to V2 and call V2 method
	v2Required := types.PaymentRequired{
		X402Version: 2,
		Error:       paymentRequired.Error,
		Resource:    nil, // TODO: convert
		Extensions:  paymentRequired.Extensions,
	}
	return s.createHTTPResponseV2(v2Required, isWebBrowser, paywallConfig, customHTML, nil)
}

// createSettlementHeaders creates settlement response headers
func (s *x402HTTPResourceServer) createSettlementHeaders(response *x402.SettleResponse) (map[string]string, error) {
	encodedHeader, err := encodePaymentResponseHeader(*response)
	if err != nil {
		return nil, fmt.Errorf("failed to encode payment response header: %w", err)
	}
	return map[string]string{
		"PAYMENT-RESPONSE": encodedHeader,
	}, nil
}

// generatePaywallHTMLV2 generates HTML paywall for V2 PaymentRequired.
// Fallback chain: 1) customHTML, 2) registered PaywallProvider, 3) built-in templates.
func (s *x402HTTPResourceServer) generatePaywallHTMLV2(paymentRequired types.PaymentRequired, config *PaywallConfig, customHTML string) string {
	// Tier 1: Per-route custom HTML (highest priority)
	if customHTML != "" {
		return customHTML
	}

	// Tier 2: Registered PaywallProvider
	if s.paywallProvider != nil {
		return s.paywallProvider.GenerateHTML(paymentRequired, config)
	}

	// Tier 3: Built-in EVM/SVM templates (default fallback)
	// Convert V2 to generic format to reuse existing HTML generation
	genericRequired := x402.PaymentRequired{
		X402Version: paymentRequired.X402Version,
		Error:       paymentRequired.Error,
		Resource:    nil,                          // Will convert
		Accepts:     []x402.PaymentRequirements{}, // Will convert
		Extensions:  paymentRequired.Extensions,
	}

	// Convert resource
	if paymentRequired.Resource != nil {
		genericRequired.Resource = &x402.ResourceInfo{
			URL:         paymentRequired.Resource.URL,
			Description: paymentRequired.Resource.Description,
			MimeType:    paymentRequired.Resource.MimeType,
		}
	}

	// Convert accepts
	for _, reqV2 := range paymentRequired.Accepts {
		genericRequired.Accepts = append(genericRequired.Accepts, x402.PaymentRequirements(reqV2))
	}

	// Reuse existing HTML generation
	return s.generatePaywallHTML(genericRequired, config, customHTML)
}

// generatePaywallHTML generates HTML paywall for browsers
func (s *x402HTTPResourceServer) generatePaywallHTML(paymentRequired x402.PaymentRequired, config *PaywallConfig, customHTML string) string {
	if customHTML != "" {
		return customHTML
	}

	// Calculate display amount (assuming USDC with 6 decimals)
	displayAmount := s.getDisplayAmount(paymentRequired)

	appName := ""
	appLogo := ""
	testnet := false
	currentURL := ""

	if config != nil {
		appName = config.AppName
		appLogo = config.AppLogo
		testnet = config.Testnet
		currentURL = config.CurrentURL
	}

	// Use resource URL as currentUrl if not explicitly configured
	if currentURL == "" && paymentRequired.Resource != nil {
		currentURL = paymentRequired.Resource.URL
	}

	requirementsJSON, _ := json.Marshal(paymentRequired)

	// Inject configuration into the template
	configScript := fmt.Sprintf(`<script>
		window.x402 = {
			paymentRequired: %s,
			appName: "%s",
			appLogo: "%s",
			amount: %.6f,
			testnet: %t,
			displayAmount: %.2f,
			currentUrl: "%s"
		};
	</script>`,
		string(requirementsJSON),
		html.EscapeString(appName),
		html.EscapeString(appLogo),
		displayAmount,
		testnet,
		displayAmount,
		html.EscapeString(currentURL),
	)

	// Select template based on network
	template := s.selectPaywallTemplate(paymentRequired)
	return strings.Replace(template, "</head>", configScript+"\n</head>", 1)
}

// selectPaywallTemplate chooses the appropriate paywall template based on the network
// Returns EVM template for eip155:* networks, SVM template for solana:* networks
func (s *x402HTTPResourceServer) selectPaywallTemplate(paymentRequired x402.PaymentRequired) string {
	if len(paymentRequired.Accepts) == 0 {
		return EVMPaywallTemplate // Default to EVM
	}

	network := paymentRequired.Accepts[0].Network
	if strings.HasPrefix(network, "solana:") {
		return SVMPaywallTemplate
	}
	return EVMPaywallTemplate
}

// getDisplayAmount extracts display amount from payment requirements
func (s *x402HTTPResourceServer) getDisplayAmount(paymentRequired x402.PaymentRequired) float64 {
	if len(paymentRequired.Accepts) > 0 {
		firstReq := paymentRequired.Accepts[0]
		// Check if amount field exists
		if firstReq.Amount != "" {
			// V2 format - parse amount
			amount, err := strconv.ParseFloat(firstReq.Amount, 64)
			if err == nil {
				// Assuming USDC with 6 decimals
				return amount / 1000000
			}
		}
	}
	return 0.0
}

// injectPaywallConfig injects a window.x402 configuration script into a paywall HTML template.
// Used by built-in PaywallNetworkHandler implementations to hydrate templates with payment data.
func injectPaywallConfig(template string, paymentRequired types.PaymentRequired, config *PaywallConfig) string {
	// Calculate display amount (assuming USDC with 6 decimals)
	var displayAmount float64
	if len(paymentRequired.Accepts) > 0 {
		amount, err := strconv.ParseFloat(paymentRequired.Accepts[0].Amount, 64)
		if err == nil {
			displayAmount = amount / 1000000
		}
	}

	appName := ""
	appLogo := ""
	testnet := false
	currentURL := ""

	if config != nil {
		appName = config.AppName
		appLogo = config.AppLogo
		testnet = config.Testnet
		currentURL = config.CurrentURL
	}

	if currentURL == "" && paymentRequired.Resource != nil {
		currentURL = paymentRequired.Resource.URL
	}

	requirementsJSON, _ := json.Marshal(paymentRequired)

	configScript := fmt.Sprintf(`<script>
		window.x402 = {
			paymentRequired: %s,
			appName: "%s",
			appLogo: "%s",
			amount: %.6f,
			testnet: %t,
			displayAmount: %.2f,
			currentUrl: "%s"
		};
	</script>`,
		string(requirementsJSON),
		html.EscapeString(appName),
		html.EscapeString(appLogo),
		displayAmount,
		testnet,
		displayAmount,
		html.EscapeString(currentURL),
	)

	return strings.Replace(template, "</head>", configScript+"\n</head>", 1)
}

// ============================================================================
// Utility Functions
// ============================================================================

// parseRoutePattern parses a route pattern like "GET /api/*"
func parseRoutePattern(pattern string) (string, string, *regexp.Regexp) {
	parts := strings.Fields(pattern)

	var verb, path string
	if len(parts) == 2 {
		verb = strings.ToUpper(parts[0])
		path = parts[1]
	} else {
		verb = "*"
		path = pattern
	}

	// Convert pattern to regex
	regexPattern := "^" + regexp.QuoteMeta(path)
	regexPattern = strings.ReplaceAll(regexPattern, `\*`, `.*?`)
	// Handle parameters: [param] (Next.js style) and :param (Express style)
	regexPattern = paramRegex.ReplaceAllString(regexPattern, `[^/]+`)
	regexPattern = colonParamRegex.ReplaceAllString(regexPattern, `[^/]+`)
	regexPattern += "$"

	regex := regexp.MustCompile(regexPattern)

	return verb, path, regex
}

// normalizePath normalizes a URL path for matching
func normalizePath(path string) string {
	// Remove query string and fragment
	if idx := strings.IndexAny(path, "?#"); idx >= 0 {
		path = path[:idx]
	}

	// Decode URL encoding
	if decoded, err := url.PathUnescape(path); err == nil {
		path = decoded
	}

	// Normalize slashes
	path = strings.ReplaceAll(path, `\`, `/`)
	// Replace multiple slashes with single slash
	path = multiSlashRegex.ReplaceAllString(path, `/`)
	// Remove trailing slash
	path = strings.TrimSuffix(path, `/`)

	if path == "" {
		path = "/"
	}

	return path
}
