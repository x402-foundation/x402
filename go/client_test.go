package x402

import (
	"context"
	"errors"
	"testing"

	"github.com/x402-foundation/x402/go/types"
)

// Mock V1 client for testing
type mockSchemeNetworkClientV1 struct {
	scheme string
}

func (m *mockSchemeNetworkClientV1) Scheme() string {
	return m.scheme
}

func (m *mockSchemeNetworkClientV1) CreatePaymentPayload(ctx context.Context, requirements types.PaymentRequirementsV1) (types.PaymentPayloadV1, error) {
	return types.PaymentPayloadV1{
		X402Version: 1,
		Scheme:      m.scheme,
		Network:     "eip155:1",
		Payload: map[string]interface{}{
			"signature": "mock_signature",
			"from":      "0xmock",
		},
	}, nil
}

// Mock V2 client for testing
type mockSchemeNetworkClientV2 struct {
	scheme string
}

func (m *mockSchemeNetworkClientV2) Scheme() string {
	return m.scheme
}

func (m *mockSchemeNetworkClientV2) CreatePaymentPayload(ctx context.Context, requirements types.PaymentRequirements) (types.PaymentPayload, error) {
	return types.PaymentPayload{
		X402Version: 2,
		Payload: map[string]interface{}{
			"signature": "mock_signature",
			"from":      "0xmock",
		},
	}, nil
}

func TestNewx402Client(t *testing.T) {
	client := Newx402Client()
	if client == nil {
		t.Fatal("Expected client to be created")
	}
	// Schemes are now split into schemesV1 and schemesV2 (private)
	if client.requirementsSelector == nil {
		t.Fatal("Expected default selector to be set")
	}
}

func TestClientRegister(t *testing.T) {
	client := Newx402Client()
	mockClientV1 := &mockSchemeNetworkClientV1{scheme: "exact"}
	mockClientV2 := &mockSchemeNetworkClientV2{scheme: "exact"}

	// Test v2 registration
	client.Register("eip155:1", mockClientV2)

	// Verify registration using GetRegisteredSchemes
	schemes := client.GetRegisteredSchemes()
	if len(schemes[2]) != 1 {
		t.Fatal("Expected 1 scheme for v2")
	}
	if schemes[2][0].Scheme != "exact" {
		t.Fatal("Expected exact scheme to be registered")
	}

	// Test v1 registration
	client.RegisterV1("eip155:1", mockClientV1)
	schemes = client.GetRegisteredSchemes()
	if len(schemes[1]) != 1 {
		t.Fatal("Expected 1 scheme for v1")
	}
}

func TestClientWithScheme(t *testing.T) {
	mockClientV2 := &mockSchemeNetworkClientV2{scheme: "exact"}

	client := Newx402Client()
	client.Register("eip155:1", mockClientV2)

	schemes := client.GetRegisteredSchemes()
	if len(schemes[2]) != 1 || schemes[2][0].Scheme != "exact" {
		t.Fatal("Expected mock client to be registered")
	}
}

func TestClientSelectPaymentRequirements(t *testing.T) {
	client := Newx402Client()
	mockClient := &mockSchemeNetworkClientV2{scheme: "exact"}
	client.Register("eip155:1", mockClient)

	requirements := []types.PaymentRequirements{
		{
			Scheme:  "exact",
			Network: "eip155:1",
			Asset:   "USDC",
			Amount:  "1000000",
			PayTo:   "0xrecipient",
		},
		{
			Scheme:  "unsupported",
			Network: "eip155:1",
			Asset:   "USDC",
			Amount:  "2000000",
			PayTo:   "0xrecipient",
		},
	}

	// Should select the first supported requirement
	selected, err := client.SelectPaymentRequirements(requirements)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if selected.Scheme != "exact" {
		t.Fatalf("Expected 'exact' scheme, got %s", selected.Scheme)
	}
	if selected.Amount != "1000000" {
		t.Fatalf("Expected amount '1000000', got %s", selected.Amount)
	}

	// Test with no supported requirements
	unsupportedReqs := []types.PaymentRequirements{
		{
			Scheme:  "unsupported",
			Network: "eip155:1",
			Asset:   "USDC",
			Amount:  "1000000",
			PayTo:   "0xrecipient",
		},
	}

	_, err = client.SelectPaymentRequirements(unsupportedReqs)
	if err == nil {
		t.Fatal("Expected error for unsupported requirements")
	}

	var paymentErr *PaymentError
	if !errors.As(err, &paymentErr) || paymentErr.Code != ErrCodeUnsupportedScheme {
		t.Fatal("Expected UnsupportedScheme error")
	}
}

func TestClientSelectPaymentRequirementsWithCustomSelector(t *testing.T) {
	// Custom selector that chooses the highest amount (uses view interface)
	customSelector := func(requirements []PaymentRequirementsView) PaymentRequirementsView {
		if len(requirements) == 0 {
			panic("no requirements")
		}
		highest := requirements[0]
		for _, req := range requirements[1:] {
			if req.GetAmount() > highest.GetAmount() {
				highest = req
			}
		}
		return highest
	}

	client := Newx402Client(WithPaymentSelector(customSelector))
	mockClient := &mockSchemeNetworkClientV2{scheme: "exact"}
	client.Register("eip155:1", mockClient)

	requirements := []types.PaymentRequirements{
		{
			Scheme:  "exact",
			Network: "eip155:1",
			Asset:   "USDC",
			Amount:  "1000000",
			PayTo:   "0xrecipient",
		},
		{
			Scheme:  "exact",
			Network: "eip155:1",
			Asset:   "USDC",
			Amount:  "2000000",
			PayTo:   "0xrecipient",
		},
	}

	selected, err := client.SelectPaymentRequirements(requirements)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if selected.Amount != "2000000" {
		t.Fatalf("Expected amount '2000000', got %s", selected.Amount)
	}
}

