package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/types"
)

// Mock facilitator client for testing
type mockFacilitatorClient struct {
	verifyFunc func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error)
	settleFunc func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error)
}

func (m *mockFacilitatorClient) Verify(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
	if m.verifyFunc != nil {
		return m.verifyFunc(ctx, payloadBytes, requirementsBytes)
	}
	return &x402.VerifyResponse{IsValid: true, Payer: "test-payer"}, nil
}

func (m *mockFacilitatorClient) Settle(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
	if m.settleFunc != nil {
		return m.settleFunc(ctx, payloadBytes, requirementsBytes)
	}
	return &x402.SettleResponse{Success: true, Transaction: "tx123", Network: "x402:cash", Payer: "test-payer"}, nil
}

func (m *mockFacilitatorClient) GetSupported(ctx context.Context) (x402.SupportedResponse, error) {
	return x402.SupportedResponse{
		Kinds: []types.SupportedKind{
			{X402Version: 2, Scheme: "cash", Network: "x402:cash"},
		},
		Extensions: []string{},
		Signers:    make(map[string][]string),
	}, nil
}

// Mock scheme network server for testing
type mockSchemeNetworkServer struct {
	scheme string
}

func (m *mockSchemeNetworkServer) Scheme() string {
	return m.scheme
}

func (m *mockSchemeNetworkServer) ParsePrice(price x402.Price, network x402.Network) (x402.AssetAmount, error) {
	return x402.AssetAmount{
		Asset:  "USD",
		Amount: "1000",
		Extra:  make(map[string]interface{}),
	}, nil
}

func (m *mockSchemeNetworkServer) EnhancePaymentRequirements(ctx context.Context, base types.PaymentRequirements, supported types.SupportedKind, extensions []string) (types.PaymentRequirements, error) {
	enhanced := base
	if enhanced.Extra == nil {
		enhanced.Extra = make(map[string]interface{})
	}
	return enhanced, nil
}

// makeCallToolRequest builds a *mcp.CallToolRequest for testing.
func makeCallToolRequest(args map[string]interface{}, meta mcp.Meta) *mcp.CallToolRequest {
	argsBytes, _ := json.Marshal(args)
	if argsBytes == nil {
		argsBytes = []byte("{}")
	}
	params := &mcp.CallToolParamsRaw{
		Name:      "test",
		Arguments: argsBytes,
		Meta:      meta,
	}
	return &mcp.CallToolRequest{Params: params}
}

func TestNewPaymentWrapper_EmptyAccepts(t *testing.T) {
	server := x402.Newx402ResourceServer()

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("Expected panic for empty accepts")
		}
	}()
	NewPaymentWrapper(server, PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{},
	})
}

func TestNewPaymentWrapper_BasicFlow(t *testing.T) {
	mockFacilitator := &mockFacilitatorClient{}
	mockSchemeServer := &mockSchemeNetworkServer{scheme: "cash"}

	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockFacilitator),
		x402.WithSchemeServer("x402:cash", mockSchemeServer),
	)

	ctx := context.Background()
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}

	config := PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{
				Scheme:  "cash",
				Network: "x402:cash",
				Amount:  "1000",
				PayTo:   "test-recipient",
			},
		},
		Resource: &ResourceInfo{
			URL:         "mcp://tool/test",
			Description: "Test tool",
			MimeType:    "application/json",
		},
	}

	wrapper := NewPaymentWrapper(server, config)
	handler := func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "success"}},
		}, nil
	}
	wrapped := wrapper.Wrap(handler)

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted: types.PaymentRequirements{
			Scheme:  "cash",
			Network: "x402:cash",
			Amount:  "1000",
			PayTo:   "test-recipient",
		},
		Payload: map[string]interface{}{
			"signature": "~test-payer",
		},
	}

	req := makeCallToolRequest(map[string]interface{}{"test": "value"}, mcp.Meta{MCP_PAYMENT_META_KEY: payload})
	result, err := wrapped(ctx, req)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if result.IsError {
		t.Error("Expected success result")
	}

	if result.Meta == nil {
		t.Fatal("Expected meta to be set")
	}
	if result.Meta[MCP_PAYMENT_RESPONSE_META_KEY] == nil {
		t.Error("Expected payment response in meta")
	}
}

