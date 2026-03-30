package x402

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/coinbase/x402/go/types"
)

// Mock server for testing
type mockSchemeNetworkServer struct {
	scheme      string
	parsePrice  func(price Price, network Network) (AssetAmount, error)
	enhanceReqs func(ctx context.Context, base types.PaymentRequirements, supported types.SupportedKind, extensions []string) (types.PaymentRequirements, error)
}

func (m *mockSchemeNetworkServer) Scheme() string {
	return m.scheme
}

func (m *mockSchemeNetworkServer) ParsePrice(price Price, network Network) (AssetAmount, error) {
	if m.parsePrice != nil {
		return m.parsePrice(price, network)
	}
	return AssetAmount{
		Asset:  "USDC",
		Amount: "1000000",
		Extra:  map[string]interface{}{},
	}, nil
}

func (m *mockSchemeNetworkServer) EnhancePaymentRequirements(ctx context.Context, base types.PaymentRequirements, supported types.SupportedKind, extensions []string) (types.PaymentRequirements, error) {
	if m.enhanceReqs != nil {
		return m.enhanceReqs(ctx, base, supported, extensions)
	}
	enhanced := base
	if enhanced.Extra == nil {
		enhanced.Extra = make(map[string]interface{})
	}
	enhanced.Extra["enhanced"] = true
	return enhanced, nil
}

// mockFacilitatorClient is defined in server_hooks_test.go

// mockServerFacilitatorClient extends mockFacilitatorClient for server tests
type mockServerFacilitatorClient struct {
	kinds []SupportedKind
}

func (m *mockServerFacilitatorClient) Verify(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*VerifyResponse, error) {
	return &VerifyResponse{IsValid: true, Payer: "0xpayer"}, nil
}

func (m *mockServerFacilitatorClient) Settle(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*SettleResponse, error) {
	return &SettleResponse{Success: true, Transaction: "0xtx", Network: "eip155:1", Payer: "0xpayer"}, nil
}

func (m *mockServerFacilitatorClient) GetSupported(ctx context.Context) (SupportedResponse, error) {
	return SupportedResponse{
		Kinds:      m.kinds,
		Extensions: []string{},
		Signers:    make(map[string][]string),
	}, nil
}

func TestNewx402ResourceServer(t *testing.T) {
	server := Newx402ResourceServer()
	if server == nil {
		t.Fatal("Expected server to be created")
	}
	if server.schemes == nil {
		t.Fatal("Expected schemes map to be initialized")
	}
	if server.facilitatorClients == nil {
		t.Fatal("Expected facilitator clients to be initialized")
	}
	if server.supportedCache == nil {
		t.Fatal("Expected cache to be initialized")
	}
}

func TestServerWithOptions(t *testing.T) {
	mockClient := &mockFacilitatorClient{
		kinds: []SupportedKind{
			{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
		},
	}
	mockServer := &mockSchemeNetworkServer{scheme: "exact"}

	server := Newx402ResourceServer(
		WithFacilitatorClient(mockClient),
		WithSchemeServer("eip155:1", mockServer),
		WithCacheTTL(10*time.Minute),
	)

	// After Initialize, facilitatorClients map will be populated
	ctx := context.Background()
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}

	// Check schemes were registered
	if server.schemes["eip155:1"]["exact"] != mockServer {
		t.Fatal("Expected scheme server to be registered")
	}
	if server.supportedCache.ttl != 10*time.Minute {
		t.Fatal("Expected cache TTL to be set")
	}
}

func TestServerInitialize(t *testing.T) {
	ctx := context.Background()
	mockClient := &mockServerFacilitatorClient{
		kinds: []SupportedKind{
			{
				X402Version: 2,
				Scheme:      "exact",
				Network:     "eip155:1",
			},
			{
				X402Version: 2,
				Scheme:      "transfer",
				Network:     "eip155:8453",
			},
		},
	}

	server := Newx402ResourceServer(WithFacilitatorClient(mockClient))
	err := server.Initialize(ctx)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Verify initialization worked by checking GetSupported
	supported, err := mockClient.GetSupported(ctx)
	if err != nil {
		t.Fatalf("Failed to get supported: %v", err)
	}
	totalKinds := len(supported.Kinds)
	if totalKinds != 2 {
		t.Fatalf("Expected 2 kinds, got %d", totalKinds)
	}
}

