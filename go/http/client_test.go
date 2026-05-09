package http

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/types"
)

func TestNewx402HTTPClient(t *testing.T) {
	x402Client := x402.Newx402Client()
	client := Newx402HTTPClient(x402Client)
	if client == nil {
		t.Fatal("Expected client to be created")
	}
	if client.client == nil {
		t.Fatal("Expected composed x402Client")
	}
}

func TestEncodePaymentSignatureHeader(t *testing.T) {
	client := Newx402HTTPClient(x402.Newx402Client())

	tests := []struct {
		name     string
		payload  x402.PaymentPayload
		expected string
	}{
		{
			name: "v2 payload",
			payload: x402.PaymentPayload{
				X402Version: 2,
				Accepted: x402.PaymentRequirements{
					Scheme:  "exact",
					Network: "eip155:1",
				},
				Payload: map[string]interface{}{"sig": "test"},
			},
			expected: "PAYMENT-SIGNATURE",
		},
		{
			name: "v1 payload",
			payload: x402.PaymentPayload{
				X402Version: 1,
				Accepted: x402.PaymentRequirements{
					Scheme:  "exact",
					Network: "eip155:1",
				},
				Payload: map[string]interface{}{"sig": "test"},
			},
			expected: "X-PAYMENT",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Marshal payload to bytes
			payloadBytes, err := json.Marshal(tt.payload)
			if err != nil {
				t.Fatalf("Failed to marshal payload: %v", err)
			}

			headers, err := client.EncodePaymentSignatureHeader(payloadBytes)
			if err != nil {
				t.Fatalf("Failed to encode payment signature header: %v", err)
			}
			if _, exists := headers[tt.expected]; !exists {
				t.Errorf("Expected header %s not found", tt.expected)
			}

			// Verify it's base64 encoded JSON
			encoded := headers[tt.expected]
			decoded, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				t.Fatalf("Failed to decode base64: %v", err)
			}

			var decodedPayload x402.PaymentPayload
			if err := json.Unmarshal(decoded, &decodedPayload); err != nil {
				t.Fatalf("Failed to unmarshal JSON: %v", err)
			}

			if decodedPayload.X402Version != tt.payload.X402Version {
				t.Errorf("Version mismatch: got %d, want %d", decodedPayload.X402Version, tt.payload.X402Version)
			}
		})
	}
}

func TestGetPaymentRequiredResponse(t *testing.T) {
	client := Newx402HTTPClient(x402.Newx402Client())

	// Test v2 header format
	requirements := x402.PaymentRequired{
		X402Version: 2,
		Error:       "Payment required",
		Accepts: []x402.PaymentRequirements{
			{
				Scheme:  "exact",
				Network: "eip155:1",
				Asset:   "USDC",
				Amount:  "1000000",
				PayTo:   "0xrecipient",
			},
		},
	}

	reqJSON, _ := json.Marshal(requirements)
	encoded := base64.StdEncoding.EncodeToString(reqJSON)

	headers := map[string]string{
		"PAYMENT-REQUIRED": encoded,
	}

	result, err := client.GetPaymentRequiredResponse(headers, nil)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if result.X402Version != 2 {
		t.Errorf("Expected version 2, got %d", result.X402Version)
	}
	if len(result.Accepts) != 1 {
		t.Errorf("Expected 1 requirement, got %d", len(result.Accepts))
	}

	// Test v1 body format
	v1Requirements := x402.PaymentRequired{
		X402Version: 1,
		Error:       "Payment required",
		Accepts: []x402.PaymentRequirements{
			{
				Scheme:  "exact",
				Network: "eip155:1",
				Asset:   "USDC",
				Amount:  "1000000",
				PayTo:   "0xrecipient",
			},
		},
	}

	v1Body, _ := json.Marshal(v1Requirements)

	result, err = client.GetPaymentRequiredResponse(map[string]string{}, v1Body)
	if err != nil {
		t.Fatalf("Unexpected error for v1: %v", err)
	}

	if result.X402Version != 1 {
		t.Errorf("Expected version 1, got %d", result.X402Version)
	}

	// Test no payment required found
	_, err = client.GetPaymentRequiredResponse(map[string]string{}, nil)
	if err == nil {
		t.Error("Expected error when no payment required found")
	}
}