func TestClientCreatePaymentPayload(t *testing.T) {
	ctx := context.Background()
	client := Newx402Client()

	mockClient := &mockSchemeNetworkClientV2{scheme: "exact"}
	client.Register("eip155:1", mockClient)

	requirements := types.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xrecipient",
	}

	resourceV2 := &types.ResourceInfo{
		URL:         "https://example.com/api",
		Description: "Test API",
		MimeType:    "application/json",
	}

	extensions := map[string]interface{}{
		"test": "value",
	}

	// Call typed API (no marshaling needed)
	payload, err := client.CreatePaymentPayload(ctx, requirements, resourceV2, extensions)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Check fields directly (already typed!)
	if payload.X402Version != 2 {
		t.Fatalf("Expected version 2, got %d", payload.X402Version)
	}
	if payload.Accepted.Scheme != "exact" {
		t.Fatalf("Expected accepted scheme 'exact', got %s", payload.Accepted.Scheme)
	}
	if payload.Accepted.Network != "eip155:1" {
		t.Fatalf("Expected accepted network 'eip155:1', got %s", payload.Accepted.Network)
	}
	if payload.Payload == nil {
		t.Fatal("Expected payload to be set")
	}
	if payload.Resource == nil {
		t.Fatal("Expected resource to be set")
	}
	if payload.Extensions == nil {
		t.Fatal("Expected extensions to be set")
	}
}

func TestClientCreatePaymentPayloadValidation(t *testing.T) {
	ctx := context.Background()
	client := Newx402Client()

	// Try to create payload with invalid requirements (typed, missing scheme)
	invalidReqsV2 := types.PaymentRequirements{
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xrecipient",
		// Missing Scheme - should error
	}
	_, err := client.CreatePaymentPayload(ctx, invalidReqsV2, nil, nil)
	if err == nil {
		t.Fatal("Expected error for invalid requirements")
	}
}

func TestClientCreatePaymentPayloadNoScheme(t *testing.T) {
	ctx := context.Background()
	client := Newx402Client()

	// Register a different scheme
	mockClient := &mockSchemeNetworkClientV2{scheme: "different"}
	client.Register("eip155:1", mockClient)

	requirements := types.PaymentRequirements{
		Scheme:  "unregistered",
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xrecipient",
	}

	_, err := client.CreatePaymentPayload(ctx, requirements, nil, nil)
	if err == nil {
		t.Fatal("Expected error for unregistered scheme")
	}

	var paymentErr *PaymentError
	if !errors.As(err, &paymentErr) {
		t.Fatalf("Expected PaymentError, got: %v (%T)", err, err)
	}
	if paymentErr.Code != ErrCodeUnsupportedScheme {
		t.Fatalf("Expected UnsupportedScheme error code, got: %s", paymentErr.Code)
	}
}

func TestClientGetRegisteredSchemes(t *testing.T) {
	client := Newx402Client()
	mockClientV2_1 := &mockSchemeNetworkClientV2{scheme: "exact"}
	mockClientV2_2 := &mockSchemeNetworkClientV2{scheme: "transfer"}
	mockClientV1_1 := &mockSchemeNetworkClientV1{scheme: "exact"}

	client.Register("eip155:1", mockClientV2_1)
	client.Register("eip155:8453", mockClientV2_2)
	client.RegisterV1("eip155:1", mockClientV1_1)

	schemes := client.GetRegisteredSchemes()
	if len(schemes) != 2 {
		t.Fatalf("Expected 2 versions, got %d", len(schemes))
	}
	if len(schemes[2]) != 2 {
		t.Fatalf("Expected 2 schemes for v2, got %d", len(schemes[2]))
	}
	if len(schemes[1]) != 1 {
		t.Fatalf("Expected 1 scheme for v1, got %d", len(schemes[1]))
	}
}

// TestClientCanPay - SKIPPED: CanPay method removed in refactoring
// func TestClientCanPay(t *testing.T) { ... }

// TestClientCreatePaymentForRequired - SKIPPED: CreatePaymentForRequired method removed in refactoring
// func TestClientCreatePaymentForRequired(t *testing.T) { ... }

func TestClientNetworkPatternMatching(t *testing.T) {
	client := Newx402Client()
	mockClient := &mockSchemeNetworkClientV2{scheme: "exact"}

	// Register with wildcard
	client.Register("eip155:*", mockClient)

	requirements := types.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:8453", // Specific network
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xrecipient",
	}

	// Should match the wildcard pattern
	ctx := context.Background()
	payload, err := client.CreatePaymentPayload(ctx, requirements, nil, nil)
	if err != nil {
		t.Fatalf("Expected pattern match to work: %v", err)
	}

	// Check fields directly (typed)
	if payload.Accepted.Scheme != "exact" {
		t.Fatal("Expected payload to be created with pattern match")
	}
}
