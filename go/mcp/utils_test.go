package mcp

import (
	"encoding/json"
	"testing"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/types"
)

func TestExtractPaymentFromMeta(t *testing.T) {
	tests := []struct {
		name    string
		params  map[string]interface{}
		wantNil bool
		wantErr bool
	}{
		{
			name:    "no _meta",
			params:  map[string]interface{}{"name": "test"},
			wantNil: true,
			wantErr: false,
		},
		{
			name:    "no payment in _meta",
			params:  map[string]interface{}{"_meta": map[string]interface{}{}},
			wantNil: true,
			wantErr: false,
		},
		{
			name: "valid payment",
			params: map[string]interface{}{
				"_meta": map[string]interface{}{
					MCP_PAYMENT_META_KEY: map[string]interface{}{
						"x402Version": 2,
						"accepted": map[string]interface{}{
							"scheme":  "exact",
							"network": "eip155:84532",
						},
						"payload": map[string]interface{}{
							"signature": "0x123",
						},
					},
				},
			},
			wantNil: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ExtractPaymentFromMeta(tt.params)
			if tt.wantNil {
				if result != nil {
					t.Errorf("Expected nil result, got %v", result)
				}
				if tt.wantErr && err == nil {
					t.Errorf("Expected error, got nil")
				}
				if !tt.wantErr && err != nil {
					t.Errorf("Expected no error, got %v", err)
				}
			} else if result == nil || err != nil {
				t.Errorf("Expected non-nil result, got %v, %v", result, err)
			}
		})
	}
}

func TestAttachPaymentToMeta(t *testing.T) {
	payload := types.PaymentPayload{
		X402Version: 2,
		Payload: map[string]interface{}{
			"signature": "0x123",
		},
	}

	params := map[string]interface{}{
		"name":      "test",
		"arguments": map[string]interface{}{"city": "NYC"},
	}

	result := AttachPaymentToMeta(params, payload)

	if result["_meta"] == nil {
		t.Fatal("Expected _meta to be set")
	}

	meta := result["_meta"].(map[string]interface{})
	if meta[MCP_PAYMENT_META_KEY] == nil {
		t.Fatal("Expected payment to be in _meta")
	}
}

func TestExtractPaymentRequiredFromResult(t *testing.T) {
	paymentRequired := types.PaymentRequired{
		X402Version: 2,
		Accepts: []types.PaymentRequirements{
			{
				Scheme:  "exact",
				Network: "eip155:84532",
				Amount:  "1000",
			},
		},
	}

	// Test structuredContent format
	structuredBytes, _ := json.Marshal(paymentRequired)
	var structuredContent map[string]interface{}
	if err := json.Unmarshal(structuredBytes, &structuredContent); err != nil {
		t.Fatalf("Failed to unmarshal structured content: %v", err)
	}

	result := MCPToolResult{
		IsError:           true,
		StructuredContent: structuredContent,
	}

	extracted, err := ExtractPaymentRequiredFromResult(result)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if extracted == nil {
		t.Fatal("Expected payment required to be extracted")
	}
	if extracted.X402Version != 2 {
		t.Errorf("Expected version 2, got %d", extracted.X402Version)
	}

	// Test content[0].text format
	textBytes, _ := json.Marshal(paymentRequired)
	result2 := MCPToolResult{
		IsError: true,
		Content: []MCPContentItem{
			{Type: "text", Text: string(textBytes)},
		},
	}

	extracted2, err := ExtractPaymentRequiredFromResult(result2)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if extracted2 == nil {
		t.Fatal("Expected payment required to be extracted from text")
	}
}

// ============================================================================
// Error Utility Tests
// ============================================================================

func TestCreatePaymentRequiredError(t *testing.T) {
	paymentRequired := &types.PaymentRequired{
		X402Version: 2,
		Accepts: []types.PaymentRequirements{
			{Scheme: "exact", Network: "eip155:84532", Amount: "1000"},
		},
	}

	// Test default message
	err := CreatePaymentRequiredError("Payment required", paymentRequired)
	if err.Code != MCP_PAYMENT_REQUIRED_CODE {
		t.Errorf("Expected code %d, got %d", MCP_PAYMENT_REQUIRED_CODE, err.Code)
	}
	if err.Message != "Payment required" {
		t.Errorf("Expected message 'Payment required', got '%s'", err.Message)
	}
	if err.PaymentRequired != paymentRequired {
		t.Error("Expected PaymentRequired to match")
	}

	// Test custom message
	err = CreatePaymentRequiredError("Custom error", paymentRequired)
	if err.Message != "Custom error" {
		t.Errorf("Expected message 'Custom error', got '%s'", err.Message)
	}
}