func TestGetPaymentSettleResponse(t *testing.T) {
	client := Newx402HTTPClient(x402.Newx402Client())

	settleResponse := x402.SettleResponse{
		Success:     true,
		Transaction: "0xtx",
		Payer:       "0xpayer",
		Network:     "eip155:1",
	}

	respJSON, _ := json.Marshal(settleResponse)
	encoded := base64.StdEncoding.EncodeToString(respJSON)

	// Test v2 header
	headers := map[string]string{
		"PAYMENT-RESPONSE": encoded,
	}

	result, err := client.GetPaymentSettleResponse(headers)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !result.Success {
		t.Error("Expected success")
	}
	if result.Transaction != "0xtx" {
		t.Errorf("Expected transaction 0xtx, got %s", result.Transaction)
	}

	// Test v1 header
	headers = map[string]string{
		"X-PAYMENT-RESPONSE": encoded,
	}

	result, err = client.GetPaymentSettleResponse(headers)
	if err != nil {
		t.Fatalf("Unexpected error for v1: %v", err)
	}

	if result.Payer != "0xpayer" {
		t.Errorf("Expected payer 0xpayer, got %s", result.Payer)
	}

	// Test no header found
	_, err = client.GetPaymentSettleResponse(map[string]string{})
	if err == nil {
		t.Error("Expected error when no payment response found")
	}
}

func TestEncodePaymentResponseHeader_ChannelStateOrder(t *testing.T) {
	encoded, err := encodePaymentResponseHeader(x402.SettleResponse{
		Success:     true,
		Payer:       "0xpayer",
		Transaction: "0xtx",
		Network:     "eip155:1",
		Amount:      "1000",
		Extra: map[string]interface{}{
			"channelState": map[string]interface{}{
				"balance":                 "5000",
				"channelId":               "0xchan",
				"chargedCumulativeAmount": "3000",
				"refundNonce":             "1",
				"totalClaimed":            "2000",
				"withdrawRequestedAt":     0,
			},
			"chargedAmount": "1000",
		},
	})
	if err != nil {
		t.Fatalf("encodePaymentResponseHeader: %v", err)
	}

	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	body := string(decoded)
	fields := []string{
		`"channelId":"0xchan"`,
		`"balance":"5000"`,
		`"totalClaimed":"2000"`,
		`"withdrawRequestedAt":0`,
		`"refundNonce":"1"`,
		`"chargedCumulativeAmount":"3000"`,
	}
	last := -1
	for _, field := range fields {
		idx := strings.Index(body, field)
		if idx == -1 {
			t.Fatalf("missing %s in %s", field, body)
		}
		if idx <= last {
			t.Fatalf("field %s out of order in %s", field, body)
		}
		last = idx
	}
}

func TestPaymentRoundTripper(t *testing.T) {
	// Create a test server that returns 402 first, then 200
	callCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++

		if callCount == 1 {
			// First call - return 402
			requirements := x402.PaymentRequired{
				X402Version: 2,
				Error:       "Payment required",
				Accepts: []x402.PaymentRequirements{
					{
						Scheme:  "mock",
						Network: "test:1",
						Asset:   "TEST",
						Amount:  "1000",
						PayTo:   "0xtest",
					},
				},
			}

			reqJSON, _ := json.Marshal(requirements)
			encoded := base64.StdEncoding.EncodeToString(reqJSON)

			w.Header().Set("PAYMENT-REQUIRED", encoded)
			w.WriteHeader(http.StatusPaymentRequired)
			_, _ = w.Write([]byte("Payment required"))
		} else {
			// Second call - check for payment header and return 200
			if r.Header.Get("PAYMENT-SIGNATURE") == "" {
				t.Error("Expected PAYMENT-SIGNATURE header on retry")
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("Success"))
		}
	}))
	defer server.Close()

	// Create mock scheme client
	mockClient := &mockSchemeClient{
		scheme: "mock",
	}

	// Create x402 client
	x402Client := x402.Newx402Client()
	x402Client.Register("test:1", mockClient)

	// Create HTTP client wrapper
	httpClient := WrapHTTPClientWithPayment(http.DefaultClient, Newx402HTTPClient(x402Client))

	// Make request
	ctx := context.Background()
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL, nil)
	resp, err := httpClient.Do(req)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected status 200, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	if string(body) != "Success" {
		t.Errorf("Expected body 'Success', got %s", string(body))
	}

	if callCount != 2 {
		t.Errorf("Expected 2 calls to server, got %d", callCount)
	}
}

