package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/types"
)

// mockMCPCaller implements MCPCaller for testing.
type mockMCPCaller struct {
	callToolResult  MCPToolResult
	callToolError   error
	callToolResults []MCPToolResult // For multi-call scenarios
	callToolErrors  []error         // For multi-call scenarios
	callCount       int
}

func (m *mockMCPCaller) CallTool(ctx context.Context, params *mcp.CallToolParams) (*mcp.CallToolResult, error) {
	var mcpResult MCPToolResult
	if len(m.callToolResults) > 0 {
		idx := m.callCount
		m.callCount++
		if idx < len(m.callToolResults) {
			var err error
			if idx < len(m.callToolErrors) {
				err = m.callToolErrors[idx]
			}
			mcpResult = m.callToolResults[idx]
			return mcpToolResultToCallToolResult(mcpResult), err
		}
	}
	mcpResult = m.callToolResult
	return mcpToolResultToCallToolResult(mcpResult), m.callToolError
}

// mcpToolResultToCallToolResult converts MCPToolResult to *mcp.CallToolResult for the mock.
func mcpToolResultToCallToolResult(r MCPToolResult) *mcp.CallToolResult {
	content := make([]mcp.Content, 0, len(r.Content))
	for _, item := range r.Content {
		content = append(content, &mcp.TextContent{Text: item.Text})
	}
	result := &mcp.CallToolResult{
		Content: content,
		IsError: r.IsError,
	}
	if len(r.Meta) > 0 {
		result.Meta = mcp.Meta{}
		for k, v := range r.Meta {
			result.Meta[k] = v
		}
	}
	if r.StructuredContent != nil {
		result.StructuredContent = r.StructuredContent
	}
	return result
}

func TestX402MCPClient_CallTool_FreeTool(t *testing.T) {
	mockMCPCaller := &mockMCPCaller{
		callToolResult: MCPToolResult{
			Content: []MCPContentItem{
				{Type: "text", Text: "pong"},
			},
			IsError: false,
		},
	}

	paymentClient := x402.Newx402Client()
	x402Client := NewX402MCPClient(mockMCPCaller, paymentClient, Options{})

	ctx := context.Background()
	result, err := x402Client.CallTool(ctx, "ping", map[string]interface{}{})
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if result.PaymentMade {
		t.Error("Expected no payment for free tool")
	}
	if len(result.Content) == 0 {
		t.Error("Expected content")
	}
}

func TestX402MCPClient_CallTool_PaymentRequired(t *testing.T) {
	paymentRequired := types.PaymentRequired{
		X402Version: 2,
		Accepts: []types.PaymentRequirements{
			{
				Scheme:            "exact",
				Network:           "eip155:84532",
				Amount:            "1000",
				Asset:             "USDC",
				PayTo:             "0xrecipient",
				MaxTimeoutSeconds: 300,
			},
		},
	}

	// Create result with payment required
	structuredBytes, _ := json.Marshal(paymentRequired)
	var structuredContent map[string]interface{}
	if err := json.Unmarshal(structuredBytes, &structuredContent); err != nil {
		t.Fatalf("Failed to unmarshal structured content: %v", err)
	}

	mockMCPCaller := &mockMCPCaller{
		callToolResult: MCPToolResult{
			IsError:           true,
			StructuredContent: structuredContent,
		},
	}

	paymentClient := x402.Newx402Client()
	// Register a mock scheme client so SelectPaymentRequirements doesn't fail
	mockSchemeClient := &mockSchemeNetworkClient{scheme: "exact"}
	paymentClient.Register("eip155:84532", mockSchemeClient)

	x402Client := NewX402MCPClient(mockMCPCaller, paymentClient, Options{
		AutoPayment: BoolPtr(false),
	})

	ctx := context.Background()
	_, err := x402Client.CallTool(ctx, "paid_tool", map[string]interface{}{})
	if err == nil {
		t.Fatal("Expected error for payment required")
	}

	// Check if error is PaymentRequiredError (may be wrapped)
	var paymentErr *PaymentRequiredError
	if !errors.As(err, &paymentErr) {
		t.Fatalf("Expected PaymentRequiredError, got %T: %v", err, err)
	}
	if paymentErr.Code != MCP_PAYMENT_REQUIRED_CODE {
		t.Errorf("Expected code %d, got %d", MCP_PAYMENT_REQUIRED_CODE, paymentErr.Code)
	}
}

