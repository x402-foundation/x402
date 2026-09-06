package mcp

import (
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// v1 payment-required as a Bazaar proxy would surface it (legacy network name,
// maxAmountRequired, no `accepted` wrapper).
func v1StructuredResult() *mcp.CallToolResult {
	return &mcp.CallToolResult{
		IsError: true,
		StructuredContent: map[string]any{
			"x402Version": float64(1),
			"error":       "X-PAYMENT header is required",
			"accepts": []any{
				map[string]any{
					"scheme":            "exact",
					"network":           "base",
					"maxAmountRequired": "10000",
					"resource":          "https://www.x402joker.com/api/buy",
					"payTo":             "0x2FE28Ddb76D6147D5888B1b725B0F2237676E7E6",
					"maxTimeoutSeconds": float64(120),
					"asset":             "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
					"extra":             map[string]any{"name": "USD Coin", "version": "2"},
				},
			},
		},
	}
}

func TestExtractPaymentRequiredV1_Structured(t *testing.T) {
	res := v1StructuredResult()

	// The v2 extractor must NOT coerce a v1 response (the old bug).
	if pr := extractPaymentRequired(res); pr != nil {
		t.Fatalf("extractPaymentRequired should return nil for v1, got %+v", pr)
	}

	prV1 := extractPaymentRequiredV1(res)
	if prV1 == nil {
		t.Fatal("extractPaymentRequiredV1 returned nil for a v1 response")
	}
	if len(prV1.Accepts) != 1 {
		t.Fatalf("expected 1 accept, got %d", len(prV1.Accepts))
	}
	if prV1.Accepts[0].MaxAmountRequired != "10000" || prV1.Accepts[0].Network != "base" {
		t.Fatalf("v1 accepts not parsed correctly: %+v", prV1.Accepts[0])
	}
}

func TestExtractPaymentRequiredV1_TextFallback(t *testing.T) {
	text := `{"x402Version":1,"accepts":[{"scheme":"exact","network":"base","maxAmountRequired":"10000","resource":"r","payTo":"0xabc","maxTimeoutSeconds":120,"asset":"0xdef","extra":{"name":"USD Coin","version":"2"}}]}`
	res := &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: text}}}

	if extractPaymentRequired(res) != nil {
		t.Fatal("v2 extractor matched a v1 text body")
	}
	prV1 := extractPaymentRequiredV1(res)
	if prV1 == nil || len(prV1.Accepts) != 1 {
		t.Fatalf("v1 text fallback failed: %+v", prV1)
	}
}

func TestExtractPaymentRequiredV2_StillWorks(t *testing.T) {
	res := &mcp.CallToolResult{
		IsError: true,
		StructuredContent: map[string]any{
			"x402Version": float64(2),
			"accepts": []any{
				map[string]any{
					"scheme": "exact", "network": "eip155:8453", "amount": "10000",
					"payTo": "0xabc", "maxTimeoutSeconds": float64(120), "asset": "0xdef",
				},
			},
		},
	}

	if extractPaymentRequiredV1(res) != nil {
		t.Fatal("v1 extractor matched a v2 response")
	}
	pr := extractPaymentRequired(res)
	if pr == nil || len(pr.Accepts) != 1 || pr.Accepts[0].Amount != "10000" {
		t.Fatalf("v2 extraction broken: %+v", pr)
	}
}