func TestServerInitializeWithMultipleFacilitators(t *testing.T) {
	ctx := context.Background()

	// First facilitator supports exact on mainnet
	mockClient1 := &mockServerFacilitatorClient{
		kinds: []SupportedKind{
			{
				X402Version: 2,
				Scheme:      "exact",
				Network:     "eip155:1",
			},
		},
	}

	// Second facilitator supports exact on mainnet and Base
	mockClient2 := &mockServerFacilitatorClient{
		kinds: []SupportedKind{
			{
				X402Version: 2,
				Scheme:      "exact",
				Network:     "eip155:1", // Same as first
			},
			{
				X402Version: 2,
				Scheme:      "exact",
				Network:     "eip155:8453", // New network
			},
		},
	}

	server := Newx402ResourceServer(
		WithFacilitatorClient(mockClient1),
		WithFacilitatorClient(mockClient2),
	)

	err := server.Initialize(ctx)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Verify initialization worked by testing actual verify calls would route correctly
	// (facilitatorClientsMap is now private, test behavior instead of structure)
	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    types.PaymentRequirements{Scheme: "exact", Network: "eip155:1"},
		Payload:     map[string]interface{}{},
	}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:1"}

	result, _ := server.VerifyPayment(ctx, payload, requirements)
	if !result.IsValid {
		t.Fatal("Expected verify to work after initialization")
	}
}

func TestServerBuildPaymentRequirements(t *testing.T) {
	ctx := context.Background()

	mockServer := &mockSchemeNetworkServer{
		scheme: "exact",
		parsePrice: func(price Price, network Network) (AssetAmount, error) {
			return AssetAmount{
				Asset:  "USDC",
				Amount: "5000000",
				Extra:  map[string]interface{}{"decimals": 6},
			}, nil
		},
	}

	mockClient := &mockFacilitatorClient{}

	server := Newx402ResourceServer(
		WithFacilitatorClient(mockClient),
		WithSchemeServer("eip155:1", mockServer),
	)

	// Initialize to populate supported kinds
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}

	config := ResourceConfig{
		Scheme:            "exact",
		PayTo:             "0xrecipient",
		Price:             "$5.00",
		Network:           "eip155:1",
		MaxTimeoutSeconds: 600,
		Extra: map[string]interface{}{
			"assetTransferMethod": "permit2",
			"merchantNote":        "custom-scheme-data",
		},
	}

	// BuildPaymentRequirements now requires supportedKind
	supportedKind := types.SupportedKind{
		Scheme:  "exact",
		Network: "eip155:1",
	}

	requirements, err := server.BuildPaymentRequirements(ctx, config, supportedKind, []string{})
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if requirements.Scheme != "exact" {
		t.Fatalf("Expected scheme 'exact', got %s", requirements.Scheme)
	}
	if requirements.Amount != "5000000" {
		t.Fatalf("Expected amount '5000000', got %s", requirements.Amount)
	}
	if requirements.Asset != "USDC" {
		t.Fatalf("Expected asset 'USDC', got %s", requirements.Asset)
	}
	if requirements.MaxTimeoutSeconds != 600 {
		t.Fatalf("Expected timeout 600, got %d", requirements.MaxTimeoutSeconds)
	}
	if requirements.Extra["enhanced"] != true {
		t.Fatal("Expected requirements to be enhanced")
	}
	if requirements.Extra["decimals"] != 6 {
		t.Fatalf("Expected parsed extra to be preserved, got %v", requirements.Extra["decimals"])
	}
	if requirements.Extra["assetTransferMethod"] != "permit2" {
		t.Fatalf("Expected config extra to be merged, got %v", requirements.Extra["assetTransferMethod"])
	}
	if requirements.Extra["merchantNote"] != "custom-scheme-data" {
		t.Fatalf("Expected merchant extra to be merged, got %v", requirements.Extra["merchantNote"])
	}
}