// ============================================================================
// Factory Function Tests
// ============================================================================

func TestNewX402MCPClientFromConfig(t *testing.T) {
	mockMCPCaller := &mockMCPCaller{
		callToolResult: MCPToolResult{
			Content: []MCPContentItem{
				{Type: "text", Text: "pong"},
			},
			IsError: false,
		},
	}

	// Create a mock scheme client that implements SchemeNetworkClient
	mockSchemeClient := &mockSchemeNetworkClient{scheme: "exact"}

	x402Mcp := NewX402MCPClientFromConfig(mockMCPCaller, []SchemeRegistration{
		{Network: "eip155:84532", Client: mockSchemeClient},
	}, Options{
		AutoPayment: BoolPtr(true),
	})

	if x402Mcp == nil {
		t.Fatal("Expected non-nil client")
	}
	if x402Mcp.Client() != mockMCPCaller {
		t.Error("Expected client to wrap mockMCPCaller")
	}
}

// Mock scheme network client for testing
type mockSchemeNetworkClient struct {
	scheme string
}

func (m *mockSchemeNetworkClient) Scheme() string {
	return m.scheme
}

func (m *mockSchemeNetworkClient) CreatePaymentPayload(ctx context.Context, requirements types.PaymentRequirements) (types.PaymentPayload, error) {
	return types.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     map[string]interface{}{"signature": "0xmock"},
	}, nil
}

// ============================================================================
// Hook Tests
// ============================================================================

func TestX402MCPClient_Hooks(t *testing.T) {
	mockMCPCaller := &mockMCPCaller{
		callToolResult: MCPToolResult{
			Content: []MCPContentItem{
				{Type: "text", Text: "pong"},
			},
			IsError: false,
		},
	}

	paymentClient := x402.Newx402Client()
	x402Client := NewX402MCPClient(mockMCPCaller, paymentClient, Options{})

	// Test hook registration returns self for chaining
	result := x402Client.OnPaymentRequired(func(context PaymentRequiredContext) (*PaymentRequiredHookResult, error) {
		return nil, nil
	})

	if result != x402Client {
		t.Error("Expected OnPaymentRequired to return self for chaining")
	}

	result = x402Client.OnBeforePayment(func(context PaymentRequiredContext) error {
		return nil
	})

	if result != x402Client {
		t.Error("Expected OnBeforePayment to return self for chaining")
	}

	result = x402Client.OnAfterPayment(func(context AfterPaymentContext) error {
		return nil
	})

	if result != x402Client {
		t.Error("Expected OnAfterPayment to return self for chaining")
	}
}

// ============================================================================
// Missing Coverage Tests
// ============================================================================

func TestX402MCPClient_PaymentClient(t *testing.T) {
	mockMCPCaller := &mockMCPCaller{}
	paymentClient := x402.Newx402Client()
	x402Client := NewX402MCPClient(mockMCPCaller, paymentClient, Options{})

	if x402Client.PaymentClient() != paymentClient {
		t.Error("Expected PaymentClient() to return the underlying payment client")
	}
}

func TestX402MCPClient_CallToolWithPayment(t *testing.T) {
	mockSettleResponse := &x402.SettleResponse{
		Success:     true,
		Transaction: "0xtxhash123",
		Network:     "eip155:84532",
	}

	mockMCPCaller := &mockMCPCaller{
		callToolResult: MCPToolResult{
			Content: []MCPContentItem{
				{Type: "text", Text: "success"},
			},
			IsError: false,
			Meta: map[string]interface{}{
				MCP_PAYMENT_RESPONSE_META_KEY: map[string]interface{}{
					"success":     true,
					"transaction": "0xtxhash123",
					"network":     "eip155:84532",
				},
			},
		},
	}

	paymentClient := x402.Newx402Client()
	x402Client := NewX402MCPClient(mockMCPCaller, paymentClient, Options{})

	payload := types.PaymentPayload{
		X402Version: 2,
		Payload: map[string]interface{}{
			"signature": "0x123",
		},
	}

	ctx := context.Background()
	result, err := x402Client.CallToolWithPayment(ctx, "paid_tool", map[string]interface{}{"arg": "value"}, payload)

	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if result == nil {
		t.Fatal("Expected non-nil result")
	}

	if !result.PaymentMade {
		t.Error("Expected PaymentMade to be true")
	}

	if result.PaymentResponse == nil {
		t.Fatal("Expected PaymentResponse to be set")
	}

	if result.PaymentResponse.Transaction != mockSettleResponse.Transaction {
		t.Errorf("Expected transaction %s, got %s", mockSettleResponse.Transaction, result.PaymentResponse.Transaction)
	}
}

