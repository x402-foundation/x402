// Package mcp provides MCP (Model Context Protocol) integration for x402.
//
// Server-side: Use NewPaymentWrapper to wrap MCP tool handlers with
// automatic x402 payment verification and settlement.
//
// Client-side: Use CallPaidTool to make MCP tool calls with automatic
// x402 payment handling.
package mcp

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/types"
)

// ToolHandler is the function signature for MCP tool handlers.
// This is an alias for the official MCP SDK's mcp.ToolHandler type.
type ToolHandler = mcp.ToolHandler

// PaymentWrapper wraps MCP tool handlers with x402 payment verification and settlement.
type PaymentWrapper struct {
	server *x402.X402ResourceServer
	config PaymentWrapperConfig
}

// NewPaymentWrapper creates a new payment wrapper for MCP tool handlers.
//
// Example:
//
//	wrapper := mcp402.NewPaymentWrapper(resourceServer, mcp402.PaymentWrapperConfig{
//	    Accepts:  weatherAccepts,
//	    Resource: &types.ResourceInfo{URL: "mcp://tool/get_weather", Description: "Get weather"},
//	})
//
//	wrappedHandler := wrapper.Wrap(func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
//	    // extract args from request.Params.Arguments
//	    return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "result"}}}, nil
//	})
func NewPaymentWrapper(server *x402.X402ResourceServer, config PaymentWrapperConfig) *PaymentWrapper {
	if len(config.Accepts) == 0 {
		panic("PaymentWrapperConfig.Accepts must have at least one payment requirement")
	}
	return &PaymentWrapper{server: server, config: config}
}

// Wrap wraps a tool handler with x402 payment verification and settlement.
// The returned handler can be used directly with mcpServer.AddTool().
//
// Flow:
//  1. Extracts x402/payment from request _meta
//  2. If no payment, returns 402 payment required error
//  3. Verifies payment via facilitator
//  4. OnBeforeExecution hook (if configured)
//  5. Executes the original handler
//  6. OnAfterExecution hook (if configured)
//  7. Settles payment via facilitator
//  8. OnAfterSettlement hook (if configured)
//  9. Returns result with settlement info in _meta
func (w *PaymentWrapper) Wrap(handler ToolHandler) ToolHandler {
	return func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		// Extract payment from _meta
		paymentData := extractPaymentFromRequest(request)

		if paymentData == nil {
			return w.paymentRequiredResult("Payment Required"), nil
		}

		// Marshal/unmarshal to convert to PaymentPayload
		payloadBytes, err := json.Marshal(paymentData)
		if err != nil {
			return w.paymentRequiredResult(fmt.Sprintf("Invalid payment: %v", err)), nil
		}

		var payload types.PaymentPayload
		if err := json.Unmarshal(payloadBytes, &payload); err != nil {
			return w.paymentRequiredResult(fmt.Sprintf("Invalid payment payload: %v", err)), nil
		}

		// Verify payment -- return tool error result, NOT Go error
		verifyResp, err := w.server.VerifyPayment(ctx, payload, w.config.Accepts[0])
		if err != nil {
			return w.paymentRequiredResult(
				fmt.Sprintf("Payment verification error: %v", err)), nil
		}
		if !verifyResp.IsValid {
			return w.paymentRequiredResult(
				fmt.Sprintf("Payment verification failed: %s", verifyResp.InvalidReason)), nil
		}

		// Parse args from request for hooks
		args := parseArgsFromRequest(request)

		// OnBeforeExecution hook
		if w.config.Hooks != nil && w.config.Hooks.OnBeforeExecution != nil {
			hookCtx := ServerHookContext{
				ToolName:            request.Params.Name,
				Arguments:           args,
				PaymentRequirements: w.config.Accepts[0],
				PaymentPayload:      payload,
			}
			ok, err := (*w.config.Hooks.OnBeforeExecution)(hookCtx)
			if err != nil {
				return w.paymentRequiredResult(fmt.Sprintf("before execution hook error: %v", err)), nil
			}
			if !ok {
				return w.paymentRequiredResult("Execution aborted by OnBeforeExecution hook"), nil
			}
		}

		// Execute the original handler
		result, err := handler(ctx, request)
		if err != nil {
			return nil, err
		}

		// If handler returned an error result, don't settle
		if result.IsError {
			return result, nil
		}

		// OnAfterExecution hook
		if w.config.Hooks != nil && w.config.Hooks.OnAfterExecution != nil {
			mcpResult := callToolResultToMCPToolResult(result)
			hookCtx := AfterExecutionContext{
				ServerHookContext: ServerHookContext{
					ToolName:            request.Params.Name,
					Arguments:           args,
					PaymentRequirements: w.config.Accepts[0],
					PaymentPayload:      payload,
				},
				Result: mcpResult,
			}
			_ = (*w.config.Hooks.OnAfterExecution)(hookCtx) // Non-fatal
		}

		// Settle payment -- return tool error result, NOT Go error
		settleResp, err := w.server.SettlePayment(ctx, payload, w.config.Accepts[0], nil)
		if err != nil {
			return w.settlementFailedResult(
				fmt.Sprintf("Settlement error: %v", err)), nil
		}
		if !settleResp.Success {
			return w.settlementFailedResult(
				fmt.Sprintf("Settlement failed: %s", settleResp.ErrorReason)), nil
		}

		// OnAfterSettlement hook
		if w.config.Hooks != nil && w.config.Hooks.OnAfterSettlement != nil {
			hookCtx := SettlementContext{
				ServerHookContext: ServerHookContext{
					ToolName:            request.Params.Name,
					Arguments:           args,
					PaymentRequirements: w.config.Accepts[0],
					PaymentPayload:      payload,
				},
				Settlement: *settleResp,
			}
			_ = (*w.config.Hooks.OnAfterSettlement)(hookCtx) // Non-fatal
		}

		// Attach payment response to result _meta
		if result.Meta == nil {
			result.Meta = mcp.Meta{}
		}
		result.Meta[PaymentResponseMetaKey] = settleResp

		return result, nil
	}
}

