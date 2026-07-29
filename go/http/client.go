package http

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/types"
)

// ============================================================================
// x402HTTPClient - HTTP-aware payment client
// ============================================================================

// x402HTTPClient wraps x402Client with HTTP-specific payment handling
type x402HTTPClient struct {
	client               *x402.X402Client
	paymentRequiredHooks []PaymentRequiredHook
}

// Newx402HTTPClient creates a new HTTP-aware x402 client
func Newx402HTTPClient(client *x402.X402Client) *x402HTTPClient {
	return &x402HTTPClient{
		client: client,
	}
}

// PaymentRequiredHookResult contains headers for an auth-style retry.
type PaymentRequiredHookResult struct {
	Headers map[string]string
}

// PaymentRequiredHook can respond to a 402 PaymentRequired before payment payload creation.
type PaymentRequiredHook func(ctx context.Context, paymentRequired types.PaymentRequired) (*PaymentRequiredHookResult, error)

// ClientExtensionPaymentRequiredHookProvider lets registered client extensions
// expose HTTP auth-style retry hooks.
type ClientExtensionPaymentRequiredHookProvider interface {
	PaymentRequiredHook() PaymentRequiredHook
}

// OnPaymentRequired registers a hook that may retry a protected request with additional headers.
func (c *x402HTTPClient) OnPaymentRequired(hook PaymentRequiredHook) *x402HTTPClient {
	if hook != nil {
		c.paymentRequiredHooks = append(c.paymentRequiredHooks, hook)
	}
	return c
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

// WrapHTTPClientWithPayment returns a new *http.Client whose Transport is wrapped
// with x402 payment handling. The input client is NEVER mutated — its Transport,
// Timeout, Jar and CheckRedirect are copied into a fresh *http.Client. Passing
// http.DefaultClient is safe; the returned client is independent and the global
// default remains untouched.
func WrapHTTPClientWithPayment(client *http.Client, x402Client *x402HTTPClient) *http.Client {
	if client == nil {
		client = http.DefaultClient
	}

	originalTransport := client.Transport
	if originalTransport == nil {
		originalTransport = http.DefaultTransport
	}

	wrapped := &http.Client{
		Transport: &PaymentRoundTripper{
			Transport:  originalTransport,
			x402Client: x402Client,
			retryCount: &sync.Map{},
		},
		CheckRedirect: client.CheckRedirect,
		Jar:           client.Jar,
		Timeout:       client.Timeout,
	}

	return wrapped
}

// PaymentRoundTripper implements http.RoundTripper with x402 payment handling
type PaymentRoundTripper struct {
	Transport  http.RoundTripper
	x402Client *x402HTTPClient
	retryCount *sync.Map // Track retry count per request to prevent infinite loops
}

// RoundTrip implements http.RoundTripper with V1/V2 version detection.
//
// V2 flow includes scheme-aware reconciliation: after the payment retry the
// chosen scheme's PaymentResponseHandler (if implemented) and any user-registered
// OnPaymentResponse hooks fire automatically. On a corrective 402 + Recovered=true,
// the transport rebuilds a fresh payload and retries one more time, mirroring the
// TS @x402/fetch wrapper's recovery behavior. User code never has to call
// ProcessSettleResponse manually.
func (t *PaymentRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	// Get or initialize retry count for this request
	requestID := fmt.Sprintf("%p", req)
	count, _ := t.retryCount.LoadOrStore(requestID, 0)
	retries := count.(int)
	defer t.retryCount.Delete(requestID)

	// Prevent infinite retry loops
	if retries > 1 {
		return nil, fmt.Errorf("payment retry limit exceeded")
	}

	preparedReq, err := prepareRequestBody(req)
	if err != nil {
		return nil, err
	}
	req = preparedReq

	// Make initial request
	resp, err := t.Transport.RoundTrip(req)
	if err != nil {
		return nil, err
	}

	// If not 402, return as-is
	if resp.StatusCode != http.StatusPaymentRequired {
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
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	// Detect version from response
	version, err := detectPaymentRequiredVersion(headers, body)
	if err != nil {
		return nil, fmt.Errorf("failed to detect payment version: %w", err)
	}

	//nolint:contextcheck // Intentionally using request's context for payment flow
	ctx := req.Context()
	if ctx == nil {
		ctx = context.Background()
	}

	// V1: simple build + retry, no hook dispatch (V1 schemes don't expose the hook).
	if version == 1 {
		payloadBytes, err := t.handleV1Payment(ctx, body)
		if err != nil {
			return nil, err
		}
		return t.sendPaymentRetry(req, ctx, payloadBytes)
	}

	if authResp, authHeaders, authBody, ok, err := t.tryPaymentRequiredHooks(req, ctx, headers, body); err != nil {
		return nil, err
	} else if ok {
		if authResp.StatusCode != http.StatusPaymentRequired {
			return authResp, nil
		}
		headers = authHeaders
		body = authBody
	}

	// V2: rich build so we can fire OnPaymentResponse with the right payload + requirements.
	build, err := t.buildV2Payment(ctx, headers, body)
	if err != nil {
		return nil, err
	}

	newResp, err := t.sendPaymentRetry(req, ctx, build.payloadBytes)
	if err != nil {
		return nil, err
	}

	// Dispatch OnPaymentResponse and, on corrective 402 with Recovered=true,
	// retry once more with a freshly built payload (mirrors @x402/fetch recovery).
	recovered, err := t.dispatchPaymentResponseHooks(ctx, build, newResp)
	if err != nil {
		return nil, err
	}
	if !recovered || newResp.StatusCode != http.StatusPaymentRequired {
		return newResp, nil
	}

	// Recovery succeeded: rebuild payload from refreshed session state and retry.
	freshPayload, err := t.x402Client.client.CreatePaymentPayload(
		ctx,
		build.requirements,
		build.paymentRequired.Resource,
		build.paymentRequired.Extensions,
	)
	if err != nil {
		return newResp, nil
	}
	freshBytes, err := json.Marshal(freshPayload)
	if err != nil {
		return newResp, nil
	}

	// Drain the corrective 402 body so connection can be reused.
	_, _ = io.Copy(io.Discard, newResp.Body)
	newResp.Body.Close()

	correctiveResp, err := t.sendPaymentRetry(req, ctx, freshBytes)
	if err != nil {
		return nil, err
	}

	// Fire hooks on the corrective response too — but no further recovery, to
	// prevent loops. Mirrors @x402/fetch which bounds recovery to one retry.
	correctiveBuild := *build
	correctiveBuild.paymentPayload = freshPayload
	correctiveBuild.payloadBytes = freshBytes
	if _, err := t.dispatchPaymentResponseHooks(ctx, &correctiveBuild, correctiveResp); err != nil {
		return correctiveResp, nil
	}
	return correctiveResp, nil
}

func prepareRequestBody(req *http.Request) (*http.Request, error) {
	if req.Body == nil || req.Body == http.NoBody || req.GetBody != nil {
		return req, nil
	}

	var closeErr error
	var closeOnce sync.Once
	closeBody := func() {
		closeOnce.Do(func() {
			closeErr = req.Body.Close()
		})
	}

	stopClose := context.AfterFunc(req.Context(), closeBody)
	body, readErr := io.ReadAll(req.Body)
	stopClose()
	closeBody()

	if err := errors.Join(context.Cause(req.Context()), readErr, closeErr); err != nil {
		return nil, fmt.Errorf("failed to buffer request body: %w", err)
	}

	preparedReq := req.Clone(req.Context())
	preparedReq.Body = io.NopCloser(bytes.NewReader(body))
	preparedReq.GetBody = func() (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(body)), nil
	}
	return preparedReq, nil
}

func (t *PaymentRoundTripper) tryPaymentRequiredHooks(
	req *http.Request,
	ctx context.Context,
	headers map[string]string,
	body []byte,
) (*http.Response, map[string]string, []byte, bool, error) {
	if t.x402Client == nil {
		return nil, headers, body, false, nil
	}

	paymentRequired, err := decodeV2PaymentRequired(headers, body)
	if err != nil {
		return nil, headers, body, false, err
	}

	for _, hook := range t.x402Client.getPaymentRequiredHooks(paymentRequired) {
		result, err := hook(ctx, paymentRequired)
		if err != nil {
			return nil, headers, body, false, err
		}
		if result == nil || len(result.Headers) == 0 {
			continue
		}

		authResp, err := t.sendHeaderRetry(req, ctx, result.Headers)
		if err != nil {
			return nil, headers, body, false, err
		}
		if authResp.StatusCode != http.StatusPaymentRequired {
			return authResp, headers, body, true, nil
		}

		authHeaders := responseHeaders(authResp)
		authBody, err := io.ReadAll(authResp.Body)
		authResp.Body.Close()
		if err != nil {
			return nil, headers, body, false, fmt.Errorf("failed to read auth retry body: %w", err)
		}
		return authResp, authHeaders, authBody, true, nil
	}

	return nil, headers, body, false, nil
}

func (c *x402HTTPClient) getPaymentRequiredHooks(paymentRequired types.PaymentRequired) []PaymentRequiredHook {
	hooks := append([]PaymentRequiredHook(nil), c.paymentRequiredHooks...)
	if c.client == nil || len(paymentRequired.Extensions) == 0 {
		return hooks
	}

	for _, extension := range c.client.GetExtensions() {
		if _, declared := paymentRequired.Extensions[extension.Key()]; !declared {
			continue
		}
		provider, ok := extension.(ClientExtensionPaymentRequiredHookProvider)
		if !ok {
			continue
		}
		if hook := provider.PaymentRequiredHook(); hook != nil {
			hooks = append(hooks, hook)
		}
	}
	return hooks
}

func (t *PaymentRoundTripper) sendHeaderRetry(
	req *http.Request,
	ctx context.Context,
	headers map[string]string,
) (*http.Response, error) {
	retryReq := req.Clone(ctx)
	for k, v := range headers {
		retryReq.Header.Set(k, v)
	}

	if req.GetBody != nil {
		body, err := req.GetBody()
		if err != nil {
			return nil, fmt.Errorf("failed to get body for header retry: %w", err)
		}
		retryReq.Body = body
	}

	return t.Transport.RoundTrip(retryReq)
}

func responseHeaders(resp *http.Response) map[string]string {
	headers := make(map[string]string)
	for k, v := range resp.Header {
		if len(v) > 0 {
			headers[k] = v[0]
		}
	}
	return headers
}

// sendPaymentRetry clones the original request, attaches PAYMENT-SIGNATURE / X-PAYMENT
// headers built from the given payload bytes, replenishes the body, and dispatches.
func (t *PaymentRoundTripper) sendPaymentRetry(
	req *http.Request,
	ctx context.Context,
	payloadBytes []byte,
) (*http.Response, error) {
	paymentHeaders, err := t.x402Client.EncodePaymentSignatureHeader(payloadBytes)
	if err != nil {
		return nil, fmt.Errorf("failed to encode payment header: %w", err)
	}

	paymentReq := req.Clone(ctx)
	for k, v := range paymentHeaders {
		paymentReq.Header.Set(k, v)
	}

	if req.GetBody != nil {
		body, err := req.GetBody()
		if err != nil {
			return nil, fmt.Errorf("failed to get body for payment retry: %w", err)
		}
		paymentReq.Body = body
	}

	return t.Transport.RoundTrip(paymentReq)
}

// dispatchPaymentResponseHooks decodes PAYMENT-RESPONSE / PAYMENT-REQUIRED on the
// retry response and fires the scheme + user-registered OnPaymentResponse hooks
// via x402Client.HandlePaymentResponse. Returns whether the hooks signaled recovery.
//
// Header parse errors are non-fatal: hooks simply don't fire when the server
// omits the header. Hook errors propagate so the caller can surface them.
func (t *PaymentRoundTripper) dispatchPaymentResponseHooks(
	ctx context.Context,
	build *v2PaymentBuild,
	resp *http.Response,
) (bool, error) {
	prCtx := x402.PaymentResponseContext{
		PaymentPayload: build.paymentPayload,
		Requirements:   build.requirements,
	}

	if settleHeader := resp.Header.Get("PAYMENT-RESPONSE"); settleHeader != "" {
		if settle, err := decodePaymentResponseHeader(settleHeader); err == nil {
			prCtx.SettleResponse = settle
		}
	}
	if prCtx.SettleResponse == nil && resp.StatusCode == http.StatusPaymentRequired {
		if requiredHeader := resp.Header.Get("PAYMENT-REQUIRED"); requiredHeader != "" {
			if pr, err := decodePaymentRequiredHeader(requiredHeader); err == nil {
				prCtx.PaymentRequired = &pr
			}
		}
	}

	if prCtx.SettleResponse == nil && prCtx.PaymentRequired == nil {
		return false, nil
	}

	result, err := t.x402Client.client.HandlePaymentResponse(ctx, prCtx)
	if err != nil {
		return false, err
	}
	return result.Recovered, nil
}

// v2PaymentBuild captures all the V2 state PaymentRoundTripper needs across the
// payment retry: the parsed PaymentRequired (so corrective recovery can rebuild),
// the chosen requirements (for hook dispatch), the resulting payload, and its
// marshaled bytes (to put in PAYMENT-SIGNATURE).
type v2PaymentBuild struct {
	paymentRequired types.PaymentRequired
	requirements    types.PaymentRequirements
	paymentPayload  types.PaymentPayload
	payloadBytes    []byte
}

func (t *PaymentRoundTripper) buildV2Payment(
	ctx context.Context,
	headers map[string]string,
	body []byte,
) (*v2PaymentBuild, error) {
	paymentRequiredV2, err := decodeV2PaymentRequired(headers, body)
	if err != nil {
		return nil, err
	}

	selected, err := t.x402Client.client.SelectPaymentRequirements(paymentRequiredV2.Accepts)
	if err != nil {
		return nil, fmt.Errorf("cannot fulfill V2 payment requirements: %w", err)
	}

	payload, err := t.x402Client.client.CreatePaymentPayload(
		ctx,
		selected,
		paymentRequiredV2.Resource,
		paymentRequiredV2.Extensions,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create V2 payment: %w", err)
	}

	bytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal V2 payment: %w", err)
	}

	return &v2PaymentBuild{
		paymentRequired: paymentRequiredV2,
		requirements:    selected,
		paymentPayload:  payload,
		payloadBytes:    bytes,
	}, nil
}

