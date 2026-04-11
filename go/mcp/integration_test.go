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

// integrationMCPCaller bridges client → server in-process for integration tests.
// It routes CallTool calls through the server's registered tool handlers.
type integrationMCPCaller struct {
	handlers map[string]ToolHandler
}

func (m *integrationMCPCaller) CallTool(ctx context.Context, params *mcp.CallToolParams) (*mcp.CallToolResult, error) {
	handler, ok := m.handlers[params.Name]
	if !ok {
		return nil, fmt.Errorf("tool %q not found", params.Name)
	}

	argsBytes, _ := json.Marshal(params.Arguments)

	req := &mcp.CallToolRequest{
		Params: &mcp.CallToolParamsRaw{
			Name:      params.Name,
			Arguments: argsBytes,
			Meta:      params.Meta,
		},
	}
	return handler(ctx, req)
}

// setupIntegrationServer creates a resource server with mock facilitator and scheme,
// initializes it, and returns the server along with the mock facilitator for assertions.
func setupIntegrationServer(t *testing.T, facilitator *mockFacilitatorClient) *x402.X402ResourceServer {
	t.Helper()
	if facilitator == nil {
		facilitator = &mockFacilitatorClient{}
	}
	schemeServer := &mockSchemeNetworkServer{scheme: "cash"}

	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(facilitator),
		x402.WithSchemeServer("x402:cash", schemeServer),
	)
	if err := server.Initialize(context.Background()); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}
	return server
}

var integrationAccepts = []types.PaymentRequirements{
	{
		Scheme:  "cash",
		Network: "x402:cash",
		Amount:  "1000",
		PayTo:   "test-recipient",
	},
}

// TestIntegration_FreeToolWithoutPayment verifies that free (unwrapped) tools
// can be called without any payment interaction.
func TestIntegration_FreeToolWithoutPayment(t *testing.T) {
	caller := &integrationMCPCaller{
		handlers: map[string]ToolHandler{
			"ping": func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				return &mcp.CallToolResult{
					Content: []mcp.Content{&mcp.TextContent{Text: "pong"}},
				}, nil
			},
		},
	}

	paymentClient := x402.Newx402Client()
	client := NewX402MCPClient(caller, paymentClient, Options{})

	result, err := client.CallTool(context.Background(), "ping", map[string]interface{}{})
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if result.PaymentMade {
		t.Error("Expected no payment for free tool")
	}
	if result.IsError {
		t.Error("Expected success result")
	}
	if len(result.Content) == 0 || result.Content[0].Text != "pong" {
		t.Errorf("Expected content 'pong', got %v", result.Content)
	}
}

// TestIntegration_PaidToolAutoPayment verifies the full paid tool flow:
// first call returns 402, client auto-pays, second call succeeds with settlement.
func TestIntegration_PaidToolAutoPayment(t *testing.T) {
	facilitator := &mockFacilitatorClient{}
	resourceServer := setupIntegrationServer(t, facilitator)

	wrapper := NewPaymentWrapper(resourceServer, PaymentWrapperConfig{
		Accepts: integrationAccepts,
		Resource: &ResourceInfo{
			URL:         "mcp://tool/get_weather",
			Description: "Get weather",
			MimeType:    "application/json",
		},
	})

	weatherHandler := wrapper.Wrap(func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: `{"city":"SF","weather":"sunny"}`}},
		}, nil
	})

	caller := &integrationMCPCaller{
		handlers: map[string]ToolHandler{
			"get_weather": weatherHandler,
		},
	}

	paymentClient := x402.Newx402Client()
	schemeClient := &mockSchemeNetworkClient{scheme: "cash"}
	paymentClient.Register("x402:cash", schemeClient)

	client := NewX402MCPClient(caller, paymentClient, Options{
		AutoPayment: BoolPtr(true),
	})

	result, err := client.CallTool(context.Background(), "get_weather", map[string]interface{}{"city": "SF"})
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !result.PaymentMade {
		t.Error("Expected PaymentMade to be true")
	}
	if result.IsError {
		t.Error("Expected success result")
	}
	if result.PaymentResponse == nil {
		t.Fatal("Expected PaymentResponse to be set")
	}
	if result.PaymentResponse.Transaction != "tx123" {
		t.Errorf("Expected transaction 'tx123', got '%s'", result.PaymentResponse.Transaction)
	}
	if len(result.Content) == 0 {
		t.Fatal("Expected content")
	}

	var weather map[string]interface{}
	if err := json.Unmarshal([]byte(result.Content[0].Text), &weather); err != nil {
		t.Fatalf("Failed to parse weather content: %v", err)
	}
	if weather["city"] != "SF" {
		t.Errorf("Expected city 'SF', got '%v'", weather["city"])
	}
}

