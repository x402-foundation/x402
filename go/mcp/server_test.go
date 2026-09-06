package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/types"
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

func (m *mockSchemeNetworkServer) DefaultAssetTransferMethod() string {
	return x402.SDKDefaultAssetTransferMethod
}

func (m *mockSchemeNetworkServer) PaymentFlows() map[string]x402.PaymentFlowConfig {
	auth := x402.PaymentFlowConfig{
		Supported: []x402.PaymentFlowName{x402.PaymentFlowAuthorization},
		Default:   x402.PaymentFlowAuthorization,
	}
	return map[string]x402.PaymentFlowConfig{
		x402.SDKDefaultAssetTransferMethod: auth,
		"eip3009":                          auth,
		"permit2":                          auth,
	}
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
	mockSchemeServer := &mockSchemeNetworkServer{scheme: "cash"}
	server := x402.Newx402ResourceServer(
		x402.WithSchemeServer("x402:cash", mockSchemeServer),
	)

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
	scheme := &recordingEnricherScheme{mockSchemeNetworkServer: mockSchemeNetworkServer{scheme: "cash"}}

	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockFacilitator),
		x402.WithSchemeServer("x402:cash", scheme),
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
	if scheme.calls < 2 {
		t.Fatalf("expected match + abort enricher calls, got %d", scheme.calls)
	}
	if scheme.lastPayload != nil {
		t.Fatal("hook-abort 402 must not pass the payment payload to enrichers")
	}
}

func TestNewPaymentWrapper_BeforeExecutionHookError_OmitsPayload(t *testing.T) {
	mockFacilitator := &mockFacilitatorClient{}
	scheme := &recordingEnricherScheme{mockSchemeNetworkServer: mockSchemeNetworkServer{scheme: "cash"}}

	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockFacilitator),
		x402.WithSchemeServer("x402:cash", scheme),
	)

	ctx := context.Background()
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}

	var errHook BeforeExecutionHook = func(context ServerHookContext) (bool, error) {
		return false, fmt.Errorf("hook boom")
	}

	config := PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		},
		Hooks: &PaymentWrapperHooks{
			OnBeforeExecution: &errHook,
		},
	}

	wrapper := NewPaymentWrapper(server, config)
	wrapped := wrapper.Wrap(func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		t.Fatal("handler should not run")
		return &mcp.CallToolResult{}, nil
	})

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    types.PaymentRequirements{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		Payload:     map[string]interface{}{"signature": "~test-payer"},
	}
	result, err := wrapped(ctx, makeCallToolRequest(nil, mcp.Meta{MCP_PAYMENT_META_KEY: payload}))
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if !result.IsError {
		t.Fatal("expected error result when before-execution hook errors")
	}
	if scheme.calls < 2 {
		t.Fatalf("expected match + hook-error enricher calls, got %d", scheme.calls)
	}
	if scheme.lastPayload != nil {
		t.Fatal("hook-error 402 must not pass the payment payload to enrichers")
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

func TestNewPaymentWrapper_OnAfterExecution_OnHandlerIsError(t *testing.T) {
	afterCalled := false
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

	var afterHook AfterExecutionHook = func(context AfterExecutionContext) error {
		afterCalled = true
		if !context.Result.IsError {
			t.Error("OnAfterExecution should see the handler IsError result")
		}
		return nil
	}

	config := PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		},
		Hooks: &PaymentWrapperHooks{
			OnAfterExecution: &afterHook,
		},
	}

	wrapper := NewPaymentWrapper(server, config)
	wrapped := wrapper.Wrap(func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "tool error"}},
			IsError: true,
		}, nil
	})

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    types.PaymentRequirements{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		Payload:     map[string]interface{}{"signature": "~test-payer"},
	}
	result, err := wrapped(ctx, makeCallToolRequest(nil, mcp.Meta{MCP_PAYMENT_META_KEY: payload}))
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if !result.IsError {
		t.Fatal("expected error result from handler")
	}
	if !afterCalled {
		t.Fatal("expected OnAfterExecution to run when handler returns IsError")
	}
}