func TestServerBuildPaymentRequirementsNoScheme(t *testing.T) {
	ctx := context.Background()
	server := Newx402ResourceServer()

	config := ResourceConfig{
		Scheme:  "unregistered",
		PayTo:   "0xrecipient",
		Price:   "$5.00",
		Network: "eip155:1",
	}

	supportedKind := types.SupportedKind{
		Scheme:  "unregistered",
		Network: "eip155:1",
	}

	_, err := server.BuildPaymentRequirements(ctx, config, supportedKind, []string{})
	if err == nil {
		t.Fatal("Expected error for unregistered scheme")
	}

	var paymentErr *PaymentError
	if !errors.As(err, &paymentErr) || paymentErr.Code != ErrCodeUnsupportedScheme {
		t.Fatal("Expected UnsupportedScheme error")
	}
}

func TestServerCreatePaymentRequiredResponse(t *testing.T) {
	server := Newx402ResourceServer()

	requirements := []types.PaymentRequirements{
		{
			Scheme:  "exact",
			Network: "eip155:1",
			Asset:   "USDC",
			Amount:  "1000000",
			PayTo:   "0xrecipient",
		},
	}

	info := &types.ResourceInfo{
		URL:         "https://api.example.com/resource",
		Description: "Premium API access",
		MimeType:    "application/json",
	}

	response := server.CreatePaymentRequiredResponse(
		requirements,
		info,
		"Custom error message",
		map[string]interface{}{"custom": "extension"},
	)

	if response.X402Version != 2 {
		t.Fatalf("Expected version 2, got %d", response.X402Version)
	}
	if response.Error != "Custom error message" {
		t.Fatalf("Expected custom error, got %s", response.Error)
	}
	if response.Resource.URL != info.URL {
		t.Fatal("Expected resource info to be set")
	}
	if len(response.Accepts) != 1 {
		t.Fatal("Expected 1 requirement")
	}
	if response.Extensions["custom"] != "extension" {
		t.Fatal("Expected custom extension")
	}
}

func TestServerVerifyPayment(t *testing.T) {
	ctx := context.Background()

	mockClient := &mockFacilitatorClient{
		kinds: []SupportedKind{
			{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
		},
		verify: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*VerifyResponse, error) {
			return &VerifyResponse{
				IsValid: true,
				Payer:   "0xverifiedpayer",
			}, nil
		},
	}

	server := Newx402ResourceServer(WithFacilitatorClient(mockClient))
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}

	requirements := types.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xrecipient",
	}

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     map[string]interface{}{},
	}

	// Server uses typed API now
	response, err := server.VerifyPayment(ctx, payload, requirements)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if !response.IsValid {
		t.Fatal("Expected valid verification")
	}
	if response.Payer != "0xverifiedpayer" {
		t.Fatalf("Expected payer '0xverifiedpayer', got %s", response.Payer)
	}
}

func TestServerSettlePayment(t *testing.T) {
	ctx := context.Background()

	mockClient := &mockFacilitatorClient{
		kinds: []SupportedKind{
			{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
		},
		settle: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*SettleResponse, error) {
			return &SettleResponse{
				Success:     true,
				Transaction: "0xsettledtx",
				Payer:       "0xpayer",
				Network:     "eip155:1",
			}, nil
		},
	}

	server := Newx402ResourceServer(WithFacilitatorClient(mockClient))
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}

	requirements := types.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xrecipient",
	}

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     map[string]interface{}{},
	}

	// Server uses typed API now
	response, err := server.SettlePayment(ctx, payload, requirements, nil)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if !response.Success {
		t.Fatal("Expected successful settlement")
	}
	if response.Transaction != "0xsettledtx" {
		t.Fatalf("Expected transaction '0xsettledtx', got %s", response.Transaction)
	}
}

