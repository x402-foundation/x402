// MCP E2E Test Client with x402 Payment Support.
//
// Thin MCP transport over the same multi-network x402 client the go-http
// e2e client shares (see e2eclient.BuildPaymentClient): connects over SSE,
// calls the tool named by ENDPOINT_PATH with no arguments, and outputs a
// structured JSON result for the e2e test framework to parse.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	e2eclient "github.com/x402-foundation/x402/e2e/clients/go"
	mcp402 "github.com/x402-foundation/x402/go/v2/mcp"
	batchedclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/client"
	"github.com/x402-foundation/x402/go/v2/types"
)

func main() {
	ctx := context.Background()

	serverURL := os.Getenv("RESOURCE_SERVER_URL")
	if serverURL == "" {
		e2eclient.OutputError("RESOURCE_SERVER_URL is required")
		return
	}

	toolName := os.Getenv("ENDPOINT_PATH") // tool name, e.g. "exact_evm_eip3009"
	if toolName == "" {
		e2eclient.OutputError("ENDPOINT_PATH is required")
		return
	}
	toolResourceURL := "mcp://tool/" + toolName

	pc := e2eclient.BuildPaymentClient()
	if pc == nil {
		return
	}

	mcpClient := mcp.NewClient(&mcp.Implementation{
		Name:    "x402-mcp-e2e-client",
		Version: "1.0.0",
	}, nil)

	session, err := mcpClient.Connect(ctx, &mcp.SSEClientTransport{
		Endpoint: serverURL + "/sse",
	}, nil)
	if err != nil {
		e2eclient.OutputError(fmt.Sprintf("Failed to connect to MCP server: %v", err))
		return
	}
	defer session.Close()

	x402Mcp := mcp402.NewX402MCPClient(session, pc.Client, mcp402.Options{AutoPayment: mcp402.BoolPtr(true)})

	issueRequest := func(ctx context.Context) e2eclient.StepResult {
		result, err := x402Mcp.CallTool(ctx, toolName, map[string]interface{}{})
		if err != nil {
			return e2eclient.StepResult{Success: false, Error: fmt.Sprintf("CallTool failed: %v", err)}
		}

		statusCode := 200
		success := !result.IsError
		if result.IsError {
			statusCode = 402
		} else if result.PaymentResponse != nil {
			success = result.PaymentResponse.Success
		}

		return e2eclient.StepResult{
			Success:         success,
			Data:            parseToolData(result.Content),
			StatusCode:      statusCode,
			PaymentResponse: result.PaymentResponse,
		}
	}

	// mcpRefundTransport bridges BatchSettlementEvmScheme.Refund()'s http.Client
	// dependency onto MCP tool calls, so the same cooperative-refund code path
	// used by the go-http client works unmodified over the MCP transport.
	refundTransport := &mcpRefundTransport{x402Mcp: x402Mcp, toolName: toolName}
	refund := func(ctx context.Context) e2eclient.StepResult {
		return e2eclient.IssueRefund(ctx, pc.BatchedScheme, toolResourceURL, &batchedclient.RefundOptions{
			HTTPClient: &http.Client{Transport: refundTransport},
		})
	}

	e2eclient.RunPhasedScenario(ctx, pc.BatchPhase, issueRequest, refund)
}

// parseToolData parses the first content item of an MCP tool result into
// the response body the e2e harness expects (mirrors what the equivalent
// HTTP route returns).
func parseToolData(content []mcp402.MCPContentItem) interface{} {
	if len(content) == 0 {
		return nil
	}
	var parsed interface{}
	if err := json.Unmarshal([]byte(content[0].Text), &parsed); err == nil {
		return parsed
	}
	return map[string]interface{}{"text": content[0].Text}
}

// mcpRefundTransport implements http.RoundTripper, bridging the HTTP
// requests BatchSettlementEvmScheme.Refund() issues (an unauthenticated probe
// GET, followed by a GET carrying a PAYMENT-SIGNATURE header) onto MCP tool
// calls against the same tool, translating the tool result back into an
// *http.Response carrying the PAYMENT-REQUIRED/PAYMENT-RESPONSE headers the
// refund flow expects.
type mcpRefundTransport struct {
	x402Mcp  *mcp402.X402MCPClient
	toolName string
}