func TestX402MCPClient_CallToolWithPayment_AfterPaymentHook(t *testing.T) {
	mockMCPCaller := &mockMCPCaller{
		callToolResult: MCPToolResult{
			Content: []MCPContentItem{
				{Type: "text", Text: "success"},
			},
			IsError: false,
			Meta: map[string]interface{}{
				MCP_PAYMENT_RESPONSE_META_KEY: map[string]interface{}{
					"success":     true,
					"transaction": "0xtxhash123",
					"network":     "eip155:84532",
				},
			},
		},
	}

	paymentClient := x402.Newx402Client()
	x402Client := NewX402MCPClient(mockMCPCaller, paymentClient, Options{})

	hookCalled := false
	x402Client.OnAfterPayment(func(context AfterPaymentContext) error {
		hookCalled = true
		if context.ToolName != "paid_tool" {
			t.Errorf("Expected tool name 'paid_tool', got '%s'", context.ToolName)
		}
		if context.SettleResponse == nil {
			t.Error("Expected SettleResponse to be set in hook context")
		}
		return nil
	})

	payload := types.PaymentPayload{
		X402Version: 2,
		Payload: map[string]interface{}{
			"signature": "0x123",
		},
	}

	ctx := context.Background()
	_, err := x402Client.CallToolWithPayment(ctx, "paid_tool", map[string]interface{}{}, payload)

	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !hookCalled {
		t.Error("Expected after payment hook to be called")
	}
}

func TestX402MCPClient_GetToolPaymentRequirements(t *testing.T) {
	paymentRequired := types.PaymentRequired{
		X402Version: 2,
		Accepts: []types.PaymentRequirements{
			{
				Scheme:  "exact",
				Network: "eip155:84532",
				Amount:  "1000",
				Asset:   "USDC",
				PayTo:   "0xrecipient",
			},
		},
	}

	paymentRequiredBytes, _ := json.Marshal(paymentRequired)

	mockMCPCaller := &mockMCPCaller{
		callToolResult: MCPToolResult{
			Content: []MCPContentItem{
				{Type: "text", Text: string(paymentRequiredBytes)},
			},
			IsError: true,
			StructuredContent: map[string]interface{}{
				"x402Version": 2,
				"accepts": []interface{}{
					map[string]interface{}{
						"scheme":  "exact",
						"network": "eip155:84532",
						"amount":  "1000",
						"asset":   "USDC",
						"payTo":   "0xrecipient",
					},
				},
			},
		},
	}

	paymentClient := x402.Newx402Client()
	x402Client := NewX402MCPClient(mockMCPCaller, paymentClient, Options{})

	ctx := context.Background()
	result, err := x402Client.GetToolPaymentRequirements(ctx, "paid_tool", map[string]interface{}{})

	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if result == nil {
		t.Fatal("Expected non-nil PaymentRequired")
	}

	if result.X402Version != paymentRequired.X402Version {
		t.Errorf("Expected x402Version %d, got %d", paymentRequired.X402Version, result.X402Version)
	}

	if len(result.Accepts) != 1 {
		t.Errorf("Expected 1 accept, got %d", len(result.Accepts))
	}
}

// ============================================================================
// Auto-Payment End-to-End Tests
// ============================================================================

