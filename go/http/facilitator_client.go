package http

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/types"
)

// ============================================================================
// HTTP Facilitator Client
// ============================================================================

// HTTPFacilitatorClient communicates with remote facilitator services over HTTP
// Implements FacilitatorClient interface (supports both V1 and V2)
type HTTPFacilitatorClient struct {
	url          string
	httpClient   *http.Client
	authProvider AuthProvider
	identifier   string
}

// AuthProvider generates authentication headers for facilitator requests
type AuthProvider interface {
	// GetAuthHeaders returns authentication headers for each endpoint
	GetAuthHeaders(ctx context.Context) (AuthHeaders, error)
}

// AuthHeaders contains authentication headers for facilitator endpoints
type AuthHeaders struct {
	Verify    map[string]string
	Settle    map[string]string
	Supported map[string]string
	Bazaar    map[string]string
}

// FacilitatorConfig configures the HTTP facilitator client
type FacilitatorConfig struct {
	// URL is the base URL of the facilitator service
	URL string

	// HTTPClient is the HTTP client to use (optional)
	HTTPClient *http.Client

	// AuthProvider provides authentication headers (optional)
	AuthProvider AuthProvider

	// Timeout for requests (optional, defaults to 30s)
	Timeout time.Duration

	// Identifier for this facilitator (optional)
	Identifier string
}

// DefaultFacilitatorURL is the default public facilitator
const DefaultFacilitatorURL = "https://x402.org/facilitator"

// getSupportedRetries is the number of retry attempts for GetSupported on 429 rate limit errors
const getSupportedRetries = 3

// getSupportedRetryBaseDelay is the base delay for exponential backoff on retries
const getSupportedRetryBaseDelay = 1 * time.Second

// FacilitatorResponseError indicates a facilitator returned malformed success payload data.
type FacilitatorResponseError struct {
	message string
	cause   error
}

func (e *FacilitatorResponseError) Error() string {
	return e.message
}

func (e *FacilitatorResponseError) Unwrap() error {
	return e.cause
}

type verifyResponseEnvelope struct {
	IsValid        *bool  `json:"isValid"`
	InvalidReason  string `json:"invalidReason,omitempty"`
	InvalidMessage string `json:"invalidMessage,omitempty"`
	Payer          string `json:"payer,omitempty"`
}

type settleResponseEnvelope struct {
	Success      *bool         `json:"success"`
	ErrorReason  string        `json:"errorReason,omitempty"`
	ErrorMessage string        `json:"errorMessage,omitempty"`
	Payer        string        `json:"payer,omitempty"`
	Transaction  *string       `json:"transaction"`
	Network      *x402.Network `json:"network"`
}

type supportedKindEnvelope struct {
	X402Version *int                   `json:"x402Version"`
	Scheme      string                 `json:"scheme"`
	Network     string                 `json:"network"`
	Extra       map[string]interface{} `json:"extra,omitempty"`
}

type supportedResponseEnvelope struct {
	Kinds      []supportedKindEnvelope `json:"kinds"`
	Extensions []string                `json:"extensions"`
	Signers    map[string][]string     `json:"signers"`
}

func responseExcerpt(body []byte, limit int) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return "<empty response>"
	}

	compact := strings.Join(strings.Fields(text), " ")
	if len(compact) <= limit {
		return compact
	}

	return compact[:limit-3] + "..."
}

func newFacilitatorResponseError(operation string, kind string, body []byte, cause error) error {
	return &FacilitatorResponseError{
		message: fmt.Sprintf("facilitator %s returned invalid %s: %s", operation, kind, responseExcerpt(body, 200)),
		cause:   cause,
	}
}

func parseVerifySuccessResponse(body []byte) (*x402.VerifyResponse, error) {
	var response verifyResponseEnvelope
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, newFacilitatorResponseError("verify", "JSON", body, err)
	}
	if response.IsValid == nil {
		return nil, newFacilitatorResponseError("verify", "data", body, fmt.Errorf("missing isValid"))
	}

	return &x402.VerifyResponse{
		IsValid:        *response.IsValid,
		InvalidReason:  response.InvalidReason,
		InvalidMessage: response.InvalidMessage,
		Payer:          response.Payer,
	}, nil
}

func parseSettleSuccessResponse(body []byte) (*x402.SettleResponse, error) {
	var response settleResponseEnvelope
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, newFacilitatorResponseError("settle", "JSON", body, err)
	}
	if response.Success == nil || response.Transaction == nil || response.Network == nil {
		return nil, newFacilitatorResponseError("settle", "data", body, fmt.Errorf("missing required fields"))
	}

	return &x402.SettleResponse{
		Success:      *response.Success,
		ErrorReason:  response.ErrorReason,
		ErrorMessage: response.ErrorMessage,
		Payer:        response.Payer,
		Transaction:  *response.Transaction,
		Network:      *response.Network,
	}, nil
}