func decodeV2PaymentRequired(headers map[string]string, body []byte) (types.PaymentRequired, error) {
	var paymentRequiredV2 types.PaymentRequired

	normalizedHeaders := make(map[string]string)
	for k, v := range headers {
		normalizedHeaders[strings.ToUpper(k)] = v
	}

	if header, exists := normalizedHeaders["PAYMENT-REQUIRED"]; exists {
		decoded, err := decodePaymentRequiredHeader(header)
		if err != nil {
			return types.PaymentRequired{}, fmt.Errorf("failed to decode V2 header: %w", err)
		}
		return decoded, nil
	}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &paymentRequiredV2); err != nil {
			return types.PaymentRequired{}, fmt.Errorf("failed to parse V2 payment required: %w", err)
		}
		return paymentRequiredV2, nil
	}
	return types.PaymentRequired{}, fmt.Errorf("no V2 payment required information found")
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
	response = withTypedChannelStateExtra(response)
	data, err := json.Marshal(response)
	if err != nil {
		return "", fmt.Errorf("failed to marshal settle response: %w", err)
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

type paymentResponseChannelStateExtra struct {
	ChannelId               string      `json:"channelId,omitempty"`
	Balance                 string      `json:"balance,omitempty"`
	TotalClaimed            string      `json:"totalClaimed,omitempty"`
	WithdrawRequestedAt     interface{} `json:"withdrawRequestedAt,omitempty"`
	RefundNonce             string      `json:"refundNonce,omitempty"`
	ChargedCumulativeAmount string      `json:"chargedCumulativeAmount,omitempty"`
}

func withTypedChannelStateExtra(response x402.SettleResponse) x402.SettleResponse {
	raw, ok := response.Extra["channelState"].(map[string]interface{})
	if !ok {
		return response
	}

	extra := make(map[string]interface{}, len(response.Extra))
	for key, value := range response.Extra {
		extra[key] = value
	}
	extra["channelState"] = paymentResponseChannelStateExtra{
		ChannelId:               stringField(raw, "channelId"),
		Balance:                 stringField(raw, "balance"),
		TotalClaimed:            stringField(raw, "totalClaimed"),
		WithdrawRequestedAt:     raw["withdrawRequestedAt"],
		RefundNonce:             stringField(raw, "refundNonce"),
		ChargedCumulativeAmount: stringField(raw, "chargedCumulativeAmount"),
	}
	response.Extra = extra
	return response
}

func stringField(data map[string]interface{}, key string) string {
	value, _ := data[key].(string)
	return value
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