// parseArgsFromRequest extracts arguments from the request as map[string]interface{}.
func parseArgsFromRequest(request *mcp.CallToolRequest) map[string]interface{} {
	args := make(map[string]interface{})
	if request.Params.Arguments != nil {
		if err := json.Unmarshal(request.Params.Arguments, &args); err != nil {
			return args
		}
	}
	return args
}

// paymentRequiredResult creates an MCP error result with payment required info.
// Per spec, sets both structuredContent and content[0].text with isError: true.
func (w *PaymentWrapper) paymentRequiredResult(errorMsg string) *mcp.CallToolResult {
	resource := w.config.Resource
	if resource == nil {
		resource = &types.ResourceInfo{
			URL:         "mcp://tool/unknown",
			Description: "Unknown tool",
			MimeType:    "application/json",
		}
	}

	pr := types.PaymentRequired{
		X402Version: 2,
		Accepts:     w.config.Accepts,
		Error:       errorMsg,
		Resource:    resource,
		Extensions:  w.config.Extensions,
	}

	data, _ := json.Marshal(pr)

	// Unmarshal to map for structuredContent (any type)
	var structuredContent map[string]any
	_ = json.Unmarshal(data, &structuredContent)

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			&mcp.TextContent{Text: string(data)},
		},
		StructuredContent: structuredContent,
		IsError:           true,
	}
}

// settlementFailedResult creates a spec-compliant settlement failure result.
// Per spec R5, settlement failure follows the same format as payment required
// (structuredContent + content[0].text + isError: true).
func (w *PaymentWrapper) settlementFailedResult(errorMsg string) *mcp.CallToolResult {
	return w.paymentRequiredResult(errorMsg)
}

// extractPaymentFromRequest extracts x402/payment from the request's _meta.
func extractPaymentFromRequest(request *mcp.CallToolRequest) interface{} {
	meta := request.Params.Meta
	if meta == nil {
		return nil
	}
	return meta[PaymentMetaKey]
}
