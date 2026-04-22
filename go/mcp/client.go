package mcp

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/types"
)

// MCPCaller is the interface for making MCP tool calls.
// This is satisfied by the official MCP SDK's *mcp.ClientSession.
type MCPCaller interface {
	CallTool(ctx context.Context, params *mcp.CallToolParams) (*mcp.CallToolResult, error)
}

// X402MCPClient wraps an MCP session (MCPCaller) with automatic x402 payment handling.
// Use NewX402MCPClient or NewX402MCPClientFromConfig with *mcp.ClientSession.
type X402MCPClient struct {
	caller        MCPCaller
	paymentClient *x402.X402Client
	options       Options
	onPaymentReq  PaymentRequiredHook
	onBeforePay   BeforePaymentHook
	onAfterPay    AfterPaymentHook
}

// NewX402MCPClient creates an x402-aware MCP client.
func NewX402MCPClient(caller MCPCaller, paymentClient *x402.X402Client, options Options) *X402MCPClient {
	return &X402MCPClient{
		caller:        caller,
		paymentClient: paymentClient,
		options:       options,
	}
}

// NewX402MCPClientFromConfig creates an x402-aware MCP client from scheme registrations.
func NewX402MCPClientFromConfig(caller MCPCaller, schemes []SchemeRegistration, options Options) *X402MCPClient {
	paymentClient := x402.Newx402Client()
	for _, reg := range schemes {
		if reg.Client != nil {
			paymentClient.Register(reg.Network, reg.Client)
		}
		if reg.ClientV1 != nil {
			paymentClient.RegisterV1(reg.Network, reg.ClientV1)
		}
	}
	return NewX402MCPClient(caller, paymentClient, options)
}

// Client returns the underlying MCP caller (e.g. *mcp.ClientSession).
func (c *X402MCPClient) Client() MCPCaller {
	return c.caller
}

// PaymentClient returns the underlying x402 payment client.
func (c *X402MCPClient) PaymentClient() *x402.X402Client {
	return c.paymentClient
}

// OnPaymentRequired registers a hook called when payment is required.
func (c *X402MCPClient) OnPaymentRequired(hook PaymentRequiredHook) *X402MCPClient {
	c.onPaymentReq = hook
	return c
}

// OnBeforePayment registers a hook called before creating payment.
func (c *X402MCPClient) OnBeforePayment(hook BeforePaymentHook) *X402MCPClient {
	c.onBeforePay = hook
	return c
}

// OnAfterPayment registers a hook called after payment is submitted.
func (c *X402MCPClient) OnAfterPayment(hook AfterPaymentHook) *X402MCPClient {
	c.onAfterPay = hook
	return c
}

// CallTool calls a tool with automatic payment handling.
func (c *X402MCPClient) CallTool(ctx context.Context, name string, args map[string]interface{}) (*MCPToolCallResult, error) {
	params := &mcp.CallToolParams{
		Name:      name,
		Arguments: args,
	}

	result, err := c.caller.CallTool(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("tool call failed: %w", err)
	}

	if !result.IsError {
		return buildMCPToolCallResultFromSDK(result, false), nil
	}

	paymentRequired := extractPaymentRequired(result)
	if paymentRequired == nil || len(paymentRequired.Accepts) == 0 {
		return buildMCPToolCallResultFromSDK(result, false), nil
	}

	// Payment required - check auto-payment
	autoPayment := true
	if c.options.AutoPayment != nil {
		autoPayment = *c.options.AutoPayment
	}

	prCtx := PaymentRequiredContext{
		ToolName:        name,
		Arguments:       args,
		PaymentRequired: *paymentRequired,
	}

	// OnPaymentRequired hook - can provide custom payment or abort
	if c.onPaymentReq != nil {
		hookResult, err := c.onPaymentReq(prCtx)
		if err != nil {
			return nil, fmt.Errorf("payment required hook error: %w", err)
		}
		if hookResult != nil {
			if hookResult.Abort {
				return nil, &PaymentRequiredError{
					Code:            MCP_PAYMENT_REQUIRED_CODE,
					Message:         "Payment required",
					PaymentRequired: paymentRequired,
				}
			}
			if hookResult.Payment != nil {
				return c.callToolWithPayload(ctx, name, args, *hookResult.Payment)
			}
		}
	}

	if !autoPayment {
		return nil, &PaymentRequiredError{
			Code:            MCP_PAYMENT_REQUIRED_CODE,
			Message:         "Payment required",
			PaymentRequired: paymentRequired,
		}
	}

	// OnPaymentRequested - can approve/deny
	if c.options.OnPaymentRequested != nil {
		ok, err := c.options.OnPaymentRequested(prCtx)
		if err != nil {
			return nil, fmt.Errorf("payment requested hook error: %w", err)
		}
		if !ok {
			return nil, &PaymentRequiredError{
				Code:            MCP_PAYMENT_REQUIRED_CODE,
				Message:         "Payment denied by user",
				PaymentRequired: paymentRequired,
			}
		}
	}

	// OnBeforePayment hook
	if c.onBeforePay != nil {
		if err := c.onBeforePay(prCtx); err != nil {
			return nil, fmt.Errorf("before payment hook error: %w", err)
		}
	}

	payload, err := c.paymentClient.CreatePaymentPayload(
		ctx,
		paymentRequired.Accepts[0],
		paymentRequired.Resource,
		paymentRequired.Extensions,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create payment: %w", err)
	}

	return c.callToolWithPayload(ctx, name, args, payload)
}

