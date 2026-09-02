package x402

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/x402-foundation/x402/go/v2/types"
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

func (m *mockSchemeNetworkServer) DefaultAssetTransferMethod() string {
	return SDKDefaultAssetTransferMethod
}

func (m *mockSchemeNetworkServer) PaymentFlows() map[string]PaymentFlowConfig {
	auth := PaymentFlowConfig{
		Supported: []PaymentFlowName{PaymentFlowAuthorization},
		Default:   PaymentFlowAuthorization,
	}
	return map[string]PaymentFlowConfig{
		SDKDefaultAssetTransferMethod: auth,
		"eip3009":                     auth,
		"permit2":                     auth,
	}
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
		WithSchemeServer("eip155:1", &mockSchemeNetworkServer{scheme: "exact"}),
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

func TestGetPaymentFlow_UnregisteredScheme(t *testing.T) {
	server := Newx402ResourceServer()
	_, err := server.GetPaymentFlow(types.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:1",
	})
	if err == nil {
		t.Fatal("Expected error for unregistered scheme")
	}
	if !strings.Contains(err.Error(), `No scheme implementation registered for "exact" on network "eip155:1"`) {
		t.Fatalf("unexpected error: %v", err)
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

// stubEnricherScheme records EnrichPaymentRequiredResponse calls and mutates
// the matching requirement's Extra to verify core wiring.
type stubEnricherScheme struct {
	calls           int
	lastErrorReason string
	lastPayload     *types.PaymentPayload
}

func (s *stubEnricherScheme) Scheme() string { return "stub-enricher" }
func (s *stubEnricherScheme) DefaultAssetTransferMethod() string {
	return SDKDefaultAssetTransferMethod
}
func (s *stubEnricherScheme) PaymentFlows() map[string]PaymentFlowConfig {
	auth := PaymentFlowConfig{
		Supported: []PaymentFlowName{PaymentFlowAuthorization},
		Default:   PaymentFlowAuthorization,
	}
	return map[string]PaymentFlowConfig{
		SDKDefaultAssetTransferMethod: auth,
		"eip3009":                     auth,
		"permit2":                     auth,
	}
}
func (s *stubEnricherScheme) ParsePrice(_ Price, _ Network) (AssetAmount, error) {
	return AssetAmount{}, nil
}
func (s *stubEnricherScheme) EnhancePaymentRequirements(
	_ context.Context,
	r types.PaymentRequirements,
	_ types.SupportedKind,
	_ []string,
) (types.PaymentRequirements, error) {
	return r, nil
}
func (s *stubEnricherScheme) EnrichPaymentRequiredResponse(ctx PaymentRequiredContext) {
	s.calls++
	s.lastErrorReason = ctx.Error
	s.lastPayload = ctx.PaymentPayload
	for i := range ctx.Requirements {
		if ctx.Requirements[i].Scheme != "stub-enricher" {
			continue
		}
		if ctx.Requirements[i].Extra == nil {
			ctx.Requirements[i].Extra = map[string]interface{}{}
		}
		ctx.Requirements[i].Extra["EnrichedBy"] = "stub-enricher"
	}
}

func TestCreatePaymentRequiredResponse_InvokesEnricher(t *testing.T) {
	server := Newx402ResourceServer()
	enricher := &stubEnricherScheme{}
	server.Register(Network("eip155:1"), enricher)

	pp := &types.PaymentPayload{X402Version: 2}
	requirements := []types.PaymentRequirements{
		{Scheme: "stub-enricher", Network: "eip155:1", Asset: "USDC", Amount: "1"},
	}
	resp := server.CreatePaymentRequiredResponseWithPayload(
		requirements, &types.ResourceInfo{URL: "https://x"}, "some_error", nil, pp,
	)

	if enricher.calls != 1 {
		t.Fatalf("expected 1 enricher call, got %d", enricher.calls)
	}
	if enricher.lastErrorReason != "some_error" {
		t.Fatalf("unexpected error reason: %q", enricher.lastErrorReason)
	}
	if enricher.lastPayload != pp {
		t.Fatalf("expected payload to flow through")
	}
	if resp.Accepts[0].Extra["EnrichedBy"] != "stub-enricher" {
		t.Fatalf("expected enrichment mutation, got %+v", resp.Accepts[0].Extra)
	}
}

func TestCreatePaymentRequiredResponse_NoEnricherForUnknownScheme(t *testing.T) {
	server := Newx402ResourceServer()
	requirements := []types.PaymentRequirements{
		{Scheme: "unknown", Network: "eip155:1"},
	}
	// Must not panic and must return baseline response.
	resp := server.CreatePaymentRequiredResponse(requirements, nil, "err", nil)
	if len(resp.Accepts) != 1 {
		t.Fatalf("expected requirements untouched")
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

	server := Newx402ResourceServer(
		WithFacilitatorClient(mockClient),
		WithSchemeServer("eip155:1", &mockSchemeNetworkServer{scheme: "exact"}),
	)
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

// TestServerVerifyPayment_InvalidFacilitatorResponse is a regression test for the security
// bug where a facilitator HTTP-200 response with isValid:false was not treated as an error,
// allowing any structurally well-formed payment header to pass the gate.
func TestServerVerifyPayment_InvalidFacilitatorResponse(t *testing.T) {
	ctx := context.Background()

	for _, tc := range []struct {
		name           string
		verifyResponse *VerifyResponse
		wantReason     string
	}{
		{
			name:           "isValid false with reason",
			verifyResponse: &VerifyResponse{IsValid: false, InvalidReason: "insufficient_balance", Payer: "0xpayer"},
			wantReason:     "insufficient_balance",
		},
		{
			name:           "isValid false without reason",
			verifyResponse: &VerifyResponse{IsValid: false},
			wantReason:     ErrCodeInvalidPayment,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mockClient := &mockFacilitatorClient{
				kinds: []SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
				},
				verify: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*VerifyResponse, error) {
					return tc.verifyResponse, nil // HTTP-200 but isValid:false
				},
			}

			server := Newx402ResourceServer(
				WithFacilitatorClient(mockClient),
				WithSchemeServer("eip155:1", &mockSchemeNetworkServer{scheme: "exact"}),
			)
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

			_, err := server.VerifyPayment(ctx, payload, requirements)
			if err == nil {
				t.Fatal("Expected error for isValid:false facilitator response, got nil — payment gate bypass")
			}
			var ve *VerifyError
			if !errors.As(err, &ve) {
				t.Fatalf("Expected *VerifyError, got %T: %v", err, err)
			}
			if ve.InvalidReason != tc.wantReason {
				t.Fatalf("Expected reason %q, got %q", tc.wantReason, ve.InvalidReason)
			}
		})
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

// mockSettleOnCancelScheme is an upto-like scheme used to exercise settleOnCancel.
type mockSettleOnCancelScheme struct {
	mockSchemeNetworkServer
	settleOnCancel func(ctx VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error)
	dynamicFields  []string
}

func (m *mockSettleOnCancelScheme) SettleOnCancel(ctx VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error) {
	if m.settleOnCancel != nil {
		return m.settleOnCancel(ctx)
	}
	return nil, nil
}

func (m *mockSettleOnCancelScheme) DynamicExtraFields() []string {
	return m.dynamicFields
}

func TestSettleOnCancel_SettlesOnceWhenRequirementsReturned(t *testing.T) {
	ctx := context.Background()
	var settleCalls int
	var settledAmount string
	var cancelPhase SettlePhase

	mockClient := &mockFacilitatorClient{
		kinds: []SupportedKind{
			{X402Version: 2, Scheme: "upto", Network: "eip155:8453"},
		},
		settle: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*SettleResponse, error) {
			settleCalls++
			var reqs types.PaymentRequirements
			if err := json.Unmarshal(requirementsBytes, &reqs); err != nil {
				t.Fatalf("unmarshal requirements: %v", err)
			}
			settledAmount = reqs.Amount
			return &SettleResponse{
				Success:     true,
				Amount:      reqs.Amount,
				Transaction: "0xrefund",
				Network:     "eip155:8453",
				Payer:       "0xpayer",
			}, nil
		},
	}

	scheme := &mockSettleOnCancelScheme{
		mockSchemeNetworkServer: mockSchemeNetworkServer{scheme: "upto"},
		settleOnCancel: func(c VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error) {
			reqs := c.Requirements.(types.PaymentRequirements)
			reqs.Amount = "0"
			return &reqs, nil
		},
	}

	server := Newx402ResourceServer(
		WithFacilitatorClient(mockClient),
		WithSchemeServer("eip155:8453", scheme),
	)
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	server.OnBeforeSettle(func(c SettleContext) (*BeforeHookResult, error) {
		cancelPhase = c.Phase
		return nil, nil
	})

	requirements := types.PaymentRequirements{
		Scheme:  "upto",
		Network: "eip155:8453",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xrecipient",
	}
	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     map[string]interface{}{},
	}

	cancellation := server.CreatePaymentCancellationDispatcherWithExtensions(
		ctx, payload, requirements, nil, []SettlePhase{SettlePhaseBeforeHandler},
	)
	cancelResult := cancellation.Cancel(VerifiedPaymentCancelOptions{
		Reason:         CancellationReasonHandlerFailed,
		ResponseStatus: 500,
	})
	// Second cancel must be a no-op.
	_ = cancellation.Cancel(VerifiedPaymentCancelOptions{Reason: CancellationReasonHandlerThrew})

	if cancelPhase != SettlePhaseCancel {
		t.Fatalf("expected cancel phase, got %q", cancelPhase)
	}
	if cancelResult == nil || !cancelResult.Success || cancelResult.Transaction != "0xrefund" {
		t.Fatalf("unexpected cancel result: %+v", cancelResult)
	}
	if settleCalls != 1 {
		t.Fatalf("expected 1 settle call, got %d", settleCalls)
	}
	if settledAmount != "0" {
		t.Fatalf("expected settle amount 0, got %q", settledAmount)
	}
}

func TestSettleOnCancel_SkipsWhenVoid(t *testing.T) {
	ctx := context.Background()
	var settleCalls int
	mockClient := &mockFacilitatorClient{
		kinds: []SupportedKind{
			{X402Version: 2, Scheme: "upto", Network: "eip155:8453"},
		},
		settle: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*SettleResponse, error) {
			settleCalls++
			return &SettleResponse{Success: true, Transaction: "0x", Network: "eip155:8453"}, nil
		},
	}
	scheme := &mockSettleOnCancelScheme{
		mockSchemeNetworkServer: mockSchemeNetworkServer{scheme: "upto"},
		settleOnCancel:          func(VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error) { return nil, nil },
	}
	server := Newx402ResourceServer(WithFacilitatorClient(mockClient), WithSchemeServer("eip155:8453", scheme))
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	requirements := types.PaymentRequirements{Scheme: "upto", Network: "eip155:8453", Asset: "USDC", Amount: "1", PayTo: "0x"}
	payload := types.PaymentPayload{X402Version: 2, Accepted: requirements, Payload: map[string]interface{}{}}
	cancellation := server.CreatePaymentCancellationDispatcherWithExtensions(
		ctx, payload, requirements, nil, []SettlePhase{SettlePhaseBeforeHandler},
	)
	if got := cancellation.Cancel(VerifiedPaymentCancelOptions{Reason: CancellationReasonHandlerFailed, ResponseStatus: 500}); got != nil {
		t.Fatalf("expected nil cancel result, got %+v", got)
	}
	if settleCalls != 0 {
		t.Fatalf("expected 0 settle calls, got %d", settleCalls)
	}
}

