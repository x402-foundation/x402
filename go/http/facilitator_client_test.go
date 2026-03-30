package http

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	x402 "github.com/coinbase/x402/go"
)

// Test helper functions

func NewStaticAuthProvider(token string) AuthProvider {
	return &staticAuthProvider{token: token}
}

type staticAuthProvider struct {
	token string
}

func (p *staticAuthProvider) GetAuthHeaders(ctx context.Context) (AuthHeaders, error) {
	auth := "Bearer " + p.token
	return AuthHeaders{
		Verify:    map[string]string{"Authorization": auth},
		Settle:    map[string]string{"Authorization": auth},
		Supported: map[string]string{"Authorization": auth},
	}, nil
}

func NewFuncAuthProvider(fn func(context.Context) (AuthHeaders, error)) AuthProvider {
	return &funcAuthProvider{fn: fn}
}

type funcAuthProvider struct {
	fn func(context.Context) (AuthHeaders, error)
}

func (p *funcAuthProvider) GetAuthHeaders(ctx context.Context) (AuthHeaders, error) {
	return p.fn(ctx)
}

func NewMultiFacilitatorClient(clients ...x402.FacilitatorClient) x402.FacilitatorClient {
	return &multiFacilitatorClient{clients: clients}
}

type multiFacilitatorClient struct {
	clients []x402.FacilitatorClient
}

func (m *multiFacilitatorClient) Verify(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
	for _, client := range m.clients {
		result, err := client.Verify(ctx, payloadBytes, requirementsBytes)
		if err == nil {
			return result, nil
		}
	}
	return nil, fmt.Errorf("all facilitators failed verification")
}

func (m *multiFacilitatorClient) Settle(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
	for _, client := range m.clients {
		result, err := client.Settle(ctx, payloadBytes, requirementsBytes)
		if err == nil {
			return result, nil
		}
	}
	return nil, fmt.Errorf("all facilitators failed settlement")
}

func (m *multiFacilitatorClient) GetSupported(ctx context.Context) (x402.SupportedResponse, error) {
	allKinds := []x402.SupportedKind{}
	extensionMap := make(map[string]bool)
	signersByFamily := make(map[string]map[string]bool)

	for _, client := range m.clients {
		supported, err := client.GetSupported(ctx)
		if err == nil {
			// Merge kinds (now flat array)
			allKinds = append(allKinds, supported.Kinds...)

			// Merge extensions
			for _, ext := range supported.Extensions {
				extensionMap[ext] = true
			}
			// Merge signers by family
			for family, signers := range supported.Signers {
				if signersByFamily[family] == nil {
					signersByFamily[family] = make(map[string]bool)
				}
				for _, signer := range signers {
					signersByFamily[family][signer] = true
				}
			}
		}
	}

	var extensions []string
	for ext := range extensionMap {
		extensions = append(extensions, ext)
	}

	signers := make(map[string][]string)
	for family, signerSet := range signersByFamily {
		for signer := range signerSet {
			signers[family] = append(signers[family], signer)
		}
	}

	return x402.SupportedResponse{
		Kinds:      allKinds,
		Extensions: extensions,
		Signers:    signers,
	}, nil
}

func TestNewHTTPFacilitatorClient(t *testing.T) {
	// Test with default config
	client := NewHTTPFacilitatorClient(nil)
	if client == nil {
		t.Fatal("Expected client to be created")
	}
	if client.url != DefaultFacilitatorURL {
		t.Errorf("Expected default URL %s, got %s", DefaultFacilitatorURL, client.url)
	}
	if client.identifier != DefaultFacilitatorURL {
		t.Errorf("Expected default identifier %s, got %s", DefaultFacilitatorURL, client.identifier)
	}

	// Test with custom config
	config := &FacilitatorConfig{
		URL:        "https://custom.facilitator.com",
		Identifier: "custom",
	}

	client = NewHTTPFacilitatorClient(config)
	if client.url != config.URL {
		t.Errorf("Expected URL %s, got %s", config.URL, client.url)
	}
	if client.identifier != "custom" {
		t.Errorf("Expected identifier 'custom', got %s", client.identifier)
	}
}