func TestPaymentRoundTripperNoRetryOn200(t *testing.T) {
	// Server that always returns 200
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("Success"))
	}))
	defer server.Close()

	x402Client := Newx402HTTPClient(x402.Newx402Client())
	httpClient := WrapHTTPClientWithPayment(http.DefaultClient, x402Client)

	ctx := context.Background()
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL, nil)
	resp, err := httpClient.Do(req)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected status 200, got %d", resp.StatusCode)
	}
}

func TestDoWithPayment(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("Success"))
	}))
	defer server.Close()

	client := Newx402HTTPClient(x402.Newx402Client())
	ctx := context.Background()
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL, nil)

	resp, err := client.DoWithPayment(ctx, req)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected status 200, got %d", resp.StatusCode)
	}
}

func TestGetWithPayment(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Errorf("Expected GET, got %s", r.Method)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := Newx402HTTPClient(x402.Newx402Client())
	ctx := context.Background()

	resp, err := client.GetWithPayment(ctx, server.URL)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	defer resp.Body.Close()
}

func TestPostWithPayment(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("Expected POST, got %s", r.Method)
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != "test body" {
			t.Errorf("Expected 'test body', got %s", string(body))
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := Newx402HTTPClient(x402.Newx402Client())
	ctx := context.Background()

	resp, err := client.PostWithPayment(ctx, server.URL, strings.NewReader("test body"))
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	defer resp.Body.Close()
}

// Mock scheme client for testing
type mockSchemeClient struct {
	scheme string
}

func (m *mockSchemeClient) Scheme() string {
	return m.scheme
}

func (m *mockSchemeClient) CreatePaymentPayload(ctx context.Context, requirements types.PaymentRequirements) (types.PaymentPayload, error) {
	return types.PaymentPayload{
		X402Version: 2,
		Payload:     map[string]interface{}{"mock": "payload"},
	}, nil
}

// hookSchemeClient implements both SchemeNetworkClient and PaymentResponseHandler so we
// can drive the round-tripper's auto-dispatch path end-to-end.
type hookSchemeClient struct {
	scheme           string
	settleCalls      int
	correctiveCalls  int
	signalRecover    bool
	createPayloadCnt int
}

func (m *hookSchemeClient) Scheme() string { return m.scheme }

func (m *hookSchemeClient) CreatePaymentPayload(ctx context.Context, requirements types.PaymentRequirements) (types.PaymentPayload, error) {
	m.createPayloadCnt++
	return types.PaymentPayload{
		X402Version: 2,
		Payload:     map[string]interface{}{"voucher": m.createPayloadCnt},
	}, nil
}

func (m *hookSchemeClient) OnPaymentResponse(ctx context.Context, prCtx x402.PaymentResponseContext) (x402.PaymentResponseResult, error) {
	if prCtx.SettleResponse != nil {
		m.settleCalls++
		return x402.PaymentResponseResult{}, nil
	}
	if prCtx.PaymentRequired != nil {
		m.correctiveCalls++
		return x402.PaymentResponseResult{Recovered: m.signalRecover}, nil
	}
	return x402.PaymentResponseResult{}, nil
}

func paymentRequiredHeader(t *testing.T, accepts []types.PaymentRequirements) string {
	t.Helper()
	pr := types.PaymentRequired{X402Version: 2, Accepts: accepts}
	encoded, err := encodePaymentRequiredHeader(pr)
	if err != nil {
		t.Fatalf("encodePaymentRequired: %v", err)
	}
	return encoded
}

func paymentResponseHeader(t *testing.T, settle x402.SettleResponse) string {
	t.Helper()
	encoded, err := encodePaymentResponseHeader(settle)
	if err != nil {
		t.Fatalf("encodePaymentResponse: %v", err)
	}
	return encoded
}

// TestPaymentRoundTripper_DispatchesOnPaymentResponseOnSuccess verifies that a
// successful retry (200 + PAYMENT-RESPONSE) auto-fires the scheme's hook. User
// code should not need to call ProcessSettleResponse manually.
func TestPaymentRoundTripper_DispatchesOnPaymentResponseOnSuccess(t *testing.T) {
	scheme := &hookSchemeClient{scheme: "test-scheme"}
	x402Client := x402.Newx402Client()
	x402Client.Register("eip155:1", scheme)

	accepts := []types.PaymentRequirements{{
		Scheme:  "test-scheme",
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "100",
		PayTo:   "0xrecipient",
	}}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("PAYMENT-SIGNATURE") == "" {
			w.Header().Set("PAYMENT-REQUIRED", paymentRequiredHeader(t, accepts))
			w.WriteHeader(http.StatusPaymentRequired)
			return
		}
		w.Header().Set("PAYMENT-RESPONSE", paymentResponseHeader(t, x402.SettleResponse{
			Success:     true,
			Transaction: "0xtx",
			Network:     "eip155:1",
			Extra:       map[string]interface{}{"channelId": "0xabc", "balance": "999"},
		}))
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	httpClient := WrapHTTPClientWithPayment(&http.Client{}, Newx402HTTPClient(x402Client))
	req, _ := http.NewRequestWithContext(context.Background(), "GET", server.URL, nil)
	resp, err := httpClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if scheme.settleCalls != 1 {
		t.Fatalf("expected OnPaymentResponse(settle) once, got %d", scheme.settleCalls)
	}
	if scheme.correctiveCalls != 0 {
		t.Fatalf("did not expect corrective dispatch, got %d", scheme.correctiveCalls)
	}
}

// TestPaymentRoundTripper_RetriesOnceWhenHookSignalsRecovered verifies the
// corrective-recovery path: scheme returns Recovered=true on a 402 + PAYMENT-REQUIRED,
// transport rebuilds the payload and retries one more time.
func TestPaymentRoundTripper_RetriesOnceWhenHookSignalsRecovered(t *testing.T) {
	scheme := &hookSchemeClient{scheme: "test-scheme", signalRecover: true}
	x402Client := x402.Newx402Client()
	x402Client.Register("eip155:1", scheme)

	accepts := []types.PaymentRequirements{{
		Scheme:  "test-scheme",
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "100",
		PayTo:   "0xrecipient",
	}}

	var attempt int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempt++
		paymentSig := r.Header.Get("PAYMENT-SIGNATURE")
		switch {
		case paymentSig == "":
			// Initial 402 — no payment yet.
			w.Header().Set("PAYMENT-REQUIRED", paymentRequiredHeader(t, accepts))
			w.WriteHeader(http.StatusPaymentRequired)
		case attempt == 2:
			// First paid attempt — corrective 402 carrying PAYMENT-REQUIRED.
			w.Header().Set("PAYMENT-REQUIRED", paymentRequiredHeader(t, accepts))
			w.WriteHeader(http.StatusPaymentRequired)
		default:
			// Recovery retry — succeed.
			w.Header().Set("PAYMENT-RESPONSE", paymentResponseHeader(t, x402.SettleResponse{
				Success:     true,
				Transaction: "0xtx",
				Network:     "eip155:1",
			}))
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()

	httpClient := WrapHTTPClientWithPayment(&http.Client{}, Newx402HTTPClient(x402Client))
	req, _ := http.NewRequestWithContext(context.Background(), "GET", server.URL, nil)
	resp, err := httpClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected final 200, got %d", resp.StatusCode)
	}
	if scheme.correctiveCalls != 1 {
		t.Fatalf("expected one corrective dispatch, got %d", scheme.correctiveCalls)
	}
	if scheme.settleCalls != 1 {
		t.Fatalf("expected one settle dispatch on recovery retry, got %d", scheme.settleCalls)
	}
	if scheme.createPayloadCnt < 2 {
		t.Fatalf("expected payload to be rebuilt at least twice (retry + recovery), got %d", scheme.createPayloadCnt)
	}
	if attempt != 3 {
		t.Fatalf("expected exactly 3 server attempts (initial + retry + recovery), got %d", attempt)
	}
}

// TestPaymentRoundTripper_NoRecoveryWhenHookDeclines ensures that a corrective 402
// without recovery propagates as-is — no extra retries, no infinite loops.
func TestPaymentRoundTripper_NoRecoveryWhenHookDeclines(t *testing.T) {
	scheme := &hookSchemeClient{scheme: "test-scheme", signalRecover: false}
	x402Client := x402.Newx402Client()
	x402Client.Register("eip155:1", scheme)

	accepts := []types.PaymentRequirements{{
		Scheme:  "test-scheme",
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "100",
		PayTo:   "0xrecipient",
	}}

	var attempt int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempt++
		w.Header().Set("PAYMENT-REQUIRED", paymentRequiredHeader(t, accepts))
		w.WriteHeader(http.StatusPaymentRequired)
	}))
	defer server.Close()

	httpClient := WrapHTTPClientWithPayment(&http.Client{}, Newx402HTTPClient(x402Client))
	req, _ := http.NewRequestWithContext(context.Background(), "GET", server.URL, nil)
	resp, err := httpClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusPaymentRequired {
		t.Fatalf("expected 402, got %d", resp.StatusCode)
	}
	if scheme.correctiveCalls != 1 {
		t.Fatalf("expected corrective hook fire once, got %d", scheme.correctiveCalls)
	}
	if attempt != 2 {
		t.Fatalf("expected initial + 1 paid retry, got %d attempts", attempt)
	}
}