// CallToolWithPayment calls a tool with a pre-created payment payload.
func (c *X402MCPClient) CallToolWithPayment(ctx context.Context, name string, args map[string]interface{}, payload types.PaymentPayload) (*MCPToolCallResult, error) {
	return c.callToolWithPayload(ctx, name, args, payload)
}

func (c *X402MCPClient) callToolWithPayload(ctx context.Context, name string, args map[string]interface{}, payload types.PaymentPayload) (*MCPToolCallResult, error) {
	params := &mcp.CallToolParams{
		Name:      name,
		Arguments: args,
		Meta:      mcp.Meta{MCP_PAYMENT_META_KEY: payload},
	}

	result, err := c.caller.CallTool(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("paid tool call failed: %w", err)
	}

	paymentResponse := extractPaymentResponseFromSDK(result)

	// OnAfterPayment hook
	if c.onAfterPay != nil && paymentResponse != nil {
		mcpResult := callToolResultToMCPToolResult(result)
		_ = c.onAfterPay(AfterPaymentContext{
			ToolName:       name,
			PaymentPayload: payload,
			Result:         mcpResult,
			SettleResponse: paymentResponse,
		})
	}

	return buildMCPToolCallResultFromSDK(result, true), nil
}

// GetToolPaymentRequirements fetches payment requirements for a tool without paying.
func (c *X402MCPClient) GetToolPaymentRequirements(ctx context.Context, name string, args map[string]interface{}) (*types.PaymentRequired, error) {
	params := &mcp.CallToolParams{
		Name:      name,
		Arguments: args,
	}

	result, err := c.caller.CallTool(ctx, params)
	if err != nil {
		return nil, err
	}

	return extractPaymentRequired(result), nil
}

// buildMCPToolCallResultFromSDK converts *mcp.CallToolResult to MCPToolCallResult.
func buildMCPToolCallResultFromSDK(result *mcp.CallToolResult, paymentMade bool) *MCPToolCallResult {
	paymentResponse := extractPaymentResponseFromSDK(result)

	content := make([]MCPContentItem, 0, len(result.Content))
	for _, item := range result.Content {
		if tc, ok := item.(*mcp.TextContent); ok {
			content = append(content, MCPContentItem{Type: "text", Text: tc.Text})
		}
	}

	return &MCPToolCallResult{
		Content:         content,
		IsError:         result.IsError,
		PaymentResponse: paymentResponse,
		PaymentMade:     paymentMade,
	}
}

// callToolResultToMCPToolResult converts *mcp.CallToolResult to MCPToolResult for hooks.
func callToolResultToMCPToolResult(result *mcp.CallToolResult) MCPToolResult {
	content := make([]MCPContentItem, 0, len(result.Content))
	for _, item := range result.Content {
		if tc, ok := item.(*mcp.TextContent); ok {
			content = append(content, MCPContentItem{Type: "text", Text: tc.Text})
		}
	}

	mcpResult := MCPToolResult{
		Content: content,
		IsError: result.IsError,
	}
	if result.Meta != nil {
		metaMap := result.GetMeta()
		if len(metaMap) > 0 {
			mcpResult.Meta = make(map[string]interface{}, len(metaMap))
			for k, v := range metaMap {
				mcpResult.Meta[k] = v
			}
		}
	}
	if result.StructuredContent != nil {
		if sc, ok := result.StructuredContent.(map[string]interface{}); ok {
			mcpResult.StructuredContent = sc
		}
	}
	return mcpResult
}

// extractPaymentResponseFromSDK extracts SettleResponse from *mcp.CallToolResult.Meta.
func extractPaymentResponseFromSDK(result *mcp.CallToolResult) *x402.SettleResponse {
	if result.Meta == nil {
		return nil
	}
	metaMap := result.GetMeta()
	if pr, ok := metaMap[MCP_PAYMENT_RESPONSE_META_KEY]; ok {
		prBytes, err := json.Marshal(pr)
		if err == nil {
			var sr x402.SettleResponse
			if json.Unmarshal(prBytes, &sr) == nil {
				return &sr
			}
		}
	}
	return nil
}

// ToolCallResult is the result of a paid MCP tool call.
type ToolCallResult struct {
	// Content is the list of content items from the tool response.
	Content []mcp.Content

	// IsError indicates whether the tool returned an error.
	IsError bool

	// PaymentResponse is the settlement response if payment was made.
	PaymentResponse *x402.SettleResponse

	// PaymentMade indicates whether a payment was made during this call.
	PaymentMade bool

	// RawResult is the original MCP CallToolResult.
	RawResult *mcp.CallToolResult
}

