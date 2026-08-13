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
	"log"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/types"
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
	for _, requirement := range config.Accepts {
		schemeServer := server.GetRegisteredScheme(x402.Network(requirement.Network), requirement.Scheme)
		if schemeServer == nil {
			panic(fmt.Sprintf(
				`[x402] No scheme implementation registered for %q on network %q`,
				requirement.Scheme, requirement.Network,
			))
		}
		if _, _, err := x402.ResolvePaymentFlow(schemeServer, requirement); err != nil {
			panic(err.Error())
		}
	}
	return &PaymentWrapper{server: server, config: config}
}

// Wrap wraps a tool handler with x402 payment verification and settlement.
// The returned handler can be used directly with mcpServer.AddTool().
//
// Flow:
//  1. Extracts x402/payment from request _meta
//  2. If no payment, returns 402 payment required error
//  3. Verifies payment via facilitator (when the flow requires it)
//  4. On SkipHandler, settles without running the tool
//  5. Settles before the handler when the flow requires it
//  6. Creates a cancellation dispatcher for settleOnCancel / cancel hooks
//  7. OnBeforeExecution hook (if configured)
//  8. Executes the original handler
//  9. OnAfterExecution hook (if configured), including IsError results
//  10. On handler throw / IsError, Cancel and attach failure-path payment-response
//  11. Settles after the handler when the flow requires it (else echoes before-handler settle)
//  12. OnAfterSettlement hook (if configured)
//  13. Returns result with settlement info in _meta
func (w *PaymentWrapper) Wrap(handler ToolHandler) ToolHandler {
	return func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		toolName := ""
		if request != nil && request.Params != nil {
			toolName = request.Params.Name
		}

		// Extract payment from _meta
		paymentData := extractPaymentFromRequest(request)

		if paymentData == nil {
			return w.paymentRequiredResult(toolName, "Payment Required", nil), nil
		}

		// Marshal/unmarshal to convert to PaymentPayload
		payloadBytes, err := json.Marshal(paymentData)
		if err != nil {
			return w.paymentRequiredResult(toolName, fmt.Sprintf("Invalid payment: %v", err), nil), nil
		}

		var payload types.PaymentPayload
		if err := json.Unmarshal(payloadBytes, &payload); err != nil {
			return w.paymentRequiredResult(toolName, fmt.Sprintf("Invalid payment payload: %v", err), nil), nil
		}

		resource := w.buildToolResourceInfo(toolName)
		clonedAccepts := x402.SnapshotPaymentRequirementsList(w.config.Accepts)
		paymentRequiredForMatch := w.server.CreatePaymentRequiredResponse(
			clonedAccepts, resource, "", w.config.Extensions,
		)
		matched := w.server.FindMatchingRequirements(paymentRequiredForMatch.Accepts, payload)
		if matched == nil {
			return w.paymentRequiredResult(toolName, "No matching payment requirements found", &payload), nil
		}
		requirements := *matched
		declaredExtensions := w.config.Extensions

		if result := w.server.ValidateExtensions(paymentRequiredForMatch.Extensions, payload); !result.Valid {
			return w.paymentRequiredResult(toolName, result.InvalidReason, &payload), nil
		}

		flow, err := w.server.GetPaymentFlow(requirements)
		if err != nil {
			log.Printf("[x402] MCP payment flow resolve error: %v", err)
			return w.internalServerErrorResult(nil), nil
		}
		phases, err := x402.ResolvePaymentFlowPhases(flow)
		if err != nil {
			log.Printf("[x402] MCP payment flow phases error: %v", err)
			return w.internalServerErrorResult(nil), nil
		}

		// Verify payment -- return tool error result, NOT Go error
		verifyResp, err := w.server.VerifyPaymentWithExtensions(ctx, payload, requirements, declaredExtensions)
		if err != nil {
			return w.paymentRequiredResult(
				toolName, fmt.Sprintf("Payment verification error: %v", err), &payload), nil
		}
		if !verifyResp.IsValid {
			return w.paymentRequiredResult(
				toolName, fmt.Sprintf("Payment verification failed: %s", verifyResp.InvalidReason), &payload), nil
		}

		args := parseArgsFromRequest(request)
		hookCtx := ServerHookContext{
			ToolName:            toolName,
			Arguments:           args,
			PaymentRequirements: requirements,
			PaymentPayload:      payload,
		}

		// SkipHandler: bypass the tool, settle inline, do not create a cancel dispatcher.
		if verifyResp.SkipHandler != nil {
			skipResult := createSkipHandlerResult(verifyResp.SkipHandler.Body)
			return w.settlePaymentResult(ctx, hookCtx, payload, requirements, declaredExtensions, phases, skipResult, nil)
		}

		var beforeHandlerSettlement *x402.CompletedSettlement
		if phases.SettleBeforeHandler {
			settleResp, settleErr := w.server.SettlePaymentWithExtensions(
				ctx, payload, requirements, nil, declaredExtensions, x402.SettlePhaseBeforeHandler,
			)
			if settleErr != nil {
				log.Printf("[x402] MCP before-handler settlement error: %v", settleErr)
				return w.settlementFailedResult(toolName, "Settlement failed"), nil
			}
			if !settleResp.Success {
				return w.settlementFailedResult(
					toolName, fmt.Sprintf("Settlement failed: %s", settleResp.ErrorReason)), nil
			}
			beforeHandlerSettlement = &x402.CompletedSettlement{
				Phase:        x402.SettlePhaseBeforeHandler,
				Flow:         flow,
				Result:       settleResp,
				Requirements: requirements,
			}
		}

		var settledPhases []x402.SettlePhase
		if beforeHandlerSettlement != nil {
			settledPhases = []x402.SettlePhase{x402.SettlePhaseBeforeHandler}
		}
		dispatcher := w.server.CreatePaymentCancellationDispatcherWithExtensions(
			ctx, payload, requirements, declaredExtensions, settledPhases,
		)

		// OnBeforeExecution hook
		if w.config.Hooks != nil && w.config.Hooks.OnBeforeExecution != nil {
			ok, err := (*w.config.Hooks.OnBeforeExecution)(hookCtx)
			if err != nil {
				return w.paymentRequiredResult(toolName, fmt.Sprintf("before execution hook error: %v", err), nil), nil
			}
			if !ok {
				return w.paymentRequiredResult(toolName, "Execution aborted by OnBeforeExecution hook", nil), nil
			}
		}

		// Execute the original handler
		result, err := handler(ctx, request)
		if err != nil {
			cancelSettlement := dispatcher.Cancel(x402.VerifiedPaymentCancelOptions{
				Reason: x402.CancellationReasonHandlerThrew,
				Err:    err,
			})
			receipt := x402.BuildFailurePathSettlementResponse(
				cancelSettlement, beforeHandlerSettlement, &payload,
			)
			if receipt != nil {
				return w.internalServerErrorResult(receipt), nil
			}
			return nil, err
		}

		// OnAfterExecution hook (including IsError results; skipped on handler throw)
		if w.config.Hooks != nil && w.config.Hooks.OnAfterExecution != nil {
			mcpResult := callToolResultToMCPToolResult(result)
			afterCtx := AfterExecutionContext{
				ServerHookContext: hookCtx,
				Result:            mcpResult,
			}
			_ = (*w.config.Hooks.OnAfterExecution)(afterCtx) // Non-fatal
		}

		// If handler returned an error result, don't settle after-handler;
		// cancel and attach failure-path payment-response when present.
		if result.IsError {
			cancelSettlement := dispatcher.Cancel(x402.VerifiedPaymentCancelOptions{
				Reason: x402.CancellationReasonHandlerFailed,
			})
			receipt := x402.BuildFailurePathSettlementResponse(
				cancelSettlement, beforeHandlerSettlement, &payload,
			)
			if receipt != nil {
				if result.Meta == nil {
					result.Meta = mcp.Meta{}
				}
				result.Meta[PaymentResponseMetaKey] = receipt
			}
			return result, nil
		}

		return w.settlePaymentResult(
			ctx, hookCtx, payload, requirements, declaredExtensions, phases, result, beforeHandlerSettlement,
		)
	}
}