func TestSettleOnCancel_SkipsWithoutBeforeHandlerDeposit(t *testing.T) {
	ctx := context.Background()
	var settleCalls int
	mockClient := &mockFacilitatorClient{
		kinds: []SupportedKind{
			{X402Version: 2, Scheme: "upto", Network: "eip155:8453"},
		},
		settle: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*SettleResponse, error) {
			settleCalls++
			return &SettleResponse{Success: true, Transaction: "0x", Network: "eip155:8453"}, nil
		},
	}
	scheme := &mockSettleOnCancelScheme{
		mockSchemeNetworkServer: mockSchemeNetworkServer{scheme: "upto"},
		settleOnCancel: func(c VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error) {
			reqs := c.Requirements.(types.PaymentRequirements)
			reqs.Amount = "0"
			return &reqs, nil
		},
	}
	server := Newx402ResourceServer(WithFacilitatorClient(mockClient), WithSchemeServer("eip155:8453", scheme))
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	requirements := types.PaymentRequirements{Scheme: "upto", Network: "eip155:8453", Asset: "USDC", Amount: "1", PayTo: "0x"}
	payload := types.PaymentPayload{X402Version: 2, Accepted: requirements, Payload: map[string]interface{}{}}
	cancellation := server.CreatePaymentCancellationDispatcherWithExtensions(ctx, payload, requirements, nil, nil)
	if got := cancellation.Cancel(VerifiedPaymentCancelOptions{Reason: CancellationReasonHandlerFailed, ResponseStatus: 500}); got != nil {
		t.Fatalf("expected nil cancel result, got %+v", got)
	}
	if settleCalls != 0 {
		t.Fatalf("expected 0 settle calls, got %d", settleCalls)
	}
}