func TestIsPaymentRequiredError(t *testing.T) {
	paymentRequired := &types.PaymentRequired{
		X402Version: 2,
		Accepts: []types.PaymentRequirements{
			{Scheme: "exact", Network: "eip155:84532", Amount: "1000"},
		},
	}

	err := CreatePaymentRequiredError("Payment required", paymentRequired)

	if !IsPaymentRequiredError(err) {
		t.Error("Expected IsPaymentRequiredError to return true")
	}

	// Test with nil
	if IsPaymentRequiredError(nil) {
		t.Error("Expected IsPaymentRequiredError(nil) to return false")
	}

	// Test with different error type
	if IsPaymentRequiredError(&struct{ error }{}) {
		t.Error("Expected IsPaymentRequiredError to return false for different error type")
	}
}

func TestExtractPaymentRequiredFromError(t *testing.T) {
	_ = types.PaymentRequired{
		X402Version: 2,
		Accepts: []types.PaymentRequirements{
			{Scheme: "exact", Network: "eip155:84532", Amount: "1000"},
		},
	}

	// Test valid 402 error
	jsonRpcError := map[string]interface{}{
		"code":    float64(402),
		"message": "Payment required",
		"data": map[string]interface{}{
			"x402Version": float64(2),
			"accepts": []interface{}{
				map[string]interface{}{
					"scheme":  "exact",
					"network": "eip155:84532",
					"amount":  "1000",
				},
			},
		},
	}

	pr, err := ExtractPaymentRequiredFromError(jsonRpcError)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if pr == nil {
		t.Fatal("Expected non-nil PaymentRequired")
	}
	if pr.X402Version != 2 {
		t.Errorf("Expected X402Version 2, got %d", pr.X402Version)
	}

	// Test non-402 error
	non402Error := map[string]interface{}{
		"code":    float64(500),
		"message": "Server error",
	}
	pr, _ = ExtractPaymentRequiredFromError(non402Error)
	if pr != nil {
		t.Error("Expected nil for non-402 error")
	}

	// Test nil error
	pr, _ = ExtractPaymentRequiredFromError(nil)
	if pr != nil {
		t.Error("Expected nil for nil error")
	}

	// Test non-object error
	pr, _ = ExtractPaymentRequiredFromError("not an object")
	if pr != nil {
		t.Error("Expected nil for non-object error")
	}
}

func TestIsObject(t *testing.T) {
	// Test valid object
	if !IsObject(map[string]interface{}{"key": "value"}) {
		t.Error("Expected IsObject to return true for map")
	}

	// Test nil
	if IsObject(nil) {
		t.Error("Expected IsObject(nil) to return false")
	}

	// Test non-object types
	if IsObject("string") {
		t.Error("Expected IsObject to return false for string")
	}
	if IsObject(42) {
		t.Error("Expected IsObject to return false for int")
	}
	if IsObject(true) {
		t.Error("Expected IsObject to return false for bool")
	}
}

func TestCreateToolResourceUrl(t *testing.T) {
	tests := []struct {
		name      string
		toolName  string
		customUrl string
		want      string
	}{
		{
			name:     "default URL",
			toolName: "get_weather",
			want:     "mcp://tool/get_weather",
		},
		{
			name:      "custom URL",
			toolName:  "get_weather",
			customUrl: "https://api.example.com/weather",
			want:      "https://api.example.com/weather",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CreateToolResourceUrl(tt.toolName, tt.customUrl)
			if got != tt.want {
				t.Errorf("Expected %s, got %s", tt.want, got)
			}
		})
	}
}

// ============================================================================
// Missing Coverage Tests
// ============================================================================