func TestNewPaymentWrapper_OnAfterExecution_SkippedOnHandlerThrow(t *testing.T) {
	afterCalled := false
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

	var afterHook AfterExecutionHook = func(context AfterExecutionContext) error {
		afterCalled = true
		return nil
	}

	config := PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		},
		Hooks: &PaymentWrapperHooks{
			OnAfterExecution: &afterHook,
		},
	}

	wrapper := NewPaymentWrapper(server, config)
	wrapped := wrapper.Wrap(func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return nil, fmt.Errorf("boom")
	})

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    types.PaymentRequirements{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		Payload:     map[string]interface{}{"signature": "~test-payer"},
	}
	_, _ = wrapped(ctx, makeCallToolRequest(nil, mcp.Meta{MCP_PAYMENT_META_KEY: payload}))
	if afterCalled {
		t.Fatal("OnAfterExecution must not run when the handler returns a Go error")
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
	mockSchemeServer := &mockSchemeNetworkServer{scheme: "cash"}
	server := x402.Newx402ResourceServer(
		x402.WithSchemeServer("x402:cash", mockSchemeServer),
	)

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
	mockSchemeServer := &mockSchemeNetworkServer{scheme: "cash"}
	server := x402.Newx402ResourceServer(
		x402.WithSchemeServer("x402:cash", mockSchemeServer),
	)

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

func TestNewPaymentWrapper_MatchesNonFirstAccept(t *testing.T) {
	var verifiedReq types.PaymentRequirements
	mockFacilitator := &mockFacilitatorClient{
		verifyFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
			_ = json.Unmarshal(requirementsBytes, &verifiedReq)
			return &x402.VerifyResponse{IsValid: true, Payer: "test-payer"}, nil
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

	first := types.PaymentRequirements{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "recipient-A"}
	second := types.PaymentRequirements{Scheme: "cash", Network: "x402:cash", Amount: "2000", PayTo: "recipient-B"}

	config := PaymentWrapperConfig{Accepts: []types.PaymentRequirements{first, second}}
	wrapper := NewPaymentWrapper(server, config)
	handler := func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "success"}},
		}, nil
	}
	wrapped := wrapper.Wrap(handler)

	// Client paid the SECOND requirement, not accepts[0].
	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    second,
		Payload:     map[string]interface{}{"signature": "~test-payer"},
	}
	req := makeCallToolRequest(map[string]interface{}{}, mcp.Meta{MCP_PAYMENT_META_KEY: payload})
	result, err := wrapped(ctx, req)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if result.IsError {
		t.Error("Expected success result when payload matches a non-first accept")
	}
	if verifiedReq.PayTo != "recipient-B" || verifiedReq.Amount != "2000" {
		t.Errorf("Expected verification against the matched (second) accept, got payTo=%q amount=%q",
			verifiedReq.PayTo, verifiedReq.Amount)
	}
}