func (t *mcpRefundTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	ctx := req.Context()

	paymentHeader := req.Header.Get("PAYMENT-SIGNATURE")
	if paymentHeader == "" {
		paymentRequired, err := t.x402Mcp.GetToolPaymentRequirements(ctx, t.toolName, map[string]interface{}{})
		if err != nil {
			return nil, err
		}
		if paymentRequired == nil {
			return emptyResponse(req, http.StatusOK, nil), nil
		}
		encoded, err := encodeHeaderJSON(paymentRequired)
		if err != nil {
			return nil, err
		}
		return emptyResponse(req, http.StatusPaymentRequired, map[string]string{"PAYMENT-REQUIRED": encoded}), nil
	}

	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(paymentHeader))
	if err != nil {
		return nil, fmt.Errorf("decode PAYMENT-SIGNATURE: %w", err)
	}
	var payload types.PaymentPayload
	if err := json.Unmarshal(decoded, &payload); err != nil {
		return nil, fmt.Errorf("unmarshal PAYMENT-SIGNATURE: %w", err)
	}

	result, err := t.x402Mcp.CallToolWithPayment(ctx, t.toolName, map[string]interface{}{}, payload)
	if err != nil {
		return nil, err
	}

	// Whether the settlement itself succeeded or failed, relay it as a 200 with
	// PAYMENT-RESPONSE — the refund client's own executeRefund() only special-cases
	// PAYMENT-RESPONSE on a 402 (an aborted settle attempt); a non-402 status with
	// a PAYMENT-RESPONSE header is decoded and returned as-is, success flag intact.
	if result.PaymentResponse != nil {
		encoded, err := encodeHeaderJSON(result.PaymentResponse)
		if err != nil {
			return nil, err
		}
		return emptyResponse(req, http.StatusOK, map[string]string{"PAYMENT-RESPONSE": encoded}), nil
	}

	if result.IsError {
		if paymentRequired := extractPaymentRequiredFromContent(result.Content); paymentRequired != nil {
			encoded, err := encodeHeaderJSON(paymentRequired)
			if err != nil {
				return nil, err
			}
			return emptyResponse(req, http.StatusPaymentRequired, map[string]string{"PAYMENT-REQUIRED": encoded}), nil
		}
		return emptyResponse(req, http.StatusInternalServerError, nil), nil
	}

	return emptyResponse(req, http.StatusOK, nil), nil
}

// extractPaymentRequiredFromContent parses a PaymentRequired out of a tool
// error result's first text content item, mirroring the mcp402 package's
// (unexported) extractPaymentRequired for *mcp.CallToolResult.
func extractPaymentRequiredFromContent(content []mcp402.MCPContentItem) *types.PaymentRequired {
	if len(content) == 0 {
		return nil
	}
	var obj map[string]interface{}
	if err := json.Unmarshal([]byte(content[0].Text), &obj); err != nil {
		return nil
	}
	if _, hasAccepts := obj["accepts"]; !hasAccepts {
		return nil
	}
	if _, hasVersion := obj["x402Version"]; !hasVersion {
		return nil
	}
	var pr types.PaymentRequired
	if err := json.Unmarshal([]byte(content[0].Text), &pr); err != nil {
		return nil
	}
	return &pr
}

// encodeHeaderJSON base64-encodes the JSON encoding of v, matching the
// PAYMENT-REQUIRED/PAYMENT-RESPONSE/PAYMENT-SIGNATURE header encoding used
// across the x402 HTTP transport.
func encodeHeaderJSON(v interface{}) (string, error) {
	bytes, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(bytes), nil
}

// emptyResponse builds a minimal *http.Response carrying the given status
// and headers, satisfying the (*http.Client).Do contract that refund.go relies on.
func emptyResponse(req *http.Request, status int, headers map[string]string) *http.Response {
	h := make(http.Header, len(headers))
	for k, v := range headers {
		h.Set(k, v)
	}
	return &http.Response{
		StatusCode: status,
		Header:     h,
		Body:       io.NopCloser(strings.NewReader("")),
		Request:    req,
	}
}