func TestSettleOnCancel_WarnsAndReturnsFailedReceipt(t *testing.T) {
	ctx := context.Background()
	mockClient := &mockFacilitatorClient{
		kinds: []SupportedKind{
			{X402Version: 2, Scheme: "upto", Network: "eip155:8453"},
		},
		settle: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*SettleResponse, error) {
			return nil, errors.New("facilitator unavailable")
		},
	}
	scheme := &mockSettleOnCancelScheme{
		mockSchemeNetworkServer: mockSchemeNetworkServer{scheme: "upto"},
		settleOnCancel: func(c VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error) {
			reqs := c.Requirements.(types.PaymentRequirements)
			reqs.Amount = "0"
			return &reqs, nil
		},
	}
	server := Newx402ResourceServer(WithFacilitatorClient(mockClient), WithSchemeServer("eip155:8453", scheme))
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	requirements := types.PaymentRequirements{Scheme: "upto", Network: "eip155:8453", Asset: "USDC", Amount: "1", PayTo: "0x"}
	payload := types.PaymentPayload{X402Version: 2, Accepted: requirements, Payload: map[string]interface{}{}}
	cancellation := server.CreatePaymentCancellationDispatcherWithExtensions(
		ctx, payload, requirements, nil, []SettlePhase{SettlePhaseBeforeHandler},
	)
	got := cancellation.Cancel(VerifiedPaymentCancelOptions{Reason: CancellationReasonAfterVerifyAborted})
	if got == nil || got.Success || got.Transaction != "" {
		t.Fatalf("expected failed cancel receipt, got %+v", got)
	}
	if got.ErrorReason == "" {
		t.Fatal("expected errorReason on failed cancel receipt")
	}
}

func TestBuildFailurePathSettlementResponse_PrefersSuccessfulCancel(t *testing.T) {
	cancel := &SettleResponse{
		Success:     true,
		Transaction: "0xrefund",
		Network:     "eip155:8453",
	}
	before := &CompletedSettlement{
		Result: &SettleResponse{Success: true, Transaction: "0xdeposit", Amount: "100"},
	}
	got := BuildFailurePathSettlementResponse(cancel, before, nil)
	if got == nil || got.Transaction != "0xrefund" {
		t.Fatalf("expected cancel receipt, got %+v", got)
	}
}