func TestNewPaymentWrapper_NoMatchingAccept(t *testing.T) {
	verifyCalled := false
	mockFacilitator := &mockFacilitatorClient{
		verifyFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
			verifyCalled = true
			return &x402.VerifyResponse{IsValid: true, Payer: "test-payer"}, nil
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
			{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "recipient-A"},
		},
	}
	wrapper := NewPaymentWrapper(server, config)
	handler := func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{}, nil
	}
	wrapped := wrapper.Wrap(handler)

	// Payload requirement matches none of the advertised accepts.
	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    types.PaymentRequirements{Scheme: "cash", Network: "x402:cash", Amount: "9999", PayTo: "recipient-Z"},
		Payload:     map[string]interface{}{"signature": "~test-payer"},
	}
	req := makeCallToolRequest(map[string]interface{}{}, mcp.Meta{MCP_PAYMENT_META_KEY: payload})
	result, err := wrapped(ctx, req)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !result.IsError {
		t.Error("Expected error result when no accept matches the payload")
	}
	if verifyCalled {
		t.Error("Verification should not run when no accept matches")
	}
	sc, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("Expected structuredContent to be a map, got %T", result.StructuredContent)
	}
	if errMsg, _ := sc["error"].(string); !strings.Contains(errMsg, "No matching payment requirements") {
		t.Errorf("Expected a no-match error message, got %q", errMsg)
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

// mockEscrowScheme defaults to escrow so before-handler settle runs.
type mockEscrowScheme struct {
	mockSchemeNetworkServer
	settleOnCancel func(ctx x402.VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error)
}

func (m *mockEscrowScheme) PaymentFlows() map[string]x402.PaymentFlowConfig {
	escrow := x402.PaymentFlowConfig{
		Supported: []x402.PaymentFlowName{x402.PaymentFlowEscrow},
		Default:   x402.PaymentFlowEscrow,
	}
	return map[string]x402.PaymentFlowConfig{
		x402.SDKDefaultAssetTransferMethod: escrow,
	}
}

func (m *mockEscrowScheme) SettleOnCancel(ctx x402.VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error) {
	if m.settleOnCancel != nil {
		return m.settleOnCancel(ctx)
	}
	return nil, nil
}

// recordingEnricherScheme records the payload passed to 402 enrichers without
// mutating Extra (so matching still succeeds).
type recordingEnricherScheme struct {
	mockSchemeNetworkServer
	calls       int
	lastPayload *types.PaymentPayload
}

func (m *recordingEnricherScheme) EnrichPaymentRequiredResponse(ctx x402.PaymentRequiredContext) {
	m.calls++
	m.lastPayload = ctx.PaymentPayload
}

// mockEnricherScheme records EnrichPaymentRequiredResponse for 402 path tests.
type mockEnricherScheme struct {
	mockSchemeNetworkServer
	calls       int
	lastPayload *types.PaymentPayload
}

func (m *mockEnricherScheme) EnrichPaymentRequiredResponse(ctx x402.PaymentRequiredContext) {
	m.calls++
	m.lastPayload = ctx.PaymentPayload
	for i := range ctx.Requirements {
		if ctx.Requirements[i].Extra == nil {
			ctx.Requirements[i].Extra = map[string]interface{}{}
		}
		ctx.Requirements[i].Extra["EnrichedBy"] = "mcp-enricher"
	}
}

// mockPayToEnricherScheme fills vacant payTo during 402 enrichment (match-path test).
type mockPayToEnricherScheme struct {
	mockSchemeNetworkServer
}

func (m *mockPayToEnricherScheme) EnrichPaymentRequiredResponse(ctx x402.PaymentRequiredContext) {
	for i := range ctx.Requirements {
		if x402.IsVacantStringField(ctx.Requirements[i].PayTo) {
			ctx.Requirements[i].PayTo = "enriched-recipient"
		}
	}
}

func TestPaymentWrapper_MatchesEnrichedAccept(t *testing.T) {
	verifyCalled := false
	mockFacilitator := &mockFacilitatorClient{
		verifyFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
			verifyCalled = true
			var reqs types.PaymentRequirements
			_ = json.Unmarshal(requirementsBytes, &reqs)
			if reqs.PayTo != "enriched-recipient" {
				t.Fatalf("expected verify against enriched payTo, got %q", reqs.PayTo)
			}
			return &x402.VerifyResponse{IsValid: true, Payer: "test-payer"}, nil
		},
	}
	scheme := &mockPayToEnricherScheme{mockSchemeNetworkServer: mockSchemeNetworkServer{scheme: "cash"}}
	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockFacilitator),
		x402.WithSchemeServer("x402:cash", scheme),
	)
	ctx := context.Background()
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	originalPayTo := ""
	config := PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: originalPayTo},
		},
	}
	wrapper := NewPaymentWrapper(server, config)
	wrapped := wrapper.Wrap(func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "ok"}}}, nil
	})

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    types.PaymentRequirements{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "enriched-recipient"},
		Payload:     map[string]interface{}{"signature": "~test-payer"},
	}
	result, err := wrapped(ctx, makeCallToolRequest(nil, mcp.Meta{MCP_PAYMENT_META_KEY: payload}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.IsError {
		t.Fatal("expected success when payload matches enriched accept")
	}
	if !verifyCalled {
		t.Fatal("expected facilitator verify after enriched match")
	}
	if config.Accepts[0].PayTo != originalPayTo {
		t.Fatalf("config.Accepts must not be mutated by match path, got payTo=%q", config.Accepts[0].PayTo)
	}
}

func TestPaymentWrapper_ExtensionEchoMismatchSkipsVerify(t *testing.T) {
	verifyCalled := false
	mockFacilitator := &mockFacilitatorClient{
		verifyFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
			verifyCalled = true
			return &x402.VerifyResponse{IsValid: true, Payer: "test-payer"}, nil
		},
	}
	scheme := &mockSchemeNetworkServer{scheme: "cash"}
	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockFacilitator),
		x402.WithSchemeServer("x402:cash", scheme),
	)
	ctx := context.Background()
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	extensions := map[string]interface{}{
		"bazaar": map[string]interface{}{"info": map[string]interface{}{"tool": "search", "version": 1}},
	}
	config := PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		},
		Extensions: extensions,
	}
	wrapper := NewPaymentWrapper(server, config)
	wrapped := wrapper.Wrap(func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{}, nil
	})

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    types.PaymentRequirements{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		Payload:     map[string]interface{}{"signature": "~test-payer"},
		Extensions: map[string]interface{}{
			"bazaar": map[string]interface{}{"info": map[string]interface{}{"tool": "search", "version": 2}},
		},
	}
	result, err := wrapped(ctx, makeCallToolRequest(nil, mcp.Meta{MCP_PAYMENT_META_KEY: payload}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Fatal("expected error result for extension echo mismatch")
	}
	if verifyCalled {
		t.Fatal("verify must not run on extension echo mismatch")
	}
	sc, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structuredContent map, got %T", result.StructuredContent)
	}
	if errMsg, _ := sc["error"].(string); errMsg != "extension_echo_mismatch" {
		t.Fatalf("expected extension_echo_mismatch error, got %q", errMsg)
	}
}