func TestNewPaymentWrapper_NoPayment(t *testing.T) {
	mockFacilitator := &mockFacilitatorClient{}
	mockSchemeServer := &mockSchemeNetworkServer{scheme: "cash"}

	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockFacilitator),
		x402.WithSchemeServer("x402:cash", mockSchemeServer),
	)

	ctx := context.Background()
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}

	config := PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{
				Scheme:  "cash",
				Network: "x402:cash",
				Amount:  "1000",
				PayTo:   "test-recipient",
			},
		},
	}

	wrapper := NewPaymentWrapper(server, config)
	handler := func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{}, nil
	}
	wrapped := wrapper.Wrap(handler)

	req := makeCallToolRequest(map[string]interface{}{}, mcp.Meta{})
	result, err := wrapped(ctx, req)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !result.IsError {
		t.Error("Expected error result for missing payment")
	}
}

func TestNewPaymentWrapper_VerificationFailure(t *testing.T) {
	server := x402.Newx402ResourceServer()

	config := PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{
				Scheme:  "cash",
				Network: "x402:cash",
				Amount:  "1000",
				PayTo:   "test-recipient",
			},
		},
	}

	wrapper := NewPaymentWrapper(server, config)
	handler := func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{}, nil
	}
	wrapped := wrapper.Wrap(handler)

	ctx := context.Background()
	payload := types.PaymentPayload{
		X402Version: 2,
		Payload:     map[string]interface{}{"signature": "0xinvalid"},
	}
	req := makeCallToolRequest(map[string]interface{}{}, mcp.Meta{MCP_PAYMENT_META_KEY: payload})
	result, err := wrapped(ctx, req)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !result.IsError {
		t.Error("Expected error result for verification failure")
	}
}

func TestNewPaymentWrapper_Hooks(t *testing.T) {
	beforeCalled := false
	afterCalled := false
	settlementCalled := false

	mockFacilitator := &mockFacilitatorClient{}
	mockSchemeServer := &mockSchemeNetworkServer{scheme: "cash"}

	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockFacilitator),
		x402.WithSchemeServer("x402:cash", mockSchemeServer),
	)

	ctx := context.Background()
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}

	var beforeHook BeforeExecutionHook = func(context ServerHookContext) (bool, error) {
		beforeCalled = true
		return true, nil
	}
	var afterHook AfterExecutionHook = func(context AfterExecutionContext) error {
		afterCalled = true
		return nil
	}
	var settlementHook AfterSettlementHook = func(context SettlementContext) error {
		settlementCalled = true
		return nil
	}

	config := PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{
				Scheme:  "cash",
				Network: "x402:cash",
				Amount:  "1000",
				PayTo:   "test-recipient",
			},
		},
		Hooks: &PaymentWrapperHooks{
			OnBeforeExecution: &beforeHook,
			OnAfterExecution:  &afterHook,
			OnAfterSettlement: &settlementHook,
		},
	}

	wrapper := NewPaymentWrapper(server, config)
	handler := func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "success"}},
		}, nil
	}
	wrapped := wrapper.Wrap(handler)

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted: types.PaymentRequirements{
			Scheme:  "cash",
			Network: "x402:cash",
			Amount:  "1000",
			PayTo:   "test-recipient",
		},
		Payload: map[string]interface{}{"signature": "~test-payer"},
	}
	req := makeCallToolRequest(map[string]interface{}{"test": "value"}, mcp.Meta{MCP_PAYMENT_META_KEY: payload})
	result, err := wrapped(ctx, req)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if result.IsError {
		t.Error("Expected success result")
	}
	if !beforeCalled {
		t.Error("Expected OnBeforeExecution hook to be called")
	}
	if !afterCalled {
		t.Error("Expected OnAfterExecution hook to be called")
	}
	if !settlementCalled {
		t.Error("Expected OnAfterSettlement hook to be called")
	}
}