func parseSupportedSuccessResponse(body []byte) (x402.SupportedResponse, error) {
	var response supportedResponseEnvelope
	if err := json.Unmarshal(body, &response); err != nil {
		return x402.SupportedResponse{}, newFacilitatorResponseError("getSupported", "JSON", body, err)
	}
	kinds := make([]x402.SupportedKind, 0, len(response.Kinds))
	for _, kind := range response.Kinds {
		if kind.X402Version == nil || kind.Scheme == "" || kind.Network == "" {
			return x402.SupportedResponse{}, newFacilitatorResponseError(
				"getSupported",
				"data",
				body,
				fmt.Errorf("invalid supported response fields"),
			)
		}
		kinds = append(kinds, x402.SupportedKind{
			X402Version: *kind.X402Version,
			Scheme:      kind.Scheme,
			Network:     kind.Network,
			Extra:       kind.Extra,
		})
	}

	extensions := response.Extensions
	if extensions == nil {
		extensions = []string{}
	}

	signers := response.Signers
	if signers == nil {
		signers = map[string][]string{}
	}

	return x402.SupportedResponse{
		Kinds:      kinds,
		Extensions: extensions,
		Signers:    signers,
	}, nil
}

// NewHTTPFacilitatorClient creates a new HTTP facilitator client
func NewHTTPFacilitatorClient(config *FacilitatorConfig) *HTTPFacilitatorClient {
	if config == nil {
		config = &FacilitatorConfig{}
	}

	url := config.URL
	if url == "" {
		url = DefaultFacilitatorURL
	}

	httpClient := config.HTTPClient
	if httpClient == nil {
		timeout := config.Timeout
		if timeout == 0 {
			timeout = 30 * time.Second
		}
		httpClient = &http.Client{
			Timeout: timeout,
		}
	}

	identifier := config.Identifier
	if identifier == "" {
		identifier = url
	}

	return &HTTPFacilitatorClient{
		url:          url,
		httpClient:   httpClient,
		authProvider: config.AuthProvider,
		identifier:   identifier,
	}
}

// URL returns the base URL of the facilitator service.
func (c *HTTPFacilitatorClient) URL() string {
	return c.url
}

// HTTPClient returns the underlying HTTP client.
func (c *HTTPFacilitatorClient) HTTPClient() *http.Client {
	return c.httpClient
}

// GetAuthProvider returns the authentication provider, or nil if not configured.
func (c *HTTPFacilitatorClient) GetAuthProvider() AuthProvider {
	return c.authProvider
}

// ============================================================================
// FacilitatorClient Implementation (Network Boundary - uses bytes)
// ============================================================================

// Verify checks if a payment is valid (supports both V1 and V2)
func (c *HTTPFacilitatorClient) Verify(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
	// Detect version from bytes
	version, err := types.DetectVersion(payloadBytes)
	if err != nil {
		return nil, fmt.Errorf("failed to detect version: %w", err)
	}

	return c.verifyHTTP(ctx, version, payloadBytes, requirementsBytes)
}

// Settle executes a payment (supports both V1 and V2)
func (c *HTTPFacilitatorClient) Settle(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
	// Detect version from bytes
	version, err := types.DetectVersion(payloadBytes)
	if err != nil {
		return nil, fmt.Errorf("failed to detect version: %w", err)
	}

	return c.settleHTTP(ctx, version, payloadBytes, requirementsBytes)
}

// GetSupported gets supported payment kinds (shared by both V1 and V2).
// Retries up to 3 times with exponential backoff on 429 rate limit errors.
func (c *HTTPFacilitatorClient) GetSupported(ctx context.Context) (x402.SupportedResponse, error) {
	var lastErr error

	for attempt := range getSupportedRetries {
		// Create request
		req, err := http.NewRequestWithContext(ctx, "GET", c.url+"/supported", nil)
		if err != nil {
			return x402.SupportedResponse{}, fmt.Errorf("failed to create supported request: %w", err)
		}

		req.Header.Set("Content-Type", "application/json")

		// Add auth headers if available
		if c.authProvider != nil {
			authHeaders, err := c.authProvider.GetAuthHeaders(ctx)
			if err != nil {
				return x402.SupportedResponse{}, fmt.Errorf("failed to get auth headers: %w", err)
			}
			for k, v := range authHeaders.Supported {
				req.Header.Set(k, v)
			}
		}

		// Make request
		resp, err := c.httpClient.Do(req)
		if err != nil {
			return x402.SupportedResponse{}, fmt.Errorf("supported request failed: %w", err)
		}

		// Read response body
		responseBody, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return x402.SupportedResponse{}, fmt.Errorf("failed to read response body: %w", err)
		}

		// Success
		if resp.StatusCode == http.StatusOK {
			return parseSupportedSuccessResponse(responseBody)
		}

		lastErr = fmt.Errorf(
			"facilitator supported failed (%d): %s",
			resp.StatusCode,
			responseExcerpt(responseBody, 200),
		)

		// Retry on 429 with exponential backoff, except on the last attempt
		if resp.StatusCode == http.StatusTooManyRequests && attempt < getSupportedRetries-1 {
			delay := getSupportedRetryBaseDelay * time.Duration(1<<uint(attempt))
			select {
			case <-time.After(delay):
				continue
			case <-ctx.Done():
				return x402.SupportedResponse{}, ctx.Err()
			}
		}

		// Non-429 errors or last attempt: return immediately
		return x402.SupportedResponse{}, lastErr
	}

	return x402.SupportedResponse{}, lastErr
}