// settlePaymentResult settles (or echoes before-handler settle) and attaches
// payment-response meta. Used for successful tool results and SkipHandler.
func (w *PaymentWrapper) settlePaymentResult(
	ctx context.Context,
	hookCtx ServerHookContext,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	declaredExtensions map[string]interface{},
	phases x402.PaymentFlowPhases,
	result *mcp.CallToolResult,
	beforeHandlerSettlement *x402.CompletedSettlement,
) (*mcp.CallToolResult, error) {
	if result == nil {
		result = &mcp.CallToolResult{}
	}

	var settleResp *x402.SettleResponse
	if !phases.SettleAfterHandler {
		if beforeHandlerSettlement != nil {
			settleResp = beforeHandlerSettlement.Result
		}
	} else {
		var settleErr error
		settleResp, settleErr = w.server.SettlePaymentWithExtensions(
			ctx, payload, requirements, nil, declaredExtensions, x402.SettlePhaseAfterHandler,
		)
		if settleErr != nil {
			log.Printf("[x402] MCP settlement error: %v", settleErr)
			return w.settlementFailedResult(hookCtx.ToolName, "Settlement failed"), nil
		}
		if !settleResp.Success {
			return w.settlementFailedResult(
				hookCtx.ToolName, fmt.Sprintf("Settlement failed: %s", settleResp.ErrorReason)), nil
		}
	}

	// OnAfterSettlement hook
	if settleResp != nil && w.config.Hooks != nil && w.config.Hooks.OnAfterSettlement != nil {
		settlementCtx := SettlementContext{
			ServerHookContext: hookCtx,
			Settlement:        *settleResp,
		}
		_ = (*w.config.Hooks.OnAfterSettlement)(settlementCtx) // Non-fatal
	}

	if settleResp != nil {
		if result.Meta == nil {
			result.Meta = mcp.Meta{}
		}
		result.Meta[PaymentResponseMetaKey] = settleResp
	}

	return result, nil
}