func TestBuildFailurePathSettlementResponse_FailedCancelRecoveryExtras(t *testing.T) {
	cancel := &SettleResponse{
		Success:     false,
		ErrorReason: "refund_failed",
		Transaction: "should-clear",
		Network:     "eip155:8453",
	}
	before := &CompletedSettlement{
		Result: &SettleResponse{
			Success:     true,
			Transaction: "0xdeposit",
			Amount:      "100000",
		},
	}
	payload := &types.PaymentPayload{
		Payload: map[string]interface{}{"channelId": "channel-123"},
	}

	got := BuildFailurePathSettlementResponse(cancel, before, payload)
	if got == nil || got.Success {
		t.Fatalf("expected failed receipt, got %+v", got)
	}
	if got.Transaction != "" {
		t.Fatalf("expected empty transaction, got %q", got.Transaction)
	}
	if got.Extra["depositTransaction"] != "0xdeposit" {
		t.Fatalf("expected depositTransaction, got %#v", got.Extra)
	}
	if got.Extra["depositAmount"] != "100000" {
		t.Fatalf("expected depositAmount, got %#v", got.Extra)
	}
	if got.Extra["channelId"] != "channel-123" {
		t.Fatalf("expected channelId, got %#v", got.Extra)
	}
}

func TestBuildFailurePathSettlementResponse_EchoesBeforeHandler(t *testing.T) {
	before := &CompletedSettlement{
		Result: &SettleResponse{Success: true, Transaction: "0xdeposit"},
	}
	got := BuildFailurePathSettlementResponse(nil, before, nil)
	if got == nil || got.Transaction != "0xdeposit" {
		t.Fatalf("expected before-handler echo, got %+v", got)
	}
}

func TestBuildFailurePathSettlementResponse_NilWhenNothing(t *testing.T) {
	if got := BuildFailurePathSettlementResponse(nil, nil, nil); got != nil {
		t.Fatalf("expected nil, got %+v", got)
	}
}

