package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	x402 "github.com/x402-foundation/x402/go/v2"
	mcp402 "github.com/x402-foundation/x402/go/v2/mcp"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	"github.com/x402-foundation/x402/go/v2/types"
)

// MasumiToolConfig configures WrapMasumiTool. Resource, Hooks and Extensions
// are passed to the per-call mcp.PaymentWrapper unchanged.
type MasumiToolConfig struct {
	Route      MasumiRoute
	Resource   *types.ResourceInfo
	Hooks      *mcp402.PaymentWrapperHooks
	Extensions map[string]interface{}
}

// WrapMasumiTool wraps an MCP tool handler for a Masumi route. Each call issues
// a fresh quote or resumes the one in the request's _meta payment, then hands
// off to an mcp.PaymentWrapper built on that quote, so its 402s carry the terms.
// The Go MCP wrapper takes fixed Accepts, hence the per-call wrapper.
func (s *ExactCardanoScheme) WrapMasumiTool(server *x402.X402ResourceServer, config MasumiToolConfig, handler mcp402.ToolHandler) (mcp402.ToolHandler, error) {
	if s.issuer == nil {
		return nil, errNoIssuer
	}
	template, err := s.template(config.Route)
	if err != nil {
		return nil, err
	}
	if server.GetRegisteredScheme(x402.Network(template.Network), cardano.SchemeExact) != s {
		return nil, fmt.Errorf("register this ExactCardanoScheme for %s before wrapping Masumi tools", template.Network)
	}
	return func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		toolName := ""
		var paid *types.PaymentPayload
		if request != nil && request.Params != nil {
			toolName = request.Params.Name
			paid = paymentFromMeta(request.Params.Meta)
		}
		resource := toolResource(config.Resource, config.Route.Resource, toolName)
		quote, err := s.quoteFor(ctx, template, paid, MasumiIssueContext{Resource: resource, Transport: request})
		if err != nil {
			return toolError(err), nil
		}
		accepts, err := server.BuildPaymentRequirementsFromConfig(ctx, x402.ResourceConfig{
			Scheme:            cardano.SchemeExact,
			PayTo:             template.PayTo,
			Price:             x402.AssetAmount{Asset: quote.Asset, Amount: quote.Amount, Extra: quote.Extra},
			Network:           x402.Network(template.Network),
			MaxTimeoutSeconds: template.MaxTimeoutSeconds,
			Extra:             map[string]interface{}{"assetTransferMethod": cardano.AssetTransferMethodMasumi},
		})
		if err != nil {
			return toolError(err), nil
		}
		wrapper := mcp402.NewPaymentWrapper(server, mcp402.PaymentWrapperConfig{
			Accepts:    accepts,
			Resource:   resource,
			Hooks:      config.Hooks,
			Extensions: config.Extensions,
		})
		return wrapper.Wrap(handler)(ctx, request)
	}, nil
}

// toolResource mirrors the MCP wrapper's resource derivation so the committed
// URL equals the 402's resource.
func toolResource(configured *types.ResourceInfo, routeURL, toolName string) *types.ResourceInfo {
	info := types.ResourceInfo{}
	if configured != nil {
		info = *configured
	}
	if info.URL == "" {
		info.URL = routeURL
	}
	if info.URL == "" {
		info.URL = "mcp://tool/unknown"
		if toolName != "" {
			info.URL = "mcp://tool/" + toolName
		}
	}
	if info.Description == "" && toolName != "" {
		info.Description = "Tool: " + toolName
	}
	if info.MimeType == "" {
		info.MimeType = "application/json"
	}
	return &info
}

func paymentFromMeta(meta mcp.Meta) *types.PaymentPayload {
	raw, ok := meta[mcp402.PaymentMetaKey]
	if !ok || raw == nil {
		return nil
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var payload types.PaymentPayload
	if json.Unmarshal(encoded, &payload) != nil || payload.X402Version != 2 {
		return nil
	}
	return &payload
}

// toolError answers like core's MCP wrapper: the detail is logged, never sent.
func toolError(err error) *mcp.CallToolResult {
	log.Printf("x402 cardano masumi tool: %v", err)
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: "Internal Server Error"}},
		IsError: true,
	}
}