func TestX402MCPClient_CallTool_AutoPaymentE2E(t *testing.T) {
	// First call returns 402 payment required, second call returns success
	paymentRequired := types.PaymentRequired{
		X402Version: 2,
		Accepts: []types.PaymentRequirements{
			{
				Scheme:            "exact",
				Network:           "eip155:84532",
				Amount:            "1000",
				Asset:             "USDC",
				PayTo:             "0xrecipient",
				MaxTimeoutSeconds: 300,
			},
		},
	}

	structuredBytes, _ := json.Marshal(paymentRequired)
	var structuredContent map[string]interface{}
	if err := json.Unmarshal(structuredBytes, &structuredContent); err != nil {
		t.Fatalf("Failed to unmarshal structured content: %v", err)
	}

	mockMCPCaller := &mockMCPCaller{
		callToolResults: []MCPToolResult{
			{
				IsError:           true,
				StructuredContent: structuredContent,
				Content: []MCPContentItem{
					{Type: "text", Text: string(structuredBytes)},
				},
			},
			{
				Content: []MCPContentItem{
					{Type: "text", Text: "success"},
				},
				IsError: false,
				Meta: map[string]interface{}{
					MCP_PAYMENT_RESPONSE_META_KEY: map[string]interface{}{
						"success":     true,
						"transaction": "0xtxhash",
						"network":     "eip155:84532",
					},
				},
			},
		},
	}

	paymentClient := x402.Newx402Client()
	mockSchemeClient := &mockSchemeNetworkClient{scheme: "exact"}
	paymentClient.Register("eip155:84532", mockSchemeClient)

	x402Client := NewX402MCPClient(mockMCPCaller, paymentClient, Options{
		AutoPayment: BoolPtr(true),
	})

	ctx := context.Background()
	result, err := x402Client.CallTool(ctx, "paid_tool", map[string]interface{}{})
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !result.PaymentMade {
		t.Error("Expected PaymentMade to be true")
	}
	if result.PaymentResponse == nil {
		t.Error("Expected PaymentResponse to be set")
	}
	if mockMCPCaller.callCount != 2 {
		t.Errorf("Expected 2 calls to CallTool, got %d", mockMCPCaller.callCount)
	}
}

func TestX402MCPClient_CallTool_HookAbort(t *testing.T) {
	paymentRequired := types.PaymentRequired{
		X402Version: 2,
		Accepts: []types.PaymentRequirements{
			{
				Scheme:  "exact",
				Network: "eip155:84532",
				Amount:  "1000",
				Asset:   "USDC",
				PayTo:   "0xrecipient",
			},
		},
	}

	structuredBytes, _ := json.Marshal(paymentRequired)
	var structuredContent map[string]interface{}
	if err := json.Unmarshal(structuredBytes, &structuredContent); err != nil {
		t.Fatalf("Failed to unmarshal structured content: %v", err)
	}

	mockMCPCaller := &mockMCPCaller{
		callToolResult: MCPToolResult{
			IsError:           true,
			StructuredContent: structuredContent,
		},
	}

	paymentClient := x402.Newx402Client()
	mockSchemeClient := &mockSchemeNetworkClient{scheme: "exact"}
	paymentClient.Register("eip155:84532", mockSchemeClient)

	x402Client := NewX402MCPClient(mockMCPCaller, paymentClient, Options{
		AutoPayment: BoolPtr(true),
	})

	// Register a hook that aborts
	x402Client.OnPaymentRequired(func(ctx PaymentRequiredContext) (*PaymentRequiredHookResult, error) {
		return &PaymentRequiredHookResult{Abort: true}, nil
	})

	ctx := context.Background()
	_, err := x402Client.CallTool(ctx, "paid_tool", map[string]interface{}{})
	if err == nil {
		t.Fatal("Expected error from hook abort")
	}

	var paymentErr *PaymentRequiredError
	if !errors.As(err, &paymentErr) {
		t.Fatalf("Expected PaymentRequiredError, got %T: %v", err, err)
	}
}

func TestX402MCPClient_CallTool_HookCustomPayment(t *testing.T) {
	paymentRequired := types.PaymentRequired{
		X402Version: 2,
		Accepts: []types.PaymentRequirements{
			{
				Scheme:  "exact",
				Network: "eip155:84532",
				Amount:  "1000",
				Asset:   "USDC",
				PayTo:   "0xrecipient",
			},
		},
	}

	structuredBytes, _ := json.Marshal(paymentRequired)
	var structuredContent map[string]interface{}
	if err := json.Unmarshal(structuredBytes, &structuredContent); err != nil {
		t.Fatalf("Failed to unmarshal structured content: %v", err)
	}

	mockMCPCaller := &mockMCPCaller{
		callToolResults: []MCPToolResult{
			{
				IsError:           true,
				StructuredContent: structuredContent,
			},
			{
				Content: []MCPContentItem{
					{Type: "text", Text: "success from custom payment"},
				},
				IsError: false,
				Meta: map[string]interface{}{
					MCP_PAYMENT_RESPONSE_META_KEY: map[string]interface{}{
						"success":     true,
						"transaction": "0xcustom",
						"network":     "eip155:84532",
					},
				},
			},
		},
	}

	paymentClient := x402.Newx402Client()
	mockSchemeClient := &mockSchemeNetworkClient{scheme: "exact"}
	paymentClient.Register("eip155:84532", mockSchemeClient)

	x402Client := NewX402MCPClient(mockMCPCaller, paymentClient, Options{
		AutoPayment: BoolPtr(true),
	})

	// Register a hook that provides custom payment
	customPayload := types.PaymentPayload{
		X402Version: 2,
		Accepted: types.PaymentRequirements{
			Scheme:  "exact",
			Network: "eip155:84532",
			Amount:  "1000",
			Asset:   "USDC",
			PayTo:   "0xrecipient",
		},
		Payload: map[string]interface{}{"signature": "0xcustom_sig"},
	}
	x402Client.OnPaymentRequired(func(ctx PaymentRequiredContext) (*PaymentRequiredHookResult, error) {
		return &PaymentRequiredHookResult{Payment: &customPayload}, nil
	})

	ctx := context.Background()
	result, err := x402Client.CallTool(ctx, "paid_tool", map[string]interface{}{})
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !result.PaymentMade {
		t.Error("Expected PaymentMade to be true")
	}
}