func TestNewPaymentWrapper_AbortOnBeforeExecution(t *testing.T) {
	mockFacilitator := &mockFacilitatorClient{}
	mockSchemeServer := &mockSchemeNetworkServer{scheme: "cash"}

	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockFacilitator),
		x402.WithSchemeServer("x402:cash", mockSchemeServer),
	)

	ctx := context.Background()
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}

	var abortHook BeforeExecutionHook = func(context ServerHookContext) (bool, error) {
		return false, nil
	}

	config := PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{
				Scheme:  "cash",
				Network: "x402:cash",
				Amount:  "1000",
				PayTo:   "test-recipient",
			},
		},
		Hooks: &PaymentWrapperHooks{
			OnBeforeExecution: &abortHook,
		},
	}

	wrapper := NewPaymentWrapper(server, config)
	handlerCalled := false
	handler := func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		handlerCalled = true
		return &mcp.CallToolResult{}, nil
	}
	wrapped := wrapper.Wrap(handler)

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted: types.PaymentRequirements{
			Scheme:  "cash",
			Network: "x402:cash",
			Amount:  "1000",
			PayTo:   "test-recipient",
		},
		Payload: map[string]interface{}{"signature": "~test-payer"},
	}
	req := makeCallToolRequest(map[string]interface{}{}, mcp.Meta{MCP_PAYMENT_META_KEY: payload})
	result, err := wrapped(ctx, req)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if handlerCalled {
		t.Error("Handler should not be called when hook aborts")
	}
	if !result.IsError {
		t.Error("Expected error result when hook aborts")
	}
}

func TestNewPaymentWrapper_ToolHandlerError_NoSettlement(t *testing.T) {
	settleCalled := false
	mockFacilitator := &mockFacilitatorClient{
		settleFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			settleCalled = true
			return &x402.SettleResponse{Success: true, Transaction: "tx", Network: "x402:cash", Payer: "p"}, nil
		},
	}
	mockSchemeServer := &mockSchemeNetworkServer{scheme: "cash"}

	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockFacilitator),
		x402.WithSchemeServer("x402:cash", mockSchemeServer),
	)

	ctx := context.Background()
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}

	config := PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		},
	}

	wrapper := NewPaymentWrapper(server, config)
	handler := func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "tool error"}},
			IsError: true,
		}, nil
	}
	wrapped := wrapper.Wrap(handler)

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    types.PaymentRequirements{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		Payload:     map[string]interface{}{"signature": "~test-payer"},
	}
	req := makeCallToolRequest(map[string]interface{}{}, mcp.Meta{MCP_PAYMENT_META_KEY: payload})
	result, err := wrapped(ctx, req)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !result.IsError {
		t.Error("Expected error result from handler")
	}
	if settleCalled {
		t.Error("Settlement should NOT be called when handler returns an error")
	}
}

func TestNewPaymentWrapper_HookErrors_NonFatal(t *testing.T) {
	mockFacilitator := &mockFacilitatorClient{}
	mockSchemeServer := &mockSchemeNetworkServer{scheme: "cash"}

	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockFacilitator),
		x402.WithSchemeServer("x402:cash", mockSchemeServer),
	)

	ctx := context.Background()
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}

	var afterExecHook AfterExecutionHook = func(context AfterExecutionContext) error {
		return fmt.Errorf("after execution hook error")
	}
	var afterSettlementHook AfterSettlementHook = func(context SettlementContext) error {
		return fmt.Errorf("after settlement hook error")
	}

	config := PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		},
		Hooks: &PaymentWrapperHooks{
			OnAfterExecution:  &afterExecHook,
			OnAfterSettlement: &afterSettlementHook,
		},
	}

	wrapper := NewPaymentWrapper(server, config)
	handler := func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "success"}},
		}, nil
	}
	wrapped := wrapper.Wrap(handler)

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    types.PaymentRequirements{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		Payload:     map[string]interface{}{"signature": "~test-payer"},
	}
	req := makeCallToolRequest(map[string]interface{}{}, mcp.Meta{MCP_PAYMENT_META_KEY: payload})
	result, err := wrapped(ctx, req)
	if err != nil {
		t.Fatalf("Hook errors should not propagate, got: %v", err)
	}

	if result.IsError {
		t.Error("Expected success result despite hook errors")
	}

	if result.Meta == nil || result.Meta[MCP_PAYMENT_RESPONSE_META_KEY] == nil {
		t.Error("Expected payment response in meta despite hook errors")
	}
}