// createSkipHandlerResult builds a tool result from the verifier's SkipHandler body.
func createSkipHandlerResult(body interface{}) *mcp.CallToolResult {
	var text string
	switch v := body.(type) {
	case string:
		text = v
	case nil:
		text = "{}"
	default:
		data, err := json.Marshal(v)
		if err != nil {
			text = fmt.Sprintf("%v", v)
		} else {
			text = string(data)
		}
	}

	result := &mcp.CallToolResult{
		Content: []mcp.Content{
			&mcp.TextContent{Text: text},
		},
	}
	if m, ok := body.(map[string]interface{}); ok {
		result.StructuredContent = m
	}
	return result
}

// parseArgsFromRequest extracts arguments from the request as map[string]interface{}.
func parseArgsFromRequest(request *mcp.CallToolRequest) map[string]interface{} {
	args := make(map[string]interface{})
	if request != nil && request.Params != nil && request.Params.Arguments != nil {
		if err := json.Unmarshal(request.Params.Arguments, &args); err != nil {
			return args
		}
	}
	return args
}

// buildToolResourceInfo builds ResourceInfo for an MCP tool from wrapper config.
func (w *PaymentWrapper) buildToolResourceInfo(toolName string) *types.ResourceInfo {
	if w.config.Resource != nil {
		info := *w.config.Resource
		if info.URL == "" && toolName != "" {
			info.URL = "mcp://tool/" + toolName
		}
		if info.Description == "" && toolName != "" {
			info.Description = "Tool: " + toolName
		}
		if info.MimeType == "" {
			info.MimeType = "application/json"
		}
		return &info
	}
	url := "mcp://tool/unknown"
	description := "Unknown tool"
	if toolName != "" {
		url = "mcp://tool/" + toolName
		description = "Tool: " + toolName
	}
	return &types.ResourceInfo{
		URL:         url,
		Description: description,
		MimeType:    "application/json",
	}
}

// paymentRequiredResult creates an MCP error result with payment required info.
// Per spec, sets both structuredContent and content[0].text with isError: true.
func (w *PaymentWrapper) paymentRequiredResult(toolName, errorMsg string, payload *types.PaymentPayload) *mcp.CallToolResult {
	resource := w.buildToolResourceInfo(toolName)

	var pr types.PaymentRequired
	if payload != nil {
		pr = w.server.CreatePaymentRequiredResponseWithPayload(
			w.config.Accepts, resource, errorMsg, w.config.Extensions, payload,
		)
	} else {
		pr = w.server.CreatePaymentRequiredResponse(
			w.config.Accepts, resource, errorMsg, w.config.Extensions,
		)
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
func (w *PaymentWrapper) settlementFailedResult(toolName, errorMsg string) *mcp.CallToolResult {
	return w.paymentRequiredResult(toolName, errorMsg, nil)
}

// internalServerErrorResult returns a generic internal error, optionally echoing
// a settlement receipt in _meta.
func (w *PaymentWrapper) internalServerErrorResult(settleResp *x402.SettleResponse) *mcp.CallToolResult {
	result := &mcp.CallToolResult{
		Content: []mcp.Content{
			&mcp.TextContent{Text: "Internal Server Error"},
		},
		IsError: true,
	}
	if settleResp != nil {
		result.Meta = mcp.Meta{PaymentResponseMetaKey: settleResp}
	}
	return result
}

// extractPaymentFromRequest extracts x402/payment from the request's _meta.
func extractPaymentFromRequest(request *mcp.CallToolRequest) interface{} {
	if request == nil || request.Params == nil {
		return nil
	}
	meta := request.Params.Meta
	if meta == nil {
		return nil
	}
	return meta[PaymentMetaKey]
}
