package http

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/types"
)

// ============================================================================
// x402HTTPClient - HTTP-aware payment client
// ============================================================================

// x402HTTPClient wraps x402Client with HTTP-specific payment handling
type x402HTTPClient struct {
	client *x402.X402Client
}

// Newx402HTTPClient creates a new HTTP-aware x402 client
func Newx402HTTPClient(client *x402.X402Client) *x402HTTPClient {
	return &x402HTTPClient{
		client: client,
	}
}

// ============================================================================
// Header Encoding/Decoding
// ============================================================================

// EncodePaymentSignatureHeader encodes a payment payload into HTTP headers
// Returns appropriate headers based on protocol version
// Works with raw payload bytes
func (c *x402HTTPClient) EncodePaymentSignatureHeader(payloadBytes []byte) (map[string]string, error) {
	// Detect version from bytes
	version, err := types.DetectVersion(payloadBytes)
	if err != nil {
		return nil, fmt.Errorf("failed to detect version: %w", err)
	}

	// Base64 encode the payload bytes
	encoded := base64.StdEncoding.EncodeToString(payloadBytes)

	switch version {
	case 2:
		return map[string]string{
			"PAYMENT-SIGNATURE": encoded,
		}, nil
	case 1:
		return map[string]string{
			"X-PAYMENT": encoded,
		}, nil
	default:
		return nil, fmt.Errorf("unsupported x402 version: %d", version)
	}
}

// GetPaymentRequiredResponse extracts payment requirements from HTTP response
// Handles both v1 (body) and v2 (header) formats
func (c *x402HTTPClient) GetPaymentRequiredResponse(headers map[string]string, body []byte) (x402.PaymentRequired, error) {
	// Normalize headers to uppercase
	normalizedHeaders := make(map[string]string)
	for k, v := range headers {
		normalizedHeaders[strings.ToUpper(k)] = v
	}

	// Check v2 header first
	if header, exists := normalizedHeaders["PAYMENT-REQUIRED"]; exists {
		return decodePaymentRequiredHeader(header)
	}

	// Fall back to v1 body format
	if len(body) > 0 {
		var required x402.PaymentRequired
		if err := json.Unmarshal(body, &required); err == nil {
			if required.X402Version == 1 {
				return required, nil
			}
		}
	}

	return x402.PaymentRequired{}, fmt.Errorf("no payment required information found in response")
}

// GetPaymentSettleResponse extracts settlement response from HTTP headers
func (c *x402HTTPClient) GetPaymentSettleResponse(headers map[string]string) (*x402.SettleResponse, error) {
	// Normalize headers to uppercase
	normalizedHeaders := make(map[string]string)
	for k, v := range headers {
		normalizedHeaders[strings.ToUpper(k)] = v
	}

	// Check v2 header
	if header, exists := normalizedHeaders["PAYMENT-RESPONSE"]; exists {
		return decodePaymentResponseHeader(header)
	}

	// Check v1 header
	if header, exists := normalizedHeaders["X-PAYMENT-RESPONSE"]; exists {
		return decodePaymentResponseHeader(header)
	}

	return nil, fmt.Errorf("payment response header not found")
}

// ============================================================================
// HTTP Client Wrapper
// ============================================================================

// WrapHTTPClientWithPayment wraps a standard HTTP client with x402 payment handling
// This allows transparent payment handling for HTTP requests
func WrapHTTPClientWithPayment(client *http.Client, x402Client *x402HTTPClient) *http.Client {
	if client == nil {
		client = http.DefaultClient
	}

	// Wrap the transport with payment handling
	originalTransport := client.Transport
	if originalTransport == nil {
		originalTransport = http.DefaultTransport
	}

	client.Transport = &PaymentRoundTripper{
		Transport:  originalTransport,
		x402Client: x402Client,
		retryCount: &sync.Map{},
	}

	return client
}

// PaymentRoundTripper implements http.RoundTripper with x402 payment handling
type PaymentRoundTripper struct {
	Transport  http.RoundTripper
	x402Client *x402HTTPClient
	retryCount *sync.Map // Track retry count per request to prevent infinite loops
}