func TestHTTPFacilitatorClientVerify(t *testing.T) {
	ctx := context.Background()

	// Create test server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/verify" {
			t.Errorf("Expected path /verify, got %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("Expected POST, got %s", r.Method)
		}

		// Check request body
		var requestBody map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&requestBody); err != nil {
			t.Fatalf("Failed to decode request: %v", err)
		}

		if requestBody["x402Version"].(float64) != 2 {
			t.Error("Expected version 2 in request")
		}

		// Return success response
		response := x402.VerifyResponse{
			IsValid: true,
			Payer:   "0xverifiedpayer",
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()

	client := NewHTTPFacilitatorClient(&FacilitatorConfig{
		URL: server.URL,
	})

	requirements := x402.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xrecipient",
	}

	payload := x402.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     map[string]interface{}{"sig": "test"},
	}

	// Marshal to bytes for client call
	payloadBytes, _ := json.Marshal(payload)
	requirementsBytes, _ := json.Marshal(requirements)

	response, err := client.Verify(ctx, payloadBytes, requirementsBytes)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if !response.IsValid {
		t.Error("Expected valid response")
	}
	if response.Payer != "0xverifiedpayer" {
		t.Errorf("Expected payer 0xverifiedpayer, got %s", response.Payer)
	}
}

func TestHTTPFacilitatorClientVerifyInvalidResponse(t *testing.T) {
	ctx := context.Background()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"isValid":`))
	}))
	defer server.Close()

	client := NewHTTPFacilitatorClient(&FacilitatorConfig{
		URL: server.URL,
	})

	requirements := x402.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xrecipient",
	}

	payload := x402.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     map[string]interface{}{"sig": "test"},
	}

	payloadBytes, _ := json.Marshal(payload)
	requirementsBytes, _ := json.Marshal(requirements)

	_, err := client.Verify(ctx, payloadBytes, requirementsBytes)
	if err == nil {
		t.Fatal("Expected error for invalid verify response")
	}

	var responseErr *FacilitatorResponseError
	if !errors.As(err, &responseErr) {
		t.Fatalf("Expected FacilitatorResponseError, got: %T (%v)", err, err)
	}
	if !strings.Contains(responseErr.Error(), "facilitator verify returned invalid JSON") {
		t.Errorf("Expected invalid JSON message, got %q", responseErr.Error())
	}
}

func TestHTTPFacilitatorClientSettle(t *testing.T) {
	ctx := context.Background()

	// Create test server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/settle" {
			t.Errorf("Expected path /settle, got %s", r.URL.Path)
		}

		// Return success response
		response := x402.SettleResponse{
			Success:     true,
			Transaction: "0xsettledtx",
			Payer:       "0xpayer",
			Network:     "eip155:1",
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()

	client := NewHTTPFacilitatorClient(&FacilitatorConfig{
		URL: server.URL,
	})

	requirements := x402.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xrecipient",
	}

	payload := x402.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     map[string]interface{}{},
	}

	// Marshal to bytes for client call
	payloadBytes, _ := json.Marshal(payload)
	requirementsBytes, _ := json.Marshal(requirements)

	response, err := client.Settle(ctx, payloadBytes, requirementsBytes)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if !response.Success {
		t.Error("Expected successful settlement")
	}
	if response.Transaction != "0xsettledtx" {
		t.Errorf("Expected transaction 0xsettledtx, got %s", response.Transaction)
	}
}

func TestHTTPFacilitatorClientSettleInvalidResponse(t *testing.T) {
	ctx := context.Background()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success": true}`))
	}))
	defer server.Close()

	client := NewHTTPFacilitatorClient(&FacilitatorConfig{
		URL: server.URL,
	})

	requirements := x402.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xrecipient",
	}

	payload := x402.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     map[string]interface{}{"sig": "test"},
	}

	payloadBytes, _ := json.Marshal(payload)
	requirementsBytes, _ := json.Marshal(requirements)

	_, err := client.Settle(ctx, payloadBytes, requirementsBytes)
	if err == nil {
		t.Fatal("Expected error for invalid settle response")
	}

	var responseErr *FacilitatorResponseError
	if !errors.As(err, &responseErr) {
		t.Fatalf("Expected FacilitatorResponseError, got: %T (%v)", err, err)
	}
	if !strings.Contains(responseErr.Error(), "facilitator settle returned invalid data") {
		t.Errorf("Expected invalid data message, got %q", responseErr.Error())
	}
}