func TestPaymentWrapper_CancelOnHandlerIsError(t *testing.T) {
	var cancelCalled bool
	var settlePhases []x402.SettlePhase
	mockFacilitator := &mockFacilitatorClient{
		settleFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			return &x402.SettleResponse{
				Success: true, Transaction: "0xdeposit", Amount: "1000", Network: "x402:cash", Payer: "p",
			}, nil
		},
	}
	scheme := &mockEscrowScheme{mockSchemeNetworkServer: mockSchemeNetworkServer{scheme: "cash"}}
	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockFacilitator),
		x402.WithSchemeServer("x402:cash", scheme),
	)
	ctx := context.Background()
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	server.OnVerifiedPaymentCanceled(func(c x402.VerifiedPaymentCanceledContext) error {
		cancelCalled = true
		settlePhases = append([]x402.SettlePhase(nil), c.SettledPhases...)
		return nil
	})

	wrapper := NewPaymentWrapper(server, PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		},
	})
	wrapped := wrapper.Wrap(func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "tool failed"}},
			IsError: true,
		}, nil
	})

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    types.PaymentRequirements{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		Payload:     map[string]interface{}{"signature": "~test-payer"},
	}
	result, err := wrapped(ctx, makeCallToolRequest(nil, mcp.Meta{MCP_PAYMENT_META_KEY: payload}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Fatal("expected IsError result")
	}
	if !cancelCalled {
		t.Fatal("expected OnVerifiedPaymentCanceled to run")
	}
	if len(settlePhases) != 1 || settlePhases[0] != x402.SettlePhaseBeforeHandler {
		t.Fatalf("expected before-handler settledPhases, got %#v", settlePhases)
	}
	resp, ok := result.Meta[MCP_PAYMENT_RESPONSE_META_KEY].(*x402.SettleResponse)
	if !ok || resp == nil || resp.Transaction != "0xdeposit" {
		t.Fatalf("expected deposit echo in meta, got %#v", result.Meta[MCP_PAYMENT_RESPONSE_META_KEY])
	}
}

func TestPaymentWrapper_CancelOnHandlerThrow(t *testing.T) {
	var cancelReason x402.VerifiedPaymentCancellationReason
	mockFacilitator := &mockFacilitatorClient{
		settleFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			return &x402.SettleResponse{
				Success: true, Transaction: "0xdeposit", Amount: "1000", Network: "x402:cash", Payer: "p",
			}, nil
		},
	}
	scheme := &mockEscrowScheme{mockSchemeNetworkServer: mockSchemeNetworkServer{scheme: "cash"}}
	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockFacilitator),
		x402.WithSchemeServer("x402:cash", scheme),
	)
	ctx := context.Background()
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	server.OnVerifiedPaymentCanceled(func(c x402.VerifiedPaymentCanceledContext) error {
		cancelReason = c.Reason
		return nil
	})

	wrapper := NewPaymentWrapper(server, PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		},
	})
	wrapped := wrapper.Wrap(func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return nil, fmt.Errorf("boom")
	})

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    types.PaymentRequirements{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		Payload:     map[string]interface{}{"signature": "~test-payer"},
	}
	result, err := wrapped(ctx, makeCallToolRequest(nil, mcp.Meta{MCP_PAYMENT_META_KEY: payload}))
	if err != nil {
		t.Fatalf("expected internalized error result, got err=%v", err)
	}
	if !result.IsError {
		t.Fatal("expected IsError internal result")
	}
	if cancelReason != x402.CancellationReasonHandlerThrew {
		t.Fatalf("expected handler_threw, got %q", cancelReason)
	}
	resp, ok := result.Meta[MCP_PAYMENT_RESPONSE_META_KEY].(*x402.SettleResponse)
	if !ok || resp == nil || resp.Transaction != "0xdeposit" {
		t.Fatalf("expected deposit receipt in meta, got %#v", result.Meta[MCP_PAYMENT_RESPONSE_META_KEY])
	}
}