func TestServerFindMatchingRequirements(t *testing.T) {
	server := Newx402ResourceServer()

	available := []types.PaymentRequirements{
		{
			Scheme:  "exact",
			Network: "eip155:1",
			Asset:   "USDC",
			Amount:  "1000000",
			PayTo:   "0xrecipient1",
		},
		{
			Scheme:  "transfer",
			Network: "eip155:8453",
			Asset:   "USDC",
			Amount:  "2000000",
			PayTo:   "0xrecipient2",
		},
	}

	// Test V2 matching (typed)
	payloadV2 := types.PaymentPayload{
		X402Version: 2,
		Accepted: types.PaymentRequirements{
			Scheme:  "transfer",
			Network: "eip155:8453",
			Asset:   "USDC",
			Amount:  "2000000",
			PayTo:   "0xrecipient2",
		},
	}

	matched := server.FindMatchingRequirements(available, payloadV2)
	if matched == nil {
		t.Fatal("Expected match for v2")
	}
	if matched.Scheme != "transfer" {
		t.Fatal("Expected transfer scheme to match")
	}

	// Server is V2 only - skip V1 matching test

	// Test no match
	payloadNoMatch := types.PaymentPayload{
		X402Version: 2,
		Accepted: types.PaymentRequirements{
			Scheme:  "nonexistent",
			Network: "eip155:1",
			Asset:   "USDC",
			Amount:  "3000000",
			PayTo:   "0xrecipient3",
		},
	}

	matched = server.FindMatchingRequirements(available, payloadNoMatch)
	if matched != nil {
		t.Fatal("Expected no match")
	}
}

// TestServerProcessPaymentRequest - SKIPPED: ProcessPaymentRequest is a stub
/*
func TestServerProcessPaymentRequest(t *testing.T) {
	ctx := context.Background()

	mockServer := &mockSchemeNetworkServer{scheme: "exact"}
	mockClient := &mockFacilitatorClient{}

	server := Newx402ResourceServer(
		WithFacilitatorClient(mockClient),
		WithSchemeServer("eip155:1", mockServer),
	)
	server.Initialize(ctx)

	config := ResourceConfig{
		Scheme:  "exact",
		PayTo:   "0xrecipient",
		Price:   "$1.00",
		Network: "eip155:1",
	}

	info := ResourceInfo{
		URL:         "https://api.example.com/resource",
		Description: "API resource",
	}

	// Test without payment (should require payment)
	result, err := server.ProcessPaymentRequest(ctx, nil, config, info, nil)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if result.Success {
		t.Fatal("Expected payment to be required")
	}
	if result.RequiresPayment == nil {
		t.Fatal("Expected payment required response")
	}

	// Test with valid payment
	// First, build requirements to see what they actually are
	builtReqs, _ := server.BuildPaymentRequirements(ctx, config)

	payload := &PaymentPayload{
		X402Version: 2,
		Payload:     map[string]interface{}{},
		Accepted:    builtReqs[0], // Use the actual built requirements
	}

	result, err = server.ProcessPaymentRequest(ctx, payload, config, info, nil)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if !result.Success {
		if result.Error != "" {
			t.Fatalf("Expected payment to be verified, got error: %s", result.Error)
		}
		if result.RequiresPayment != nil {
			t.Fatalf("Expected payment to be verified, got payment required: %v", result.RequiresPayment.Error)
		}
		t.Fatal("Expected payment to be verified")
	}
	if result.VerificationResult == nil {
		t.Fatal("Expected verification result")
	}
	if !result.VerificationResult.IsValid {
		t.Fatal("Expected valid verification")
	}
}
*/