func TestX402MCPClient_CallTool_OnPaymentRequestedApproved(t *testing.T) {
	paymentRequired := types.PaymentRequired{
		X402Version: 2,
		Accepts: []types.PaymentRequirements{
			{
				Scheme:  "exact",
				Network: "eip155:84532",
				Amount:  "1000",
				Asset:   "USDC",
				PayTo:   "0xrecipient",
			},
		},
	}

	structuredBytes, _ := json.Marshal(paymentRequired)
	var structuredContent map[string]interface{}
	if err := json.Unmarshal(structuredBytes, &structuredContent); err != nil {
		t.Fatalf("Failed to unmarshal structured content: %v", err)
	}

	mockMCPCaller := &mockMCPCaller{
		callToolResults: []MCPToolResult{
			{
				IsError:           true,
				StructuredContent: structuredContent,
			},
			{
				Content: []MCPContentItem{
					{Type: "text", Text: "success"},
				},
				IsError: false,
			},
		},
	}

	paymentClient := x402.Newx402Client()
	mockSchemeClient := &mockSchemeNetworkClient{scheme: "exact"}
	paymentClient.Register("eip155:84532", mockSchemeClient)

	approvalCalled := false
	x402Client := NewX402MCPClient(mockMCPCaller, paymentClient, Options{
		AutoPayment: BoolPtr(true),
		OnPaymentRequested: func(ctx PaymentRequiredContext) (bool, error) {
			approvalCalled = true
			return true, nil // Approve
		},
	})

	ctx := context.Background()
	_, err := x402Client.CallTool(ctx, "paid_tool", map[string]interface{}{})
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !approvalCalled {
		t.Error("Expected OnPaymentRequested to be called")
	}
}

func TestX402MCPClient_CallTool_OnPaymentRequestedDenied(t *testing.T) {
	paymentRequired := types.PaymentRequired{
		X402Version: 2,
		Accepts: []types.PaymentRequirements{
			{
				Scheme:  "exact",
				Network: "eip155:84532",
				Amount:  "1000",
				Asset:   "USDC",
				PayTo:   "0xrecipient",
			},
		},
	}

	structuredBytes, _ := json.Marshal(paymentRequired)
	var structuredContent map[string]interface{}
	if err := json.Unmarshal(structuredBytes, &structuredContent); err != nil {
		t.Fatalf("Failed to unmarshal structured content: %v", err)
	}

	mockMCPCaller := &mockMCPCaller{
		callToolResult: MCPToolResult{
			IsError:           true,
			StructuredContent: structuredContent,
		},
	}

	paymentClient := x402.Newx402Client()
	mockSchemeClient := &mockSchemeNetworkClient{scheme: "exact"}
	paymentClient.Register("eip155:84532", mockSchemeClient)

	x402Client := NewX402MCPClient(mockMCPCaller, paymentClient, Options{
		AutoPayment: BoolPtr(true),
		OnPaymentRequested: func(ctx PaymentRequiredContext) (bool, error) {
			return false, nil // Deny
		},
	})

	ctx := context.Background()
	_, err := x402Client.CallTool(ctx, "paid_tool", map[string]interface{}{})
	if err == nil {
		t.Fatal("Expected error when payment denied")
	}

	var paymentErr *PaymentRequiredError
	if !errors.As(err, &paymentErr) {
		t.Fatalf("Expected PaymentRequiredError, got %T: %v", err, err)
	}
}