func TestPaymentWrapper_SettleOnCancelPrefersCancelReceipt(t *testing.T) {
	var settleCalls int
	mockFacilitator := &mockFacilitatorClient{
		settleFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			settleCalls++
			var reqs types.PaymentRequirements
			_ = json.Unmarshal(requirementsBytes, &reqs)
			tx := "0xdeposit"
			if reqs.Amount == "0" {
				tx = "0xrefund"
			}
			return &x402.SettleResponse{
				Success: true, Transaction: tx, Amount: reqs.Amount, Network: "x402:cash", Payer: "p",
			}, nil
		},
	}
	scheme := &mockEscrowScheme{
		mockSchemeNetworkServer: mockSchemeNetworkServer{scheme: "cash"},
		settleOnCancel: func(c x402.VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error) {
			reqs := c.Requirements.(types.PaymentRequirements)
			reqs.Amount = "0"
			return &reqs, nil
		},
	}
	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockFacilitator),
		x402.WithSchemeServer("x402:cash", scheme),
	)
	ctx := context.Background()
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	wrapper := NewPaymentWrapper(server, PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		},
	})
	wrapped := wrapper.Wrap(func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "fail"}}}, nil
	})

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    types.PaymentRequirements{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		Payload:     map[string]interface{}{"signature": "~test-payer", "channelId": "ch-1"},
	}
	result, err := wrapped(ctx, makeCallToolRequest(nil, mcp.Meta{MCP_PAYMENT_META_KEY: payload}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if settleCalls != 2 {
		t.Fatalf("expected before-handler + cancel settle, got %d", settleCalls)
	}
	resp, ok := result.Meta[MCP_PAYMENT_RESPONSE_META_KEY].(*x402.SettleResponse)
	if !ok || resp == nil || resp.Transaction != "0xrefund" {
		t.Fatalf("expected cancel receipt preferred in meta, got %#v", result.Meta[MCP_PAYMENT_RESPONSE_META_KEY])
	}
}

func TestPaymentWrapper_FailedCancelIncludesDepositRecovery(t *testing.T) {
	mockFacilitator := &mockFacilitatorClient{
		settleFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			var reqs types.PaymentRequirements
			_ = json.Unmarshal(requirementsBytes, &reqs)
			if reqs.Amount == "0" {
				return &x402.SettleResponse{
					Success: false, ErrorReason: "refund_failed", Transaction: "should-clear", Network: "x402:cash",
				}, nil
			}
			return &x402.SettleResponse{
				Success: true, Transaction: "0xdeposit", Amount: "1000", Network: "x402:cash", Payer: "p",
			}, nil
		},
	}
	scheme := &mockEscrowScheme{
		mockSchemeNetworkServer: mockSchemeNetworkServer{scheme: "cash"},
		settleOnCancel: func(c x402.VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error) {
			reqs := c.Requirements.(types.PaymentRequirements)
			reqs.Amount = "0"
			return &reqs, nil
		},
	}
	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockFacilitator),
		x402.WithSchemeServer("x402:cash", scheme),
	)
	ctx := context.Background()
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	wrapper := NewPaymentWrapper(server, PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		},
	})
	wrapped := wrapper.Wrap(func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{IsError: true}, nil
	})

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    types.PaymentRequirements{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		Payload:     map[string]interface{}{"signature": "~test-payer", "channelId": "channel-123"},
	}
	result, err := wrapped(ctx, makeCallToolRequest(nil, mcp.Meta{MCP_PAYMENT_META_KEY: payload}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp, ok := result.Meta[MCP_PAYMENT_RESPONSE_META_KEY].(*x402.SettleResponse)
	if !ok || resp == nil {
		t.Fatalf("expected failure-path receipt, got %#v", result.Meta[MCP_PAYMENT_RESPONSE_META_KEY])
	}
	if resp.Success || resp.Transaction != "" {
		t.Fatalf("expected failed cancel receipt, got %+v", resp)
	}
	if resp.Extra["depositTransaction"] != "0xdeposit" {
		t.Fatalf("expected depositTransaction, got %#v", resp.Extra)
	}
	if resp.Extra["depositAmount"] != "1000" {
		t.Fatalf("expected depositAmount, got %#v", resp.Extra)
	}
	if resp.Extra["channelId"] != "channel-123" {
		t.Fatalf("expected channelId, got %#v", resp.Extra)
	}
}

func TestPaymentWrapper_SkipHandlerSettlesWithoutTool(t *testing.T) {
	handlerCalled := false
	settleCalled := false
	mockFacilitator := &mockFacilitatorClient{
		settleFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			settleCalled = true
			return &x402.SettleResponse{Success: true, Transaction: "0xskip", Network: "x402:cash", Payer: "p"}, nil
		},
	}
	scheme := &mockSchemeNetworkServer{scheme: "cash"}
	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockFacilitator),
		x402.WithSchemeServer("x402:cash", scheme),
	)
	ctx := context.Background()
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	server.OnAfterVerify(func(c x402.VerifyResultContext) (*x402.AfterVerifyResult, error) {
		return &x402.AfterVerifyResult{
			SkipHandler: true,
			Response: &x402.SkipHandlerDirective{
				Body: map[string]interface{}{"refunded": true},
			},
		}, nil
	})

	wrapper := NewPaymentWrapper(server, PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		},
	})
	wrapped := wrapper.Wrap(func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		handlerCalled = true
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "should not run"}}}, nil
	})

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    types.PaymentRequirements{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		Payload:     map[string]interface{}{"signature": "~test-payer"},
	}
	result, err := wrapped(ctx, makeCallToolRequest(nil, mcp.Meta{MCP_PAYMENT_META_KEY: payload}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if handlerCalled {
		t.Fatal("tool handler should not run on SkipHandler")
	}
	if !settleCalled {
		t.Fatal("expected after-handler settle for SkipHandler")
	}
	if result.IsError {
		t.Fatal("expected success skip result")
	}
	sc, ok := result.StructuredContent.(map[string]interface{})
	if !ok || sc["refunded"] != true {
		t.Fatalf("expected structured skip body, got %#v", result.StructuredContent)
	}
	resp, ok := result.Meta[MCP_PAYMENT_RESPONSE_META_KEY].(*x402.SettleResponse)
	if !ok || resp == nil || resp.Transaction != "0xskip" {
		t.Fatalf("expected settlement in meta, got %#v", result.Meta[MCP_PAYMENT_RESPONSE_META_KEY])
	}
}

func TestPaymentWrapper_CreatePaymentRequiredResponseEnricher(t *testing.T) {
	scheme := &mockEnricherScheme{mockSchemeNetworkServer: mockSchemeNetworkServer{scheme: "cash"}}
	server := x402.Newx402ResourceServer(
		x402.WithSchemeServer("x402:cash", scheme),
	)

	wrapper := NewPaymentWrapper(server, PaymentWrapperConfig{
		Accepts: []types.PaymentRequirements{
			{Scheme: "cash", Network: "x402:cash", Amount: "1000", PayTo: "test-recipient"},
		},
	})
	wrapped := wrapper.Wrap(func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{}, nil
	})

	ctx := context.Background()
	req := makeCallToolRequest(nil, mcp.Meta{})
	req.Params.Name = "get_weather"
	result, err := wrapped(ctx, req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Fatal("expected payment required error")
	}
	if scheme.calls != 1 {
		t.Fatalf("expected enricher call, got %d", scheme.calls)
	}
	sc, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structuredContent map, got %T", result.StructuredContent)
	}
	resource, _ := sc["resource"].(map[string]interface{})
	if resource["url"] != "mcp://tool/get_weather" {
		t.Fatalf("expected tool resource url, got %#v", resource)
	}
	accepts, _ := sc["accepts"].([]interface{})
	if len(accepts) == 0 {
		t.Fatal("expected accepts in structured content")
	}
	first, _ := accepts[0].(map[string]interface{})
	extra, _ := first["extra"].(map[string]interface{})
	if extra["EnrichedBy"] != "mcp-enricher" {
		t.Fatalf("expected enricher mutation, got %#v", extra)
	}
}