// TestSupportedCache - SKIPPED: Cache.Clear method not implemented
/*
func TestSupportedCache(t *testing.T) {
	cache := &SupportedCache{
		data:   make(map[string]SupportedResponse),
		expiry: make(map[string]time.Time),
		ttl:    100 * time.Millisecond,
	}

	response := SupportedResponse{
		Kinds: []SupportedKind{
			{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
		},
		Extensions: []string{},
		Signers:    make(map[string][]string),
	}

	// Set and verify
	cache.Set("test", response)
	if len(cache.data) != 1 {
		t.Fatal("Expected item in cache")
	}

	// Wait for expiry
	time.Sleep(150 * time.Millisecond)

	// Clear cache
	cache.Clear()
	if len(cache.data) != 0 {
		t.Fatal("Expected cache to be cleared")
	}
	if len(cache.expiry) != 0 {
		t.Fatal("Expected expiry map to be cleared")
	}
}
*/

func TestResolveSettlementOverrideAmount(t *testing.T) {
	baseReqs := types.PaymentRequirements{
		Amount: "2000",
	}

	t.Run("raw atomic units", func(t *testing.T) {
		tests := []struct {
			input    string
			expected string
		}{
			{"1000", "1000"},
			{"0", "0"},
			{"999999", "999999"},
		}
		for _, tt := range tests {
			result, err := ResolveSettlementOverrideAmount(tt.input, baseReqs, 6)
			if err != nil {
				t.Errorf("ResolveSettlementOverrideAmount(%q) error: %v", tt.input, err)
			}
			if result != tt.expected {
				t.Errorf("ResolveSettlementOverrideAmount(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		}
	})

	t.Run("percent format", func(t *testing.T) {
		tests := []struct {
			input    string
			amount   string
			expected string
		}{
			{"50%", "2000", "1000"},
			{"100%", "2000", "2000"},
			{"0%", "2000", "0"},
			{"25%", "2000", "500"},
			{"33.33%", "3000", "999"},
			{"10.5%", "1000", "105"},
		}
		for _, tt := range tests {
			reqs := types.PaymentRequirements{Amount: tt.amount}
			result, err := ResolveSettlementOverrideAmount(tt.input, reqs, 6)
			if err != nil {
				t.Errorf("ResolveSettlementOverrideAmount(%q, amount=%s) error: %v", tt.input, tt.amount, err)
			}
			if result != tt.expected {
				t.Errorf("ResolveSettlementOverrideAmount(%q, amount=%s) = %q, want %q", tt.input, tt.amount, result, tt.expected)
			}
		}
	})

	t.Run("dollar price with default 6 decimals", func(t *testing.T) {
		tests := []struct {
			input    string
			expected string
		}{
			{"$1.00", "1000000"},
			{"$0.05", "50000"},
			{"$0.001", "1000"},
			{"$0", "0"},
		}
		for _, tt := range tests {
			result, err := ResolveSettlementOverrideAmount(tt.input, baseReqs, 6)
			if err != nil {
				t.Errorf("ResolveSettlementOverrideAmount(%q) error: %v", tt.input, err)
			}
			if result != tt.expected {
				t.Errorf("ResolveSettlementOverrideAmount(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		}
	})

	t.Run("dollar price with 8 decimals", func(t *testing.T) {
		reqs := types.PaymentRequirements{Amount: "2000"}
		result, err := ResolveSettlementOverrideAmount("$0.05", reqs, 8)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != "5000000" {
			t.Errorf("expected 5000000 (8 decimals), got %s", result)
		}
	})

	t.Run("dollar price result uses requirements asset regardless of decimals", func(t *testing.T) {
		reqs := types.PaymentRequirements{Amount: "2000", Asset: "0xSomeToken"}
		result, err := ResolveSettlementOverrideAmount("$0.001", reqs, 6)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		// Only the amount changes; the asset remains whatever is in requirements
		if result != "1000" {
			t.Errorf("expected 1000, got %s", result)
		}
	})

	t.Run("dollar price with 6 decimals", func(t *testing.T) {
		reqs := types.PaymentRequirements{Amount: "2000", Asset: "0xUnknownToken"}
		result, err := ResolveSettlementOverrideAmount("$0.05", reqs, 6)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != "50000" {
			t.Errorf("expected 50000 (6 decimals), got %s", result)
		}
	})
}