// ============================================================================
// Internal HTTP Methods (shared by V1 and V2)
// ============================================================================

func (c *HTTPFacilitatorClient) verifyHTTP(ctx context.Context, version int, payloadBytes, requirementsBytes []byte) (*x402.VerifyResponse, error) {
	// Build request body
	var payloadMap, requirementsMap map[string]interface{}
	if err := json.Unmarshal(payloadBytes, &payloadMap); err != nil {
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}
	if err := json.Unmarshal(requirementsBytes, &requirementsMap); err != nil {
		return nil, fmt.Errorf("failed to unmarshal requirements: %w", err)
	}

	requestBody := map[string]interface{}{
		"x402Version":         version,
		"paymentPayload":      payloadMap,
		"paymentRequirements": requirementsMap,
	}

	body, err := json.Marshal(requestBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal verify request: %w", err)
	}

	// Create request
	req, err := http.NewRequestWithContext(ctx, "POST", c.url+"/verify", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create verify request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	// Add auth headers if available
	if c.authProvider != nil {
		authHeaders, err := c.authProvider.GetAuthHeaders(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to get auth headers: %w", err)
		}
		for k, v := range authHeaders.Verify {
			req.Header.Set(k, v)
		}
	}

	// Make request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("verify request failed: %w", err)
	}
	defer resp.Body.Close()

	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		var verifyResponse verifyResponseEnvelope
		if err := json.Unmarshal(responseBody, &verifyResponse); err == nil && verifyResponse.InvalidReason != "" {
			return nil, x402.NewVerifyError(
				verifyResponse.InvalidReason,
				verifyResponse.Payer,
				verifyResponse.InvalidMessage,
			)
		}
		return nil, fmt.Errorf("facilitator verify failed (%d): %s", resp.StatusCode, string(responseBody))
	}

	return parseVerifySuccessResponse(responseBody)
}

func (c *HTTPFacilitatorClient) settleHTTP(ctx context.Context, version int, payloadBytes, requirementsBytes []byte) (*x402.SettleResponse, error) {
	// Build request body
	var payloadMap, requirementsMap map[string]interface{}
	if err := json.Unmarshal(payloadBytes, &payloadMap); err != nil {
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}
	if err := json.Unmarshal(requirementsBytes, &requirementsMap); err != nil {
		return nil, fmt.Errorf("failed to unmarshal requirements: %w", err)
	}

	requestBody := map[string]interface{}{
		"x402Version":         version,
		"paymentPayload":      payloadMap,
		"paymentRequirements": requirementsMap,
	}

	body, err := json.Marshal(requestBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal settle request: %w", err)
	}

	// Create request
	req, err := http.NewRequestWithContext(ctx, "POST", c.url+"/settle", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create settle request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	// Add auth headers if available
	if c.authProvider != nil {
		authHeaders, err := c.authProvider.GetAuthHeaders(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to get auth headers: %w", err)
		}
		for k, v := range authHeaders.Settle {
			req.Header.Set(k, v)
		}
	}

	// Make request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("settle request failed: %w", err)
	}
	defer resp.Body.Close()

	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		var settleResponse settleResponseEnvelope
		if err := json.Unmarshal(responseBody, &settleResponse); err == nil && settleResponse.ErrorReason != "" {
			network := x402.Network("")
			if settleResponse.Network != nil {
				network = *settleResponse.Network
			}
			transaction := ""
			if settleResponse.Transaction != nil {
				transaction = *settleResponse.Transaction
			}
			return nil, x402.NewSettleError(
				settleResponse.ErrorReason,
				settleResponse.Payer,
				network,
				transaction,
				fmt.Sprintf("facilitator returned %d", resp.StatusCode),
			)
		}
		return nil, fmt.Errorf("facilitator settle failed (%d): %s", resp.StatusCode, string(responseBody))
	}

	return parseSettleSuccessResponse(responseBody)
}