func TestFindMatchingRequirements_DynamicExtraFields(t *testing.T) {
	scheme := &mockSettleOnCancelScheme{
		mockSchemeNetworkServer: mockSchemeNetworkServer{scheme: "exact"},
		dynamicFields:           []string{"recentBlockhash", "lastValidBlockHeight"},
	}
	server := Newx402ResourceServer(WithSchemeServer("solana:mainnet", scheme))

	req := types.PaymentRequirements{
		Scheme:            "exact",
		Network:           "solana:mainnet",
		Amount:            "1000000",
		Asset:             "USDC",
		PayTo:             "PayTo1111111111111111111111111111111111111",
		MaxTimeoutSeconds: 60,
		Extra: map[string]interface{}{
			"feePayer":             "FeePayer111111111111111111111111111111111",
			"recentBlockhash":      "freshBlockhash",
			"lastValidBlockHeight": "200",
		},
	}

	t.Run("matches when only declared dynamic extra fields differ", func(t *testing.T) {
		payload := types.PaymentPayload{
			X402Version: 2,
			Accepted: types.PaymentRequirements{
				Scheme:            req.Scheme,
				Network:           req.Network,
				Amount:            req.Amount,
				Asset:             req.Asset,
				PayTo:             req.PayTo,
				MaxTimeoutSeconds: req.MaxTimeoutSeconds,
				Extra: map[string]interface{}{
					"feePayer":             "FeePayer111111111111111111111111111111111",
					"recentBlockhash":      "staleBlockhash",
					"lastValidBlockHeight": "100",
				},
			},
		}
		matched := server.FindMatchingRequirements([]types.PaymentRequirements{req}, payload)
		if matched == nil {
			t.Fatal("expected match when only dynamic extras differ")
		}
	})

	t.Run("does not match when a static extra field differs", func(t *testing.T) {
		payload := types.PaymentPayload{
			X402Version: 2,
			Accepted: types.PaymentRequirements{
				Scheme:            req.Scheme,
				Network:           req.Network,
				Amount:            req.Amount,
				Asset:             req.Asset,
				PayTo:             req.PayTo,
				MaxTimeoutSeconds: req.MaxTimeoutSeconds,
				Extra: map[string]interface{}{
					"feePayer":        "OtherPayer1111111111111111111111111111111",
					"recentBlockhash": "staleBlockhash",
				},
			},
		}
		if matched := server.FindMatchingRequirements([]types.PaymentRequirements{req}, payload); matched != nil {
			t.Fatal("expected no match when static extra differs")
		}
	})

	t.Run("keeps strict extra comparison without dynamicExtraFields", func(t *testing.T) {
		plain := Newx402ResourceServer(WithSchemeServer("solana:mainnet", &mockSchemeNetworkServer{scheme: "exact"}))
		payload := types.PaymentPayload{
			X402Version: 2,
			Accepted: types.PaymentRequirements{
				Scheme:            req.Scheme,
				Network:           req.Network,
				Amount:            req.Amount,
				Asset:             req.Asset,
				PayTo:             req.PayTo,
				MaxTimeoutSeconds: req.MaxTimeoutSeconds,
				Extra: map[string]interface{}{
					"feePayer":        "FeePayer111111111111111111111111111111111",
					"recentBlockhash": "staleBlockhash",
				},
			},
		}
		if matched := plain.FindMatchingRequirements([]types.PaymentRequirements{req}, payload); matched != nil {
			t.Fatal("expected no match when dynamic fields are not declared")
		}
	})
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

	// Set stores the value.
	cache.Set("test", response)
	if len(cache.data) != 1 {
		t.Fatal("Expected item in cache")
	}

	// Get returns the stored value before expiry.
	cached, ok := cache.Get("test")
	if !ok {
		t.Fatal("Expected cached item to be found")
	}
	if len(cached.Kinds) != 1 || cached.Kinds[0].Scheme != "exact" || cached.Kinds[0].Network != "eip155:1" {
		t.Fatalf("Expected cached response to match stored value, got %+v", cached)
	}

	// Clear removes all data and expiry state.
	cache.Clear()
	if len(cache.data) != 0 {
		t.Fatal("Expected cache to be cleared")
	}
	if len(cache.expiry) != 0 {
		t.Fatal("Expected expiry map to be cleared")
	}

	// Get returns false after the cache is cleared.
	if _, ok := cache.Get("test"); ok {
		t.Fatal("Expected cache miss after Clear")
	}
}

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
			{"12.5%", "2000", "250"},
			{"12.50%", "2000", "250"},
			{"100%", "2000", "2000"},
			{"0%", "2000", "0"},
			{"25%", "2000", "500"},
			{"33.33%", "3000", "999"},
			{"10.5%", "1000", "105"},
			{"50%", "3", "1"},
			{"999999999999999999999%", "1000000", "9999999999999999999990000"},
			{"92233720368547758.08%", "1000000", "922337203685477580800"},
			{"184467440737095516.16%", "1000000", "1844674407370955161600"},
			{"50%", "18446744073709551616", "9223372036854775808"},
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

	t.Run("percent format with invalid requirements amount", func(t *testing.T) {
		reqs := types.PaymentRequirements{Amount: "not-a-number"}
		_, err := ResolveSettlementOverrideAmount("50%", reqs, 6)
		if err == nil {
			t.Fatal("expected invalid requirements amount error")
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
			{"$1.0000005", "1000000"},
			{"$0.0000005", "0"},
			{"$0.0000009", "0"},
			{"$0.00", "0"},
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

// dynamicFieldExtension is a minimal ResourceServerExtension that opts into
// dynamic-info-field handling for echo validation tests.
type dynamicFieldExtension struct {
	key    string
	fields []string
}

func (e dynamicFieldExtension) Key() string { return e.key }

func (e dynamicFieldExtension) EnrichDeclaration(declaration interface{}, _ interface{}) interface{} {
	return declaration
}

func (e dynamicFieldExtension) DynamicInfoFields() []string { return e.fields }

// ValidateExtensions must reject client echoes that drop or alter server fields
// while allowing additive fields, omitted keys, and client-only keys.
func TestValidateExtensions(t *testing.T) {
	serverExtensions := map[string]interface{}{
		"bazaar":  map[string]interface{}{"info": map[string]interface{}{"tool": "search", "version": 1}},
		"builder": map[string]interface{}{"info": map[string]interface{}{"code": "abc"}},
	}
	server := Newx402ResourceServer()

	payloadWith := func(extensions map[string]interface{}) types.PaymentPayload {
		return types.PaymentPayload{X402Version: 2, Extensions: extensions}
	}

	t.Run("passes when server has no extensions", func(t *testing.T) {
		p := payloadWith(map[string]interface{}{"bazaar": map[string]interface{}{"info": map[string]interface{}{"tool": "wrong"}}})
		if r := server.ValidateExtensions(nil, p); !r.Valid {
			t.Fatalf("expected valid, got %+v", r)
		}
	})

	t.Run("fails when undeclared builder-code carries app attribution", func(t *testing.T) {
		p := payloadWith(map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"a": "attacker_app"},
			},
		})
		r := server.ValidateExtensions(nil, p)
		if r.Valid || r.InvalidReason != "extension_echo_mismatch" || r.ExtensionKey != "builder-code" {
			t.Fatalf("expected echo mismatch on undeclared builder-code app attribution, got %+v", r)
		}
	})

	t.Run("fails when another extension is declared but builder-code app attribution is not", func(t *testing.T) {
		p := payloadWith(map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"a": "attacker_app"},
			},
		})
		r := server.ValidateExtensions(serverExtensions, p)
		if r.Valid || r.InvalidReason != "extension_echo_mismatch" || r.ExtensionKey != "builder-code" {
			t.Fatalf("expected echo mismatch on undeclared builder-code app attribution, got %+v", r)
		}
	})

	t.Run("passes when undeclared builder-code carries only client service attribution", func(t *testing.T) {
		p := payloadWith(map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"s": []interface{}{"client_service"}},
			},
		})
		if r := server.ValidateExtensions(nil, p); !r.Valid {
			t.Fatalf("expected valid client-only service attribution, got %+v", r)
		}
	})

	t.Run("fails when flat undeclared builder-code carries app attribution", func(t *testing.T) {
		p := payloadWith(map[string]interface{}{
			"builder-code": map[string]interface{}{"a": "attacker_app"},
		})
		r := server.ValidateExtensions(nil, p)
		if r.Valid || r.InvalidReason != "extension_echo_mismatch" || r.ExtensionKey != "builder-code" {
			t.Fatalf("expected echo mismatch on flat undeclared builder-code app attribution, got %+v", r)
		}
	})

	t.Run("passes when client omits extensions", func(t *testing.T) {
		if r := server.ValidateExtensions(serverExtensions, payloadWith(nil)); !r.Valid {
			t.Fatalf("expected valid, got %+v", r)
		}
	})

	t.Run("passes with additive info fields", func(t *testing.T) {
		p := payloadWith(map[string]interface{}{
			"bazaar": map[string]interface{}{"info": map[string]interface{}{"tool": "search", "version": 1, "extraField": "ok"}},
		})
		if r := server.ValidateExtensions(serverExtensions, p); !r.Valid {
			t.Fatalf("expected valid, got %+v", r)
		}
	})

	t.Run("passes when client echoes subset of keys", func(t *testing.T) {
		p := payloadWith(map[string]interface{}{
			"bazaar": map[string]interface{}{"info": map[string]interface{}{"tool": "search", "version": 1}},
		})
		if r := server.ValidateExtensions(serverExtensions, p); !r.Valid {
			t.Fatalf("expected valid, got %+v", r)
		}
	})

	t.Run("passes with client-only extension key", func(t *testing.T) {
		p := payloadWith(map[string]interface{}{
			"clientOnly": map[string]interface{}{"info": map[string]interface{}{"anything": true}},
		})
		if r := server.ValidateExtensions(serverExtensions, p); !r.Valid {
			t.Fatalf("expected valid, got %+v", r)
		}
	})

	t.Run("passes with flat extension values", func(t *testing.T) {
		flat := map[string]interface{}{"bazaar": map[string]interface{}{"tool": "search", "version": 1}}
		p := payloadWith(map[string]interface{}{"bazaar": map[string]interface{}{"tool": "search", "version": 1, "extra": "ok"}})
		if r := server.ValidateExtensions(flat, p); !r.Valid {
			t.Fatalf("expected valid, got %+v", r)
		}
	})

	t.Run("fails when client changes a server field", func(t *testing.T) {
		p := payloadWith(map[string]interface{}{
			"bazaar": map[string]interface{}{"info": map[string]interface{}{"tool": "search", "version": 2}},
		})
		r := server.ValidateExtensions(serverExtensions, p)
		if r.Valid || r.InvalidReason != "extension_echo_mismatch" || r.ExtensionKey != "bazaar" {
			t.Fatalf("expected echo mismatch on bazaar, got %+v", r)
		}
	})

	t.Run("fails when client deletes a server field", func(t *testing.T) {
		p := payloadWith(map[string]interface{}{
			"bazaar": map[string]interface{}{"info": map[string]interface{}{"tool": "search"}},
		})
		r := server.ValidateExtensions(serverExtensions, p)
		if r.Valid || r.InvalidReason != "extension_echo_mismatch" || r.ExtensionKey != "bazaar" {
			t.Fatalf("expected echo mismatch on bazaar, got %+v", r)
		}
	})

	t.Run("passes for v1 payloads", func(t *testing.T) {
		p := types.PaymentPayload{
			X402Version: 1,
			Extensions:  map[string]interface{}{"bazaar": map[string]interface{}{"info": map[string]interface{}{"tool": "wrong"}}},
		}
		if r := server.ValidateExtensions(serverExtensions, p); !r.Valid {
			t.Fatalf("expected valid, got %+v", r)
		}
	})

	t.Run("passes for v1 payloads with forged builder-code app attribution", func(t *testing.T) {
		p := types.PaymentPayload{
			X402Version: 1,
			Extensions: map[string]interface{}{
				"builder-code": map[string]interface{}{
					"info": map[string]interface{}{"a": "forged_app"},
				},
			},
		}
		if r := server.ValidateExtensions(nil, p); !r.Valid {
			t.Fatalf("expected v1 extensions to remain outside echo validation, got %+v", r)
		}
	})

	// Extensions declared as typed Go structs (e.g. eip2612gassponsor.Extension)
	// must validate the same way as map-declared extensions. Mirrors the gas
	// extension shape inline to avoid an import cycle (eip2612gassponsor imports
	// this package).
	type srvInfo struct {
		Description string `json:"description"`
		Version     string `json:"version"`
	}
	type srvExt struct {
		Info   interface{}            `json:"info"`
		Schema map[string]interface{} `json:"schema"`
	}
	structExtensions := map[string]interface{}{
		"eip2612GasSponsoring": srvExt{
			Info:   srvInfo{Description: "gasless permit", Version: "1"},
			Schema: map[string]interface{}{"type": "object"},
		},
	}

	t.Run("passes with struct-declared extension and merged echo", func(t *testing.T) {
		p := payloadWith(map[string]interface{}{
			"eip2612GasSponsoring": map[string]interface{}{
				"info": map[string]interface{}{
					"description": "gasless permit",
					"version":     "1",
					"from":        "0xabc",
					"asset":       "0xdef",
				},
			},
		})
		if r := server.ValidateExtensions(structExtensions, p); !r.Valid {
			t.Fatalf("expected valid, got %+v", r)
		}
	})

	t.Run("passes with struct-declared builder-code and matching echo", func(t *testing.T) {
		type builderInfo struct {
			AppCode string `json:"a"`
		}
		type builderExtension struct {
			Info builderInfo `json:"info"`
		}
		advertised := map[string]interface{}{
			"builder-code": builderExtension{Info: builderInfo{AppCode: "honest_app"}},
		}
		p := payloadWith(map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"a": "honest_app"},
			},
		})
		if r := server.ValidateExtensions(advertised, p); !r.Valid {
			t.Fatalf("expected matching typed builder-code declaration to pass, got %+v", r)
		}
	})

	t.Run("fails when typed undeclared builder-code carries app attribution", func(t *testing.T) {
		type builderInfo struct {
			AppCode string `json:"a"`
		}
		type builderExtension struct {
			Info builderInfo `json:"info"`
		}
		p := payloadWith(map[string]interface{}{
			"builder-code": builderExtension{Info: builderInfo{AppCode: "attacker_app"}},
		})
		r := server.ValidateExtensions(nil, p)
		if r.Valid || r.InvalidReason != "extension_echo_mismatch" || r.ExtensionKey != "builder-code" {
			t.Fatalf("expected echo mismatch on typed undeclared builder-code app attribution, got %+v", r)
		}
	})

	t.Run("fails when struct-declared field is dropped", func(t *testing.T) {
		p := payloadWith(map[string]interface{}{
			"eip2612GasSponsoring": map[string]interface{}{
				"info": map[string]interface{}{"version": "1", "from": "0xabc"},
			},
		})
		r := server.ValidateExtensions(structExtensions, p)
		if r.Valid || r.InvalidReason != "extension_echo_mismatch" || r.ExtensionKey != "eip2612GasSponsoring" {
			t.Fatalf("expected echo mismatch on eip2612GasSponsoring, got %+v", r)
		}
	})

	t.Run("fails when struct-declared field is changed", func(t *testing.T) {
		p := payloadWith(map[string]interface{}{
			"eip2612GasSponsoring": map[string]interface{}{
				"info": map[string]interface{}{"description": "gasless permit", "version": "2"},
			},
		})
		r := server.ValidateExtensions(structExtensions, p)
		if r.Valid || r.InvalidReason != "extension_echo_mismatch" || r.ExtensionKey != "eip2612GasSponsoring" {
			t.Fatalf("expected echo mismatch on eip2612GasSponsoring, got %+v", r)
		}
	})

	t.Run("passes when only a declared dynamic info field differs", func(t *testing.T) {
		dynServer := Newx402ResourceServer()
		dynServer.RegisterExtension(dynamicFieldExtension{key: "siwx", fields: []string{"nonce"}})
		advertised := map[string]interface{}{
			"siwx": map[string]interface{}{"info": map[string]interface{}{"domain": "example.com", "nonce": "fresh"}},
		}
		p := payloadWith(map[string]interface{}{
			"siwx": map[string]interface{}{"info": map[string]interface{}{"domain": "example.com", "nonce": "stale"}},
		})
		if r := dynServer.ValidateExtensions(advertised, p); !r.Valid {
			t.Fatalf("expected valid, got %+v", r)
		}
	})

	t.Run("fails when a static info field differs despite a declared dynamic field", func(t *testing.T) {
		dynServer := Newx402ResourceServer()
		dynServer.RegisterExtension(dynamicFieldExtension{key: "siwx", fields: []string{"nonce"}})
		advertised := map[string]interface{}{
			"siwx": map[string]interface{}{"info": map[string]interface{}{"domain": "example.com", "nonce": "fresh"}},
		}
		p := payloadWith(map[string]interface{}{
			"siwx": map[string]interface{}{"info": map[string]interface{}{"domain": "evil.com", "nonce": "stale"}},
		})
		r := dynServer.ValidateExtensions(advertised, p)
		if r.Valid || r.InvalidReason != "extension_echo_mismatch" || r.ExtensionKey != "siwx" {
			t.Fatalf("expected echo mismatch on siwx, got %+v", r)
		}
	})

	t.Run("keeps strict comparison when no dynamic fields are declared", func(t *testing.T) {
		p := payloadWith(map[string]interface{}{
			"builder": map[string]interface{}{"info": map[string]interface{}{"code": "tampered"}},
		})
		r := server.ValidateExtensions(serverExtensions, p)
		if r.Valid || r.InvalidReason != "extension_echo_mismatch" || r.ExtensionKey != "builder" {
			t.Fatalf("expected echo mismatch on builder, got %+v", r)
		}
	})

	t.Run("passes when echoed array is a superset of advertised array", func(t *testing.T) {
		advertised := map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"a": "bc_app", "s": []interface{}{"bc_server"}},
			},
		}
		p := payloadWith(map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{
					"a": "bc_app",
					"s": []interface{}{"bc_server", "bc_client"},
				},
			},
		})
		if r := server.ValidateExtensions(advertised, p); !r.Valid {
			t.Fatalf("expected valid additive s merge, got %+v", r)
		}
	})

	t.Run("fails when builder-code app attribution differs from the declaration", func(t *testing.T) {
		advertised := map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"a": "honest_app"},
			},
		}
		p := payloadWith(map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"a": "attacker_app"},
			},
		})
		r := server.ValidateExtensions(advertised, p)
		if r.Valid || r.InvalidReason != "extension_echo_mismatch" || r.ExtensionKey != "builder-code" {
			t.Fatalf("expected echo mismatch on builder-code app attribution, got %+v", r)
		}
	})

	t.Run("fails when echoed array drops an advertised element", func(t *testing.T) {
		advertised := map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"s": []interface{}{"bc_server"}},
			},
		}
		p := payloadWith(map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"s": []interface{}{"bc_client"}},
			},
		})
		r := server.ValidateExtensions(advertised, p)
		if r.Valid || r.InvalidReason != "extension_echo_mismatch" || r.ExtensionKey != "builder-code" {
			t.Fatalf("expected echo mismatch on builder-code, got %+v", r)
		}
	})

	t.Run("fails when echoed array exceeds the combined client+server budget even as a superset", func(t *testing.T) {
		// Regression test: a hand-crafted echo padding `s` past the combined
		// budget must be rejected outright rather than accepted and left to be
		// silently truncated downstream (e.g. by a facilitator extension),
		// which could crowd out the legitimately advertised entry.
		advertised := map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"s": []interface{}{"bc_server"}},
			},
		}
		padded := make([]interface{}, 0, 11)
		padded = append(padded, "bc_server")
		for i := 0; i < 10; i++ {
			padded = append(padded, fmt.Sprintf("bc_fake_%d", i))
		}
		p := payloadWith(map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"s": padded},
			},
		})
		r := server.ValidateExtensions(advertised, p)
		if r.Valid || r.InvalidReason != "extension_echo_mismatch" || r.ExtensionKey != "builder-code" {
			t.Fatalf("expected echo mismatch on builder-code for oversized echo, got %+v", r)
		}
	})

	t.Run("passes when echoed array is exactly at the combined client+server budget", func(t *testing.T) {
		advertised := map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"s": []interface{}{"bc_server"}},
			},
		}
		atBudget := make([]interface{}, 0, 10)
		atBudget = append(atBudget, "bc_server")
		for i := 0; i < 9; i++ {
			atBudget = append(atBudget, fmt.Sprintf("bc_client_%d", i))
		}
		p := payloadWith(map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"s": atBudget},
			},
		})
		if r := server.ValidateExtensions(advertised, p); !r.Valid {
			t.Fatalf("expected valid echo at the combined budget, got %+v", r)
		}
	})

	t.Run("passes when the echoed array elements are []map[string]interface{} instead of []interface{}", func(t *testing.T) {
		advertised := map[string]interface{}{
			"ext": map[string]interface{}{
				"info": map[string]interface{}{
					"items": []interface{}{map[string]interface{}{"a": 1.0}},
				},
			},
		}
		p := payloadWith(map[string]interface{}{
			"ext": map[string]interface{}{
				"info": map[string]interface{}{
					"items": []map[string]interface{}{{"a": 1.0}},
				},
			},
		})
		if r := server.ValidateExtensions(advertised, p); !r.Valid {
			t.Fatalf("expected valid echo for []map[string]interface{} element type, got %+v", r)
		}
	})

	t.Run("passes when the advertised s is a scalar and the echo is an array containing it", func(t *testing.T) {
		advertised := map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"s": "bc_server"},
			},
		}
		p := payloadWith(map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"s": []interface{}{"bc_server", "bc_client"}},
			},
		})
		if r := server.ValidateExtensions(advertised, p); !r.Valid {
			t.Fatalf("expected valid echo for scalar advertised s, got %+v", r)
		}
	})

	t.Run("passes when the advertised s is an array and the echo is a matching scalar", func(t *testing.T) {
		advertised := map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"s": []interface{}{"bc_server"}},
			},
		}
		p := payloadWith(map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"s": "bc_server"},
			},
		})
		if r := server.ValidateExtensions(advertised, p); !r.Valid {
			t.Fatalf("expected valid echo for scalar echo of single-element advertised s, got %+v", r)
		}
	})

	t.Run("fails when a non-builder-code extension's array field gains an echoed element", func(t *testing.T) {
		// Additive-array echo matching is scoped to builder-code's `s`; other
		// extensions' array fields (e.g. sign-in-with-x's `resources`) must still
		// match exactly so clients cannot smuggle extra values into the echo.
		advertised := map[string]interface{}{
			"sign-in-with-x": map[string]interface{}{
				"info": map[string]interface{}{"resources": []interface{}{"https://api.example.com/data"}},
			},
		}
		p := payloadWith(map[string]interface{}{
			"sign-in-with-x": map[string]interface{}{
				"info": map[string]interface{}{
					"resources": []interface{}{"https://api.example.com/data", "https://evil.example.com"},
				},
			},
		})
		r := server.ValidateExtensions(advertised, p)
		if r.Valid || r.InvalidReason != "extension_echo_mismatch" || r.ExtensionKey != "sign-in-with-x" {
			t.Fatalf("expected echo mismatch on sign-in-with-x, got %+v", r)
		}
	})
}

func TestVerifyPaymentWithExtensionsRejectsUndeclaredBuilderCodeAppAttribution(t *testing.T) {
	server := Newx402ResourceServer()
	payload := types.PaymentPayload{
		X402Version: 2,
		Extensions: map[string]interface{}{
			"builder-code": map[string]interface{}{
				"info": map[string]interface{}{"a": "attacker_app"},
			},
		},
	}

	result, err := server.VerifyPaymentWithExtensions(
		context.Background(),
		payload,
		types.PaymentRequirements{},
		nil,
	)
	if err == nil {
		t.Fatal("expected undeclared builder-code app attribution to fail verification")
	}
	if result == nil || result.IsValid || result.InvalidReason != "extension_echo_mismatch" {
		t.Fatalf("expected invalid extension echo result, got %+v", result)
	}
	var verifyErr *VerifyError
	if !errors.As(err, &verifyErr) || verifyErr.InvalidReason != "extension_echo_mismatch" {
		t.Fatalf("expected extension_echo_mismatch verify error, got %v", err)
	}
}
