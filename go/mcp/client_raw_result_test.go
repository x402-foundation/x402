package mcp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/types"
)

type nativeResultCaller func(context.Context, *mcp.CallToolParams) (*mcp.CallToolResult, error)

func (f nativeResultCaller) CallTool(ctx context.Context, params *mcp.CallToolParams) (*mcp.CallToolResult, error) {
	return f(ctx, params)
}

func TestX402MCPClient_PreservesRawResult(t *testing.T) {
	for _, tc := range []struct {
		name      string
		paid      bool
		direct    bool
		imageOnly bool
		toolError bool
		recover   bool
	}{
		{name: "free mixed content"},
		{name: "automatic payment mixed content", paid: true},
		{name: "automatic payment image only", paid: true, imageOnly: true},
		{name: "explicit payment", paid: true, direct: true},
		{name: "nonpayment tool error", toolError: true},
		{name: "recovered payment returns final result", paid: true, direct: true, recover: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			native := &mcp.CallToolResult{
				Content: []mcp.Content{
					&mcp.TextContent{
						Text:        `{"answer":42}`,
						Meta:        mcp.Meta{"fixture/text": "metadata"},
						Annotations: &mcp.Annotations{Priority: 0.7},
					},
					&mcp.ImageContent{Data: []byte{1, 2, 3}, MIMEType: "image/png"},
					&mcp.AudioContent{Data: []byte{4, 5, 6}, MIMEType: "audio/wav"},
					&mcp.ResourceLink{URI: "https://example.invalid/result", Name: "result"},
					&mcp.EmbeddedResource{Resource: &mcp.ResourceContents{URI: "fixture://result", Text: "embedded result"}},
				},
				StructuredContent: map[string]interface{}{"answer": 42},
				Meta:              mcp.Meta{"fixture/vendor": "metadata"},
				IsError:           tc.toolError,
			}
			if tc.imageOnly {
				native.Content = native.Content[1:2]
				native.StructuredContent = nil
			}
			if tc.paid {
				native.Meta[MCP_PAYMENT_RESPONSE_META_KEY] = x402.SettleResponse{
					Success: true, Transaction: "fixture-transaction", Network: "eip155:1",
				}
			}
			before, err := json.Marshal(native)
			if err != nil {
				t.Fatal(err)
			}

			requirements := testPaymentRequirements()
			challenge := mcpToolResultToCallToolResult(paymentRequiredMCPToolResult(t, types.PaymentRequired{
				X402Version: 2,
				Accepts:     []types.PaymentRequirements{requirements},
			}))
			calls := 0
			caller := nativeResultCaller(func(_ context.Context, params *mcp.CallToolParams) (*mcp.CallToolResult, error) {
				calls++
				if calls == 1 && ((tc.paid && !tc.direct) || tc.recover) {
					return challenge, nil
				}
				if (params.Meta[MCP_PAYMENT_META_KEY] != nil) != tc.paid {
					t.Fatal("unexpected payment payload presence")
				}
				return native, nil
			})
			scheme := &hookSchemeMCPClient{scheme: requirements.Scheme, signalRecover: tc.recover}
			paymentClient := x402.Newx402Client().DisableSpendControls().Register(x402.Network(requirements.Network), scheme)
			client := NewX402MCPClient(caller, paymentClient, Options{})
			var result *MCPToolCallResult
			if tc.direct {
				result, err = client.CallToolWithPayment(context.Background(), "fixture", nil, types.PaymentPayload{
					X402Version: 2, Accepted: requirements, Payload: map[string]interface{}{"fixture": true},
				})
			} else {
				result, err = client.CallTool(context.Background(), "fixture", nil)
			}
			if err != nil {
				t.Fatal(err)
			}
			if result.RawResult != native {
				t.Fatal("RawResult must expose the terminal SDK result, not a projection or payment challenge")
			}
			after, err := json.Marshal(result.RawResult)
			if err != nil || string(after) != string(before) {
				t.Fatalf("native result changed: %s (error: %v)", after, err)
			}
			if tc.imageOnly {
				if len(result.Content) != 0 {
					t.Fatal("image-only result changed the text projection")
				}
			} else if len(result.Content) != 1 || result.Content[0].Type != "text" || result.Content[0].Text != `{"answer":42}` {
				t.Fatalf("text projection changed: %+v", result.Content)
			}
			if result.IsError != tc.toolError || result.PaymentMade != tc.paid {
				t.Fatalf("result flags changed: %+v", result)
			}
			if tc.paid {
				if result.PaymentResponse == nil || !result.PaymentResponse.Success || result.PaymentResponse.Transaction != "fixture-transaction" || result.PaymentResponse.Network != x402.Network(requirements.Network) {
					t.Fatalf("payment receipt changed: %+v", result.PaymentResponse)
				}
			} else if result.PaymentResponse != nil {
				t.Fatal("unexpected payment receipt")
			}
			wantCalls := 1
			if (tc.paid && !tc.direct) || tc.recover {
				wantCalls = 2
			}
			if calls != wantCalls {
				t.Fatalf("got %d calls, want %d", calls, wantCalls)
			}
		})
	}
}