func TestHTTPFacilitatorClientGetSupported(t *testing.T) {
	ctx := context.Background()

	// Create test server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/supported" {
			t.Errorf("Expected path /supported, got %s", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Errorf("Expected GET, got %s", r.Method)
		}

		// Return supported response
		response := x402.SupportedResponse{
			Kinds: []x402.SupportedKind{
				{
					X402Version: 2,
					Scheme:      "exact",
					Network:     "eip155:1",
				},
				{
					X402Version: 2,
					Scheme:      "exact",
					Network:     "eip155:8453",
				},
			},
			Extensions: []string{"bazaar"},
			Signers:    make(map[string][]string),
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()

	client := NewHTTPFacilitatorClient(&FacilitatorConfig{
		URL: server.URL,
	})

	response, err := client.GetSupported(ctx)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	totalKinds := len(response.Kinds)
	if totalKinds != 2 {
		t.Errorf("Expected 2 kinds, got %d", totalKinds)
	}
	if len(response.Extensions) != 1 {
		t.Errorf("Expected 1 extension, got %d", len(response.Extensions))
	}
	if response.Extensions[0] != "bazaar" {
		t.Errorf("Expected 'bazaar' extension, got %s", response.Extensions[0])
	}
}

func TestHTTPFacilitatorClientGetSupportedInvalidResponse(t *testing.T) {
	ctx := context.Background()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"kinds":[{"scheme":"exact"}]}`))
	}))
	defer server.Close()

	client := NewHTTPFacilitatorClient(&FacilitatorConfig{
		URL: server.URL,
	})

	_, err := client.GetSupported(ctx)
	if err == nil {
		t.Fatal("Expected error for invalid supported response")
	}

	var responseErr *FacilitatorResponseError
	if !errors.As(err, &responseErr) {
		t.Fatalf("Expected FacilitatorResponseError, got: %T (%v)", err, err)
	}
	if !strings.Contains(responseErr.Error(), "facilitator getSupported returned invalid data") {
		t.Errorf("Expected invalid data message, got %q", responseErr.Error())
	}
}

func TestHTTPFacilitatorClientWithAuth(t *testing.T) {
	ctx := context.Background()

	// Create test server that checks auth headers
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-key" {
			t.Errorf("Expected 'Bearer test-key', got %s", auth)
		}

		// Return minimal response
		switch r.URL.Path {
		case "/verify":
			_ = json.NewEncoder(w).Encode(x402.VerifyResponse{IsValid: true, Payer: "0xpayer"})
		case "/settle":
			_ = json.NewEncoder(w).Encode(x402.SettleResponse{Success: true, Transaction: "0xtx", Payer: "0xpayer", Network: "eip155:1"})
		case "/supported":
			_ = json.NewEncoder(w).Encode(x402.SupportedResponse{})
		}
	}))
	defer server.Close()

	client := NewHTTPFacilitatorClient(&FacilitatorConfig{
		URL:          server.URL,
		AuthProvider: NewStaticAuthProvider("test-key"),
	})

	// Test all endpoints with auth
	requirements := x402.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xrecipient",
	}

	payload := x402.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     map[string]interface{}{},
	}

	// Marshal to bytes for client calls
	payloadBytes, _ := json.Marshal(payload)
	requirementsBytes, _ := json.Marshal(requirements)

	// Verify
	_, err := client.Verify(ctx, payloadBytes, requirementsBytes)
	if err != nil {
		t.Fatalf("Verify failed: %v", err)
	}

	// Settle
	_, err = client.Settle(ctx, payloadBytes, requirementsBytes)
	if err != nil {
		t.Fatalf("Settle failed: %v", err)
	}

	// GetSupported
	_, err = client.GetSupported(ctx)
	if err != nil {
		t.Fatalf("GetSupported failed: %v", err)
	}
}

func TestHTTPFacilitatorClientErrorHandling(t *testing.T) {
	ctx := context.Background()

	// Create test server that returns errors
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("Bad request"))
	}))
	defer server.Close()

	client := NewHTTPFacilitatorClient(&FacilitatorConfig{
		URL: server.URL,
	})

	requirements := x402.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xrecipient",
	}

	payload := x402.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     map[string]interface{}{},
	}

	// Marshal to bytes for client calls
	payloadBytes, _ := json.Marshal(payload)
	requirementsBytes, _ := json.Marshal(requirements)

	// Test Verify error
	_, err := client.Verify(ctx, payloadBytes, requirementsBytes)
	if err == nil {
		t.Error("Expected error for verify")
	}

	// Test Settle error
	_, err = client.Settle(ctx, payloadBytes, requirementsBytes)
	if err == nil {
		t.Error("Expected error for settle")
	}

	// Test GetSupported error
	_, err = client.GetSupported(ctx)
	if err == nil {
		t.Error("Expected error for getSupported")
	}
}

func TestHTTPFacilitatorClient400WithValidResponse(t *testing.T) {
	ctx := context.Background()

	// Create test server that returns 400 with valid response structures
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)

		switch r.URL.Path {
		case "/verify":
			response := x402.VerifyResponse{
				IsValid:       false,
				InvalidReason: "invalid_signature",
				Payer:         "0xpayer",
			}
			_ = json.NewEncoder(w).Encode(response)
		case "/settle":
			response := x402.SettleResponse{
				Success:     false,
				ErrorReason: "insufficient_allowance",
				Network:     "eip155:1",
				Payer:       "0xpayer",
			}
			_ = json.NewEncoder(w).Encode(response)
		}
	}))
	defer server.Close()

	client := NewHTTPFacilitatorClient(&FacilitatorConfig{
		URL: server.URL,
	})

	requirements := x402.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xrecipient",
	}

	payload := x402.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     map[string]interface{}{},
	}

	payloadBytes, _ := json.Marshal(payload)
	requirementsBytes, _ := json.Marshal(requirements)

	// Test Verify - should return VerifyError with 400 response
	_, err := client.Verify(ctx, payloadBytes, requirementsBytes)
	if err == nil {
		t.Fatal("Expected error for verify with 400 response")
	}
	var verifyErr *x402.VerifyError
	if !errors.As(err, &verifyErr) {
		t.Fatalf("Expected VerifyError, got: %T (%v)", err, err)
	}
	if verifyErr.InvalidReason != "invalid_signature" {
		t.Errorf("Expected Reason 'invalid_signature', got %s", verifyErr.InvalidReason)
	}

	// Test Settle - should return SettleError with 400 response
	_, err = client.Settle(ctx, payloadBytes, requirementsBytes)
	if err == nil {
		t.Fatal("Expected error for settle with 400 response")
	}
	var settleErr *x402.SettleError
	if !errors.As(err, &settleErr) {
		t.Fatalf("Expected SettleError, got: %T (%v)", err, err)
	}
	if settleErr.ErrorReason != "insufficient_allowance" {
		t.Errorf("Expected Reason 'insufficient_allowance', got %s", settleErr.ErrorReason)
	}
}

func TestStaticAuthProvider(t *testing.T) {
	provider := NewStaticAuthProvider("api-key-123")

	ctx := context.Background()
	headers, err := provider.GetAuthHeaders(ctx)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	expectedAuth := "Bearer api-key-123"
	if headers.Verify["Authorization"] != expectedAuth {
		t.Errorf("Expected verify auth %s, got %s", expectedAuth, headers.Verify["Authorization"])
	}
	if headers.Settle["Authorization"] != expectedAuth {
		t.Errorf("Expected settle auth %s, got %s", expectedAuth, headers.Settle["Authorization"])
	}
	if headers.Supported["Authorization"] != expectedAuth {
		t.Errorf("Expected supported auth %s, got %s", expectedAuth, headers.Supported["Authorization"])
	}
}

func TestFuncAuthProvider(t *testing.T) {
	provider := NewFuncAuthProvider(func(ctx context.Context) (AuthHeaders, error) {
		return AuthHeaders{
			Verify:    map[string]string{"X-API-Key": "verify-key"},
			Settle:    map[string]string{"X-API-Key": "settle-key"},
			Supported: map[string]string{"X-API-Key": "supported-key"},
		}, nil
	})

	ctx := context.Background()
	headers, err := provider.GetAuthHeaders(ctx)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if headers.Verify["X-API-Key"] != "verify-key" {
		t.Errorf("Expected verify key 'verify-key', got %s", headers.Verify["X-API-Key"])
	}
	if headers.Settle["X-API-Key"] != "settle-key" {
		t.Errorf("Expected settle key 'settle-key', got %s", headers.Settle["X-API-Key"])
	}
	if headers.Supported["X-API-Key"] != "supported-key" {
		t.Errorf("Expected supported key 'supported-key', got %s", headers.Supported["X-API-Key"])
	}
}

func TestMultiFacilitatorClient(t *testing.T) {
	ctx := context.Background()

	// Create mock facilitator clients
	client1 := &mockMultiFacilitatorClient{
		id: "client1",
		verifyFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
			var p x402.PaymentPayload
			_ = json.Unmarshal(payloadBytes, &p)
			if p.Accepted.Scheme == "exact" {
				return &x402.VerifyResponse{IsValid: true, Payer: "client1"}, nil
			}
			return nil, &x402.PaymentError{Message: "unsupported"}
		},
		supportedFunc: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
				},
				Extensions: []string{"ext1"},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	client2 := &mockMultiFacilitatorClient{
		id: "client2",
		verifyFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
			var p x402.PaymentPayload
			_ = json.Unmarshal(payloadBytes, &p)
			if p.Accepted.Scheme == "transfer" {
				return &x402.VerifyResponse{IsValid: true, Payer: "client2"}, nil
			}
			return nil, &x402.PaymentError{Message: "unsupported"}
		},
		supportedFunc: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "transfer", Network: "eip155:8453"},
				},
				Extensions: []string{"ext2"},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	multiClient := NewMultiFacilitatorClient(client1, client2)

	// Test Verify - should use client1 for "exact"
	requirements1 := x402.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xrecipient",
	}

	payload1 := x402.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements1,
		Payload:     map[string]interface{}{},
	}

	// Marshal to bytes for client call
	payload1Bytes, _ := json.Marshal(payload1)
	requirements1Bytes, _ := json.Marshal(requirements1)

	response, err := multiClient.Verify(ctx, payload1Bytes, requirements1Bytes)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if response.Payer != "client1" {
		t.Errorf("Expected payer 'client1', got %s", response.Payer)
	}

	// Test Verify - should use client2 for "transfer"
	requirements2 := x402.PaymentRequirements{
		Scheme:  "transfer",
		Network: "eip155:8453",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xrecipient",
	}

	payload2 := x402.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements2,
		Payload:     map[string]interface{}{},
	}

	// Marshal to bytes for client call
	payload2Bytes, _ := json.Marshal(payload2)
	requirements2Bytes, _ := json.Marshal(requirements2)

	response, err = multiClient.Verify(ctx, payload2Bytes, requirements2Bytes)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if response.Payer != "client2" {
		t.Errorf("Expected payer 'client2', got %s", response.Payer)
	}

	// Test GetSupported - should combine from both
	supported, err := multiClient.GetSupported(ctx)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	totalKinds := len(supported.Kinds)
	if totalKinds != 2 {
		t.Errorf("Expected 2 kinds, got %d", totalKinds)
	}
	if len(supported.Extensions) != 2 {
		t.Errorf("Expected 2 extensions, got %d", len(supported.Extensions))
	}
}

// ============================================================================
// GetSupported Retry Tests
// ============================================================================

func TestGetSupportedRetryOn429ThenSuccess(t *testing.T) {
	var attempts atomic.Int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempt := attempts.Add(1)
		if attempt <= 2 {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte("rate limited"))
			return
		}
		response := x402.SupportedResponse{
			Kinds: []x402.SupportedKind{
				{X402Version: 2, Scheme: "exact", Network: "eip155:8453"},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()

	client := NewHTTPFacilitatorClient(&FacilitatorConfig{URL: server.URL})

	result, err := client.GetSupported(context.Background())
	if err != nil {
		t.Fatalf("Expected success after retries, got error: %v", err)
	}
	if len(result.Kinds) != 1 {
		t.Errorf("Expected 1 kind, got %d", len(result.Kinds))
	}
	if int(attempts.Load()) != 3 {
		t.Errorf("Expected 3 attempts, got %d", attempts.Load())
	}
}

func TestGetSupportedRetryExhausted(t *testing.T) {
	var attempts atomic.Int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte("rate limited"))
	}))
	defer server.Close()

	client := NewHTTPFacilitatorClient(&FacilitatorConfig{URL: server.URL})

	_, err := client.GetSupported(context.Background())
	if err == nil {
		t.Fatal("Expected error after exhausted retries")
	}
	if int(attempts.Load()) != getSupportedRetries {
		t.Errorf("Expected %d attempts, got %d", getSupportedRetries, attempts.Load())
	}
}

func TestGetSupportedNoRetryOnNon429Error(t *testing.T) {
	var attempts atomic.Int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("internal error"))
	}))
	defer server.Close()

	client := NewHTTPFacilitatorClient(&FacilitatorConfig{URL: server.URL})

	_, err := client.GetSupported(context.Background())
	if err == nil {
		t.Fatal("Expected error for 500 response")
	}
	if int(attempts.Load()) != 1 {
		t.Errorf("Expected 1 attempt (no retry for 500), got %d", attempts.Load())
	}
}

func TestGetSupportedRetryRespectsContextCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte("rate limited"))
	}))
	defer server.Close()

	client := NewHTTPFacilitatorClient(&FacilitatorConfig{URL: server.URL})

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	_, err := client.GetSupported(ctx)
	if err == nil {
		t.Fatal("Expected error when context is cancelled during retry backoff")
	}
}

func TestGetSupportedSuccessOnFirstAttempt(t *testing.T) {
	var attempts atomic.Int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		response := x402.SupportedResponse{
			Kinds: []x402.SupportedKind{
				{X402Version: 2, Scheme: "exact", Network: "eip155:8453"},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()

	client := NewHTTPFacilitatorClient(&FacilitatorConfig{URL: server.URL})

	result, err := client.GetSupported(context.Background())
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if len(result.Kinds) != 1 {
		t.Errorf("Expected 1 kind, got %d", len(result.Kinds))
	}
	if int(attempts.Load()) != 1 {
		t.Errorf("Expected 1 attempt, got %d", attempts.Load())
	}
}

// Mock facilitator client for multi-client testing
type mockMultiFacilitatorClient struct {
	id            string
	verifyFunc    func(context.Context, []byte, []byte) (*x402.VerifyResponse, error)
	settleFunc    func(context.Context, []byte, []byte) (*x402.SettleResponse, error)
	supportedFunc func(context.Context) (x402.SupportedResponse, error)
}

func (m *mockMultiFacilitatorClient) Verify(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
	if m.verifyFunc != nil {
		return m.verifyFunc(ctx, payloadBytes, requirementsBytes)
	}
	return nil, fmt.Errorf("no verify function")
}

func (m *mockMultiFacilitatorClient) Settle(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
	if m.settleFunc != nil {
		return m.settleFunc(ctx, payloadBytes, requirementsBytes)
	}
	return nil, fmt.Errorf("no settle function")
}

func (m *mockMultiFacilitatorClient) GetSupported(ctx context.Context) (x402.SupportedResponse, error) {
	if m.supportedFunc != nil {
		return m.supportedFunc(ctx)
	}
	return x402.SupportedResponse{}, nil
}

func (m *mockMultiFacilitatorClient) Identifier() string {
	return m.id
}