// RoundTrip implements http.RoundTripper with V1/V2 version detection
func (t *PaymentRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	// Get or initialize retry count for this request
	requestID := fmt.Sprintf("%p", req)
	count, _ := t.retryCount.LoadOrStore(requestID, 0)
	retries := count.(int)

	// Prevent infinite retry loops
	if retries > 1 {
		t.retryCount.Delete(requestID)
		return nil, fmt.Errorf("payment retry limit exceeded")
	}

	// Make initial request
	resp, err := t.Transport.RoundTrip(req)
	if err != nil {
		t.retryCount.Delete(requestID)
		return nil, err
	}

	// If not 402, return as-is
	if resp.StatusCode != http.StatusPaymentRequired {
		t.retryCount.Delete(requestID)
		return resp, nil
	}

	// Increment retry count
	t.retryCount.Store(requestID, retries+1)

	// Extract headers
	headers := make(map[string]string)
	for k, v := range resp.Header {
		if len(v) > 0 {
			headers[k] = v[0]
		}
	}

	// Read response body for V1 support
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.retryCount.Delete(requestID)
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	// Detect version from response
	version, err := detectPaymentRequiredVersion(headers, body)
	if err != nil {
		t.retryCount.Delete(requestID)
		return nil, fmt.Errorf("failed to detect payment version: %w", err)
	}

	//nolint:contextcheck // Intentionally using request's context for payment flow
	ctx := req.Context()
	if ctx == nil {
		ctx = context.Background()
	}

	// Fork based on version
	var payloadBytes []byte
	if version == 1 {
		// V1 flow: body-based PaymentRequired, V1 types
		payloadBytes, err = t.handleV1Payment(ctx, body)
		if err != nil {
			t.retryCount.Delete(requestID)
			return nil, err
		}
	} else {
		// V2 flow: header-based PaymentRequired, V2 types
		payloadBytes, err = t.handleV2Payment(ctx, headers, body)
		if err != nil {
			t.retryCount.Delete(requestID)
			return nil, err
		}
	}

	// Encode payment header (works for both V1 and V2)
	paymentHeaders, err := t.x402Client.EncodePaymentSignatureHeader(payloadBytes)
	if err != nil {
		t.retryCount.Delete(requestID)
		return nil, fmt.Errorf("failed to encode payment header: %w", err)
	}

	// Create new request with payment header
	paymentReq := req.Clone(ctx)
	for k, v := range paymentHeaders {
		paymentReq.Header.Set(k, v)
	}

	// Replenish body for retry if possible
	if req.GetBody != nil {
		body, err := req.GetBody()
		if err != nil {
			t.retryCount.Delete(requestID)
			return nil, fmt.Errorf("failed to get body for payment retry: %w", err)
		}
		paymentReq.Body = body
	}

	// Retry with payment
	newResp, err := t.Transport.RoundTrip(paymentReq)
	t.retryCount.Delete(requestID)

	return newResp, err
}

// handleV1Payment processes V1 PaymentRequired and creates V1 payload
func (t *PaymentRoundTripper) handleV1Payment(ctx context.Context, body []byte) ([]byte, error) {
	// Parse V1 PaymentRequired from body
	var paymentRequiredV1 types.PaymentRequiredV1
	if err := json.Unmarshal(body, &paymentRequiredV1); err != nil {
		return nil, fmt.Errorf("failed to parse V1 payment required: %w", err)
	}

	// Select V1 requirements
	selectedV1, err := t.x402Client.client.SelectPaymentRequirementsV1(paymentRequiredV1.Accepts)
	if err != nil {
		return nil, fmt.Errorf("cannot fulfill V1 payment requirements: %w", err)
	}

	// Create V1 payment payload
	payloadV1, err := t.x402Client.client.CreatePaymentPayloadV1(ctx, selectedV1)
	if err != nil {
		return nil, fmt.Errorf("failed to create V1 payment: %w", err)
	}

	// Marshal to bytes
	return json.Marshal(payloadV1)
}