// CallPaidTool makes an MCP tool call with automatic x402 payment handling.
//
// Flow:
//  1. Calls the tool without payment
//  2. If the server returns a payment required error, creates a payment
//  3. Retries with payment attached in _meta
//  4. Returns the result with payment response extracted
//
// Example:
//
//	result, err := mcp402.CallPaidTool(ctx, session, x402Client, "get_weather", map[string]any{"city": "SF"})
//	if err != nil {
//	    log.Fatal(err)
//	}
//	fmt.Println(result.PaymentResponse.Transaction)
func CallPaidTool(
	ctx context.Context,
	mcpClient MCPCaller,
	x402Client *x402.X402Client,
	name string,
	args map[string]any,
) (*ToolCallResult, error) {
	// First call without payment
	params := &mcp.CallToolParams{
		Name:      name,
		Arguments: args,
	}

	result, err := mcpClient.CallTool(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("tool call failed: %w", err)
	}

	// If no error, return directly
	if !result.IsError {
		return buildResult(result, false), nil
	}

	// Try to extract payment required from error content
	paymentRequired := extractPaymentRequired(result)
	if paymentRequired == nil {
		return buildResult(result, false), nil
	}

	if len(paymentRequired.Accepts) == 0 {
		return buildResult(result, false), nil
	}

	// Create payment payload using the first requirement
	paymentPayload, err := x402Client.CreatePaymentPayload(
		ctx,
		paymentRequired.Accepts[0],
		paymentRequired.Resource,
		paymentRequired.Extensions,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create payment: %w", err)
	}

	// Retry with payment in _meta
	params.Meta = mcp.Meta{
		PaymentMetaKey: paymentPayload,
	}

	result, err = mcpClient.CallTool(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("paid tool call failed: %w", err)
	}

	return buildResult(result, true), nil
}

// buildResult converts an MCP CallToolResult into a ToolCallResult.
func buildResult(result *mcp.CallToolResult, paymentMade bool) *ToolCallResult {
	var paymentResponse *x402.SettleResponse
	if result.Meta != nil {
		if pr, ok := result.Meta[PaymentResponseMetaKey]; ok {
			// Marshal and unmarshal to convert to SettleResponse
			prBytes, err := json.Marshal(pr)
			if err == nil {
				var sr x402.SettleResponse
				if json.Unmarshal(prBytes, &sr) == nil {
					paymentResponse = &sr
				}
			}
		}
	}

	return &ToolCallResult{
		Content:         result.Content,
		IsError:         result.IsError,
		PaymentResponse: paymentResponse,
		PaymentMade:     paymentMade,
		RawResult:       result,
	}
}

// extractPaymentRequired extracts PaymentRequired from an error result.
// Prefers structuredContent (per spec), falls back to parsing content[0].text.
func extractPaymentRequired(result *mcp.CallToolResult) *types.PaymentRequired {
	// Preferred path: check structuredContent first (per MCP x402 spec)
	if result.StructuredContent != nil {
		if sc, ok := result.StructuredContent.(map[string]any); ok {
			if _, hasAccepts := sc["accepts"]; hasAccepts {
				if version, hasVersion := sc["x402Version"]; hasVersion {
					// Validate x402Version is present and numeric
					switch v := version.(type) {
					case float64:
						if v >= 1 {
							return unmarshalPaymentRequired(sc)
						}
					case int:
						if v >= 1 {
							return unmarshalPaymentRequired(sc)
						}
					}
				}
			}
		}
	}

	// Fallback: parse content[].text as JSON
	for _, content := range result.Content {
		textContent, ok := content.(*mcp.TextContent)
		if !ok {
			continue
		}

		pr := tryParsePaymentRequired(textContent.Text)
		if pr != nil {
			return pr
		}
	}
	return nil
}

// tryParsePaymentRequired attempts to parse text as a PaymentRequired response.
// Validates that x402Version and accepts are present.
func tryParsePaymentRequired(text string) *types.PaymentRequired {
	var parsed map[string]interface{}
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		return nil
	}

	// Require both "accepts" and "x402Version"
	if _, hasAccepts := parsed["accepts"]; !hasAccepts {
		return nil
	}
	if _, hasVersion := parsed["x402Version"]; !hasVersion {
		return nil
	}

	var pr types.PaymentRequired
	if err := json.Unmarshal([]byte(text), &pr); err != nil {
		return nil
	}
	return &pr
}

// unmarshalPaymentRequired converts a map to PaymentRequired via JSON roundtrip.
func unmarshalPaymentRequired(data map[string]any) *types.PaymentRequired {
	bytes, err := json.Marshal(data)
	if err != nil {
		return nil
	}
	var pr types.PaymentRequired
	if err := json.Unmarshal(bytes, &pr); err != nil {
		return nil
	}
	return &pr
}
