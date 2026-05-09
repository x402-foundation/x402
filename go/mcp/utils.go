package mcp

import (
	"encoding/json"
	"errors"
	"fmt"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/types"
)

// ExtractPaymentFromMeta extracts payment payload from MCP request _meta field
func ExtractPaymentFromMeta(params map[string]interface{}) (*types.PaymentPayload, error) {
	meta, ok := params["_meta"].(map[string]interface{})
	if !ok {
		return nil, nil
	}

	paymentData, ok := meta[MCP_PAYMENT_META_KEY]
	if !ok {
		return nil, nil
	}

	// Convert to PaymentPayload
	paymentBytes, err := json.Marshal(paymentData)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal payment data: %w", err)
	}

	var payload types.PaymentPayload
	if err := json.Unmarshal(paymentBytes, &payload); err != nil {
		return nil, nil //nolint:nilerr // Invalid structure is not an error condition; nil signals "no payment"
	}

	// Validate structure
	if payload.X402Version == 0 || payload.Payload == nil {
		return nil, nil
	}

	return &payload, nil
}

// AttachPaymentToMeta attaches payment payload to request params
func AttachPaymentToMeta(params map[string]interface{}, payload types.PaymentPayload) map[string]interface{} {
	result := make(map[string]interface{})
	for k, v := range params {
		result[k] = v
	}

	meta := make(map[string]interface{})
	if existingMeta, ok := result["_meta"].(map[string]interface{}); ok {
		for k, v := range existingMeta {
			meta[k] = v
		}
	}

	meta[MCP_PAYMENT_META_KEY] = payload
	result["_meta"] = meta

	return result
}

// ExtractPaymentResponseFromMeta extracts settlement response from MCP result _meta
func ExtractPaymentResponseFromMeta(result MCPToolResult) (*x402.SettleResponse, error) {
	if result.Meta == nil {
		return nil, nil
	}

	responseData, ok := result.Meta[MCP_PAYMENT_RESPONSE_META_KEY]
	if !ok {
		return nil, nil
	}

	// Handle case where responseData might already be a SettleResponse struct
	if settleResp, ok := responseData.(x402.SettleResponse); ok {
		return &settleResp, nil
	}

	responseBytes, err := json.Marshal(responseData)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal response data: %w", err)
	}

	var response x402.SettleResponse
	if err := json.Unmarshal(responseBytes, &response); err != nil {
		return nil, fmt.Errorf("failed to unmarshal payment response: %w", err)
	}

	return &response, nil
}

// AttachPaymentResponseToMeta attaches settlement response to result
func AttachPaymentResponseToMeta(result MCPToolResult, response x402.SettleResponse) MCPToolResult {
	if result.Meta == nil {
		result.Meta = make(map[string]interface{})
	}

	result.Meta[MCP_PAYMENT_RESPONSE_META_KEY] = response
	return result
}

// ExtractPaymentRequiredFromResult extracts PaymentRequired from tool result (dual format)
func ExtractPaymentRequiredFromResult(result MCPToolResult) (*types.PaymentRequired, error) {
	if !result.IsError {
		return nil, nil
	}

	// Try structuredContent first (preferred)
	if result.StructuredContent != nil {
		if pr := extractPaymentRequiredFromObject(result.StructuredContent); pr != nil {
			return pr, nil
		}
	}

	// Fallback to content[0].text
	if len(result.Content) > 0 {
		firstItem := result.Content[0]
		if firstItem.Type == "text" && firstItem.Text != "" {
			var parsed map[string]interface{}
			if err := json.Unmarshal([]byte(firstItem.Text), &parsed); err == nil {
				if pr := extractPaymentRequiredFromObject(parsed); pr != nil {
					return pr, nil
				}
			}
		}
	}

	return nil, nil
}

// extractPaymentRequiredFromObject extracts PaymentRequired from object
func extractPaymentRequiredFromObject(obj map[string]interface{}) *types.PaymentRequired {
	// Check for x402Version and accepts fields
	if _, hasVersion := obj["x402Version"]; !hasVersion {
		return nil
	}

	accepts, ok := obj["accepts"].([]interface{})
	if !ok {
		return nil
	}

	if len(accepts) == 0 {
		return nil
	}

	// Convert to PaymentRequired
	bytes, err := json.Marshal(obj)
	if err != nil {
		return nil
	}

	var pr types.PaymentRequired
	if err := json.Unmarshal(bytes, &pr); err != nil {
		return nil
	}

	return &pr
}

// CreateToolResourceUrl creates a resource URL for an MCP tool
func CreateToolResourceUrl(toolName string, customUrl string) string {
	if customUrl != "" {
		return customUrl
	}
	return "mcp://tool/" + toolName
}

// ============================================================================
// Type Guards
// ============================================================================

// IsObject checks if a value is a non-null object (map[string]interface{}).
//
// Example:
//
//	if mcp.IsObject(value) {
//	    obj := value.(map[string]interface{})
//	    // Use obj
//	}
func IsObject(value interface{}) bool {
	if value == nil {
		return false
	}
	_, ok := value.(map[string]interface{})
	return ok
}

// ============================================================================
// Error Utilities
// ============================================================================

// CreatePaymentRequiredError creates a PaymentRequiredError with the given message and payment required data.
//
// Example:
//
//	err := mcp.CreatePaymentRequiredError("Payment required", &paymentRequired)
//	return nil, err
func CreatePaymentRequiredError(message string, paymentRequired *types.PaymentRequired) *PaymentRequiredError {
	return &PaymentRequiredError{
		Code:            MCP_PAYMENT_REQUIRED_CODE,
		Message:         message,
		PaymentRequired: paymentRequired,
	}
}

// IsPaymentRequiredError checks if an error is a PaymentRequiredError.
//
// Example:
//
//	err := client.CallTool(ctx, "tool", args)
//	if mcp.IsPaymentRequiredError(err) {
//	    var paymentErr *mcp.PaymentRequiredError
//	    errors.As(err, &paymentErr)
//	    // Handle payment required
//	}
func IsPaymentRequiredError(err error) bool {
	if err == nil {
		return false
	}
	var target *PaymentRequiredError
	return errors.As(err, &target)
}

// ExtractPaymentRequiredFromError extracts PaymentRequired from an MCP JSON-RPC error.
//
// This function checks if the error is a 402 payment required error and extracts
// the PaymentRequired data from the error's data field.
//
// Example:
//
//	err := client.CallTool(ctx, "tool", args)
//	if pr := mcp.ExtractPaymentRequiredFromError(err); pr != nil {
//	    // Handle payment required
//	}
func ExtractPaymentRequiredFromError(err interface{}) (*types.PaymentRequired, error) {
	if !IsObject(err) {
		return nil, nil
	}

	errObj := err.(map[string]interface{})

	// Check if this is a 402 payment required error
	code, ok := errObj["code"]
	if !ok {
		return nil, nil
	}

	codeFloat, ok := code.(float64)
	if !ok {
		return nil, nil
	}

	if int(codeFloat) != MCP_PAYMENT_REQUIRED_CODE {
		return nil, nil
	}

	// Extract and validate the data field
	data, ok := errObj["data"]
	if !ok {
		return nil, nil
	}

	dataObj, ok := data.(map[string]interface{})
	if !ok {
		return nil, nil
	}

	// Use existing helper to extract PaymentRequired
	return extractPaymentRequiredFromObject(dataObj), nil
}