func TestX402MCPClient_CallTool_BeforePaymentHookCalled(t *testing.T) {
	paymentRequired := types.PaymentRequired{
		X402Version: 2,
		Accepts: []types.PaymentRequirements{
			{
				Scheme:  "exact",
				Network: "eip155:84532",
				Amount:  "1000",
				Asset:   "USDC",
				PayTo:   "0xrecipient",
			},
		},
	}

	structuredBytes, _ := json.Marshal(paymentRequired)
	var structuredContent map[string]interface{}
	if err := json.Unmarshal(structuredBytes, &structuredContent); err != nil {
		t.Fatalf("Failed to unmarshal structured content: %v", err)
	}

	mockMCPCaller := &mockMCPCaller{
		callToolResults: []MCPToolResult{
			{
				IsError:           true,
				StructuredContent: structuredContent,
			},
			{
				Content: []MCPContentItem{
					{Type: "text", Text: "success"},
				},
				IsError: false,
			},
		},
	}

	paymentClient := x402.Newx402Client()
	mockSchemeClient := &mockSchemeNetworkClient{scheme: "exact"}
	paymentClient.Register("eip155:84532", mockSchemeClient)

	x402Client := NewX402MCPClient(mockMCPCaller, paymentClient, Options{
		AutoPayment: BoolPtr(true),
	})

	beforeCalled := false
	x402Client.OnBeforePayment(func(ctx PaymentRequiredContext) error {
		beforeCalled = true
		if ctx.ToolName != "paid_tool" {
			t.Errorf("Expected tool name 'paid_tool', got '%s'", ctx.ToolName)
		}
		return nil
	})

	ctx := context.Background()
	_, err := x402Client.CallTool(ctx, "paid_tool", map[string]interface{}{})
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !beforeCalled {
		t.Error("Expected BeforePayment hook to be called")
	}
}

func TestX402MCPClient_CallTool_BeforePaymentHookError(t *testing.T) {
	paymentRequired := types.PaymentRequired{
		X402Version: 2,
		Accepts: []types.PaymentRequirements{
			{
				Scheme:  "exact",
				Network: "eip155:84532",
				Amount:  "1000",
				Asset:   "USDC",
				PayTo:   "0xrecipient",
			},
		},
	}

	structuredBytes, _ := json.Marshal(paymentRequired)
	var structuredContent map[string]interface{}
	if err := json.Unmarshal(structuredBytes, &structuredContent); err != nil {
		t.Fatalf("Failed to unmarshal structured content: %v", err)
	}

	mockMCPCaller := &mockMCPCaller{
		callToolResult: MCPToolResult{
			IsError:           true,
			StructuredContent: structuredContent,
		},
	}

	paymentClient := x402.Newx402Client()
	mockSchemeClient := &mockSchemeNetworkClient{scheme: "exact"}
	paymentClient.Register("eip155:84532", mockSchemeClient)

	x402Client := NewX402MCPClient(mockMCPCaller, paymentClient, Options{
		AutoPayment: BoolPtr(true),
	})

	x402Client.OnBeforePayment(func(ctx PaymentRequiredContext) error {
		return fmt.Errorf("before payment hook failed")
	})

	ctx := context.Background()
	_, err := x402Client.CallTool(ctx, "paid_tool", map[string]interface{}{})
	if err == nil {
		t.Fatal("Expected error from before payment hook")
	}
	if err.Error() != "before payment hook error: before payment hook failed" {
		t.Errorf("Unexpected error message: %v", err)
	}
}

func TestX402MCPClient_CallTool_UnderlyingError(t *testing.T) {
	mockMCPCaller := &mockMCPCaller{
		callToolError: fmt.Errorf("connection refused"),
	}

	paymentClient := x402.Newx402Client()
	x402Client := NewX402MCPClient(mockMCPCaller, paymentClient, Options{})

	ctx := context.Background()
	_, err := x402Client.CallTool(ctx, "test_tool", map[string]interface{}{})
	if err == nil {
		t.Fatal("Expected error from underlying client")
	}
	if !errors.Is(err, mockMCPCaller.callToolError) {
		t.Errorf("Expected wrapped connection error, got: %v", err)
	}
}