// TestWrapHTTPClientWithPayment_DoesNotMutateInput is a regression test for
// the bug where WrapHTTPClientWithPayment mutated the input *http.Client's
// Transport in place. When called with http.DefaultClient that mutation would
// turn every subsequent caller of http.DefaultClient — including unrelated
// refund probes that expect a 402 — into a payment-aware client that auto-pays
// and returns 200. The wrapper must produce a NEW client and leave the input
// untouched.
func TestWrapHTTPClientWithPayment_DoesNotMutateInput(t *testing.T) {
	originalDefault := http.DefaultClient.Transport
	defer func() { http.DefaultClient.Transport = originalDefault }()

	x402Client := Newx402HTTPClient(x402.Newx402Client())

	wrapped := WrapHTTPClientWithPayment(http.DefaultClient, x402Client)

	if wrapped == http.DefaultClient {
		t.Fatal("wrapper returned the same *http.Client as the input — must return a new client")
	}
	if http.DefaultClient.Transport != originalDefault {
		t.Fatal("http.DefaultClient.Transport was mutated by WrapHTTPClientWithPayment")
	}
	if _, ok := wrapped.Transport.(*PaymentRoundTripper); !ok {
		t.Fatalf("returned client should have PaymentRoundTripper transport, got %T", wrapped.Transport)
	}

	custom := &http.Client{Timeout: 7 * 1e9}
	customOriginal := custom.Transport
	wrapped2 := WrapHTTPClientWithPayment(custom, x402Client)
	if wrapped2 == custom {
		t.Fatal("wrapper must not return the input *http.Client")
	}
	if custom.Transport != customOriginal {
		t.Fatal("input *http.Client.Transport was mutated")
	}
	if wrapped2.Timeout != custom.Timeout {
		t.Fatalf("wrapped client should preserve Timeout %v, got %v", custom.Timeout, wrapped2.Timeout)
	}
}