func TestNewPaymentWrapper_ExtensionsIncludedIn402(t *testing.T) {
	server := x402.Newx402ResourceServer()

	extensions := map[string]interface{}{
		"bazaar": map[string]interface{}{
			"info": map[string]interface{}{
				"input": map[string]interface{}{
					"type":     "mcp",
					"toolName": "get_weather",
				},
			},
		},
	}

	config := PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		},
		Extensions: extensions,
	}

	wrapper := NewPaymentWrapper(server, config)
	handler := func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{}, nil
	}
	wrapped := wrapper.Wrap(handler)

	ctx := context.Background()
	req := makeCallToolRequest(map[string]interface{}{}, mcp.Meta{})
	result, err := wrapped(ctx, req)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !result.IsError {
		t.Error("Expected error result for missing payment")
	}

	// Verify structuredContent contains extensions.bazaar
	if result.StructuredContent == nil {
		t.Fatal("Expected structuredContent to be set")
	}
	sc, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("Expected structuredContent to be a map, got %T", result.StructuredContent)
	}
	extRaw, ok := sc["extensions"]
	if !ok {
		t.Fatal("Expected 'extensions' key in structuredContent")
	}
	extMap, ok := extRaw.(map[string]interface{})
	if !ok {
		t.Fatalf("Expected extensions to be a map, got %T", extRaw)
	}
	bazaarRaw, ok := extMap["bazaar"]
	if !ok {
		t.Fatal("Expected 'bazaar' key in extensions")
	}
	bazaarMap, ok := bazaarRaw.(map[string]interface{})
	if !ok {
		t.Fatalf("Expected bazaar to be a map, got %T", bazaarRaw)
	}
	infoRaw, ok := bazaarMap["info"]
	if !ok {
		t.Fatal("Expected 'info' key in bazaar extension")
	}
	infoMap, ok := infoRaw.(map[string]interface{})
	if !ok {
		t.Fatalf("Expected info to be a map, got %T", infoRaw)
	}
	inputRaw, ok := infoMap["input"]
	if !ok {
		t.Fatal("Expected 'input' key in bazaar info")
	}
	inputMap, ok := inputRaw.(map[string]interface{})
	if !ok {
		t.Fatalf("Expected input to be a map, got %T", inputRaw)
	}
	if inputMap["toolName"] != "get_weather" {
		t.Errorf("Expected toolName 'get_weather', got '%v'", inputMap["toolName"])
	}
}

func TestNewPaymentWrapper_NilExtensionsOmitted(t *testing.T) {
	server := x402.Newx402ResourceServer()

	config := PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		},
		// Extensions not set (nil)
	}

	wrapper := NewPaymentWrapper(server, config)
	handler := func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{}, nil
	}
	wrapped := wrapper.Wrap(handler)

	ctx := context.Background()
	req := makeCallToolRequest(map[string]interface{}{}, mcp.Meta{})
	result, err := wrapped(ctx, req)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !result.IsError {
		t.Error("Expected error result for missing payment")
	}

	// Verify structuredContent does NOT contain "extensions" key
	if result.StructuredContent == nil {
		t.Fatal("Expected structuredContent to be set")
	}
	sc, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("Expected structuredContent to be a map, got %T", result.StructuredContent)
	}
	if _, ok := sc["extensions"]; ok {
		t.Error("Expected 'extensions' key to be absent when Extensions is nil")
	}
}

func TestNewPaymentWrapper_SettlementFailure(t *testing.T) {
	mockFacilitator := &mockFacilitatorClient{
		settleFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			return nil, fmt.Errorf("settlement failed")
		},
	}
	mockSchemeServer := &mockSchemeNetworkServer{scheme: "cash"}

	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockFacilitator),
		x402.WithSchemeServer("x402:cash", mockSchemeServer),
	)

	ctx := context.Background()
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}

	config := PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{
				Scheme:  "cash",
				Network: "x402:cash",
				Amount:  "1000",
				PayTo:   "test-recipient",
			},
		},
	}

	wrapper := NewPaymentWrapper(server, config)
	handler := func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "success"}},
		}, nil
	}
	wrapped := wrapper.Wrap(handler)

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted: types.PaymentRequirements{
			Scheme:  "cash",
			Network: "x402:cash",
			Amount:  "1000",
			PayTo:   "test-recipient",
		},
		Payload: map[string]interface{}{"signature": "~test-payer"},
	}
	req := makeCallToolRequest(map[string]interface{}{}, mcp.Meta{MCP_PAYMENT_META_KEY: payload})
	result, err := wrapped(ctx, req)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !result.IsError {
		t.Error("Expected error result for settlement failure")
	}
}