func TestExtractPaymentResponseFromMeta(t *testing.T) {
	tests := []struct {
		name      string
		result    MCPToolResult
		wantNil   bool
		wantError bool
	}{
		{
			name: "no meta",
			result: MCPToolResult{
				Content: []MCPContentItem{{Type: "text", Text: "success"}},
				IsError: false,
				Meta:    nil,
			},
			wantNil: true,
		},
		{
			name: "no payment response in meta",
			result: MCPToolResult{
				Content: []MCPContentItem{{Type: "text", Text: "success"}},
				IsError: false,
				Meta:    map[string]interface{}{},
			},
			wantNil: true,
		},
		{
			name: "valid payment response",
			result: MCPToolResult{
				Content: []MCPContentItem{{Type: "text", Text: "success"}},
				IsError: false,
				Meta: map[string]interface{}{
					MCP_PAYMENT_RESPONSE_META_KEY: map[string]interface{}{
						"success":     true,
						"transaction": "0xtxhash123",
						"network":     "eip155:84532",
					},
				},
			},
			wantNil: false,
		},
		{
			name: "invalid payment response structure",
			result: MCPToolResult{
				Content: []MCPContentItem{{Type: "text", Text: "success"}},
				IsError: false,
				Meta: map[string]interface{}{
					MCP_PAYMENT_RESPONSE_META_KEY: "invalid",
				},
			},
			wantNil: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ExtractPaymentResponseFromMeta(tt.result)
			switch {
			case tt.wantNil:
				if result != nil {
					t.Errorf("Expected nil result, got %v", result)
				}
				if tt.wantError && err == nil {
					t.Error("Expected error, got nil")
				}
			case result == nil:
				t.Errorf("Expected non-nil result, got nil (err: %v)", err)
			case result.Transaction == "":
				t.Error("Expected transaction to be set")
			}
		})
	}
}

func TestAttachPaymentResponseToMeta(t *testing.T) {
	settleResponse := x402.SettleResponse{
		Success:     true,
		Transaction: "0xtxhash123",
		Network:     "eip155:84532",
	}

	result := MCPToolResult{
		Content: []MCPContentItem{{Type: "text", Text: "success"}},
		IsError: false,
		Meta:    nil,
	}

	updated := AttachPaymentResponseToMeta(result, settleResponse)

	if updated.Meta == nil {
		t.Fatal("Expected Meta to be set")
	}

	responseData, ok := updated.Meta[MCP_PAYMENT_RESPONSE_META_KEY]
	if !ok {
		t.Fatal("Expected payment response to be in Meta")
	}

	// Verify it can be extracted back
	extracted, err := ExtractPaymentResponseFromMeta(updated)
	if err != nil {
		t.Fatalf("Unexpected error extracting: %v", err)
	}
	if extracted == nil {
		t.Fatal("Expected extracted response to be non-nil")
	}
	if extracted.Transaction != settleResponse.Transaction {
		t.Errorf("Expected transaction %s, got %s", settleResponse.Transaction, extracted.Transaction)
	}

	// Verify responseData matches
	responseMap, ok := responseData.(x402.SettleResponse)
	if !ok {
		// Try as map
		responseMap2, ok2 := responseData.(map[string]interface{})
		if !ok2 {
			t.Errorf("Unexpected response data type: %T", responseData)
		} else if responseMap2["transaction"] != settleResponse.Transaction {
			t.Errorf("Expected transaction %s in map, got %v", settleResponse.Transaction, responseMap2["transaction"])
		}
	} else if responseMap.Transaction != settleResponse.Transaction {
		t.Errorf("Expected transaction %s, got %s", settleResponse.Transaction, responseMap.Transaction)
	}
}

func TestAttachPaymentResponseToMeta_ExistingMeta(t *testing.T) {
	settleResponse := x402.SettleResponse{
		Success:     true,
		Transaction: "0xtxhash123",
		Network:     "eip155:84532",
	}

	result := MCPToolResult{
		Content: []MCPContentItem{{Type: "text", Text: "success"}},
		IsError: false,
		Meta: map[string]interface{}{
			"other_key": "other_value",
		},
	}

	updated := AttachPaymentResponseToMeta(result, settleResponse)

	if updated.Meta["other_key"] != "other_value" {
		t.Error("Expected existing meta keys to be preserved")
	}

	if updated.Meta[MCP_PAYMENT_RESPONSE_META_KEY] == nil {
		t.Fatal("Expected payment response to be added to Meta")
	}
}