// handleV2Payment processes V2 PaymentRequired and creates V2 payload
func (t *PaymentRoundTripper) handleV2Payment(ctx context.Context, headers map[string]string, body []byte) ([]byte, error) {
	// Parse V2 PaymentRequired (from header or body)
	var paymentRequiredV2 types.PaymentRequired

	// Normalize headers to uppercase
	normalizedHeaders := make(map[string]string)
	for k, v := range headers {
		normalizedHeaders[strings.ToUpper(k)] = v
	}

	// Try header first (V2 standard)
	if header, exists := normalizedHeaders["PAYMENT-REQUIRED"]; exists {
		decoded, err := decodePaymentRequiredHeader(header)
		if err != nil {
			return nil, fmt.Errorf("failed to decode V2 header: %w", err)
		}
		paymentRequiredV2 = decoded
	} else if len(body) > 0 {
		// Fall back to body (some V2 servers might use body)
		if err := json.Unmarshal(body, &paymentRequiredV2); err != nil {
			return nil, fmt.Errorf("failed to parse V2 payment required: %w", err)
		}
	} else {
		return nil, fmt.Errorf("no V2 payment required information found")
	}

	// Select V2 requirements
	selectedV2, err := t.x402Client.client.SelectPaymentRequirements(paymentRequiredV2.Accepts)
	if err != nil {
		return nil, fmt.Errorf("cannot fulfill V2 payment requirements: %w", err)
	}

	// Create V2 payment payload
	payloadV2, err := t.x402Client.client.CreatePaymentPayload(
		ctx,
		selectedV2,
		paymentRequiredV2.Resource,
		paymentRequiredV2.Extensions,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create V2 payment: %w", err)
	}

	// Marshal to bytes
	return json.Marshal(payloadV2)
}

// detectPaymentRequiredVersion detects protocol version from HTTP response
func detectPaymentRequiredVersion(headers map[string]string, body []byte) (int, error) {
	// Normalize headers
	normalizedHeaders := make(map[string]string)
	for k, v := range headers {
		normalizedHeaders[strings.ToUpper(k)] = v
	}

	// V2 uses PAYMENT-REQUIRED header
	if _, exists := normalizedHeaders["PAYMENT-REQUIRED"]; exists {
		return 2, nil
	}

	// V1 uses body with x402Version field
	if len(body) > 0 {
		var versionCheck struct {
			X402Version int `json:"x402Version"`
		}
		if err := json.Unmarshal(body, &versionCheck); err == nil {
			if versionCheck.X402Version == 1 {
				return 1, nil
			}
			if versionCheck.X402Version == 2 {
				return 2, nil
			}
		}
	}

	return 0, fmt.Errorf("could not detect x402 version from response")
}

// ============================================================================
// Convenience Methods
// ============================================================================

// DoWithPayment performs an HTTP request with automatic payment handling
func (c *x402HTTPClient) DoWithPayment(ctx context.Context, req *http.Request) (*http.Response, error) {
	// Create a client with our transport
	client := &http.Client{
		Transport: &PaymentRoundTripper{
			Transport:  http.DefaultTransport,
			x402Client: c,
			retryCount: &sync.Map{},
		},
	}

	return client.Do(req.WithContext(ctx))
}

// GetWithPayment performs a GET request with automatic payment handling
func (c *x402HTTPClient) GetWithPayment(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	return c.DoWithPayment(ctx, req)
}

// PostWithPayment performs a POST request with automatic payment handling
func (c *x402HTTPClient) PostWithPayment(ctx context.Context, url string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", url, body)
	if err != nil {
		return nil, err
	}
	return c.DoWithPayment(ctx, req)
}

// ============================================================================
// Header Encoding/Decoding Functions
// ============================================================================

// encodePaymentRequiredHeader encodes payment requirements as base64
func encodePaymentRequiredHeader(required x402.PaymentRequired) (string, error) {
	data, err := json.Marshal(required)
	if err != nil {
		return "", fmt.Errorf("failed to marshal payment required: %w", err)
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

// decodePaymentRequiredHeader decodes a base64 payment required header
func decodePaymentRequiredHeader(header string) (x402.PaymentRequired, error) {
	data, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		return x402.PaymentRequired{}, fmt.Errorf("invalid base64 encoding: %w", err)
	}

	var required x402.PaymentRequired
	if err := json.Unmarshal(data, &required); err != nil {
		return x402.PaymentRequired{}, fmt.Errorf("invalid payment required JSON: %w", err)
	}

	return required, nil
}

// encodePaymentResponseHeader encodes a settlement response as base64
func encodePaymentResponseHeader(response x402.SettleResponse) (string, error) {
	data, err := json.Marshal(response)
	if err != nil {
		return "", fmt.Errorf("failed to marshal settle response: %w", err)
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

// decodePaymentResponseHeader decodes a base64 payment response header
func decodePaymentResponseHeader(header string) (*x402.SettleResponse, error) {
	data, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		return nil, fmt.Errorf("invalid base64 encoding: %w", err)
	}

	var response x402.SettleResponse
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, fmt.Errorf("invalid settle response JSON: %w", err)
	}

	return &response, nil
}