// TestIntegration_ApprovalHookCalledBeforePayment verifies that OnPaymentRequested
// is called and can approve payment before it proceeds.
func TestIntegration_ApprovalHookCalledBeforePayment(t *testing.T) {
	facilitator := &mockFacilitatorClient{}
	resourceServer := setupIntegrationServer(t, facilitator)

	wrapper := NewPaymentWrapper(resourceServer, PaymentWrapperConfig{
		Accepts: integrationAccepts,
	})

	weatherHandler := wrapper.Wrap(func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: `{"weather":"sunny"}`}},
		}, nil
	})

	caller := &integrationMCPCaller{
		handlers: map[string]ToolHandler{
			"get_weather": weatherHandler,
		},
	}

	paymentClient := x402.Newx402Client()
	schemeClient := &mockSchemeNetworkClient{scheme: "cash"}
	paymentClient.Register("x402:cash", schemeClient)

	approvalCalled := false
	client := NewX402MCPClient(caller, paymentClient, Options{
		AutoPayment: BoolPtr(true),
		OnPaymentRequested: func(ctx PaymentRequiredContext) (bool, error) {
			approvalCalled = true
			if ctx.ToolName != "get_weather" {
				t.Errorf("Expected tool name 'get_weather', got '%s'", ctx.ToolName)
			}
			if len(ctx.PaymentRequired.Accepts) == 0 {
				t.Error("Expected payment requirements in hook context")
			}
			return true, nil
		},
	})

	result, err := client.CallTool(context.Background(), "get_weather", map[string]interface{}{})
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !approvalCalled {
		t.Error("Expected OnPaymentRequested to be called")
	}
	if !result.PaymentMade {
		t.Error("Expected PaymentMade to be true")
	}
}

// TestIntegration_PaymentDeniedViaHook verifies that when OnPaymentRequested
// returns false, payment is denied and the client returns an error.
func TestIntegration_PaymentDeniedViaHook(t *testing.T) {
	facilitator := &mockFacilitatorClient{}
	resourceServer := setupIntegrationServer(t, facilitator)

	wrapper := NewPaymentWrapper(resourceServer, PaymentWrapperConfig{
		Accepts: integrationAccepts,
	})

	handlerCalled := false
	weatherHandler := wrapper.Wrap(func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		handlerCalled = true
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: `{"weather":"sunny"}`}},
		}, nil
	})

	caller := &integrationMCPCaller{
		handlers: map[string]ToolHandler{
			"get_weather": weatherHandler,
		},
	}

	paymentClient := x402.Newx402Client()
	schemeClient := &mockSchemeNetworkClient{scheme: "cash"}
	paymentClient.Register("x402:cash", schemeClient)

	client := NewX402MCPClient(caller, paymentClient, Options{
		AutoPayment: BoolPtr(true),
		OnPaymentRequested: func(ctx PaymentRequiredContext) (bool, error) {
			return false, nil // Deny
		},
	})

	_, err := client.CallTool(context.Background(), "get_weather", map[string]interface{}{})
	if err == nil {
		t.Fatal("Expected error when payment denied")
	}

	var paymentErr *PaymentRequiredError
	if !errors.As(err, &paymentErr) {
		t.Fatalf("Expected PaymentRequiredError, got %T: %v", err, err)
	}

	if handlerCalled {
		t.Error("Handler should not be called when payment is denied")
	}
}

// TestIntegration_PaymentVerificationFailure verifies that when the facilitator
// returns isValid: false, the client sees a 402 error after the retry.
func TestIntegration_PaymentVerificationFailure(t *testing.T) {
	facilitator := &mockFacilitatorClient{
		verifyFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
			return &x402.VerifyResponse{IsValid: false, InvalidReason: "Insufficient funds"}, nil
		},
	}
	resourceServer := setupIntegrationServer(t, facilitator)

	wrapper := NewPaymentWrapper(resourceServer, PaymentWrapperConfig{
		Accepts: integrationAccepts,
	})

	handlerCalled := false
	weatherHandler := wrapper.Wrap(func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		handlerCalled = true
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: `{"weather":"sunny"}`}},
		}, nil
	})

	caller := &integrationMCPCaller{
		handlers: map[string]ToolHandler{
			"get_weather": weatherHandler,
		},
	}

	paymentClient := x402.Newx402Client()
	schemeClient := &mockSchemeNetworkClient{scheme: "cash"}
	paymentClient.Register("x402:cash", schemeClient)

	client := NewX402MCPClient(caller, paymentClient, Options{
		AutoPayment: BoolPtr(true),
	})

	result, err := client.CallTool(context.Background(), "get_weather", map[string]interface{}{})
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// After first 402, client retries with payment.
	// Server verifies, fails, returns 402 again.
	// Client sees second 402 after already paying, returns the error result.
	if !result.IsError {
		t.Error("Expected error result due to verification failure")
	}
	if handlerCalled {
		t.Error("Handler should not be called when verification fails")
	}
}
