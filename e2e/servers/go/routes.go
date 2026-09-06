package server

import (
	"fmt"
	"os"

	"github.com/x402-foundation/x402/go/v2/extensions/bazaar"
	"github.com/x402-foundation/x402/go/v2/extensions/eip2612gassponsor"
	"github.com/x402-foundation/x402/go/v2/extensions/erc20approvalgassponsor"
	"github.com/x402-foundation/x402/go/v2/extensions/types"
	x402http "github.com/x402-foundation/x402/go/v2/http"
)

// declareExtension maps a catalog extension id to the SDK call that declares it
// on a route. Declaration comes from mechanisms JSON `extensions` per route;
// process-level registration (e.g. bazaar on the HTTP middleware) is separate
// and enables enriching/honoring those declarations.
// transport is "http" (default) or "mcp"; the bazaar extension shapes its
// discovery declaration differently per transport (mirrors TS/Python declareExtension).
func declareExtension(extensionID string, route ResolvedRoute, transport string) (map[string]interface{}, error) {
	switch extensionID {
	case "bazaar":
		example, properties, required := RouteDiscoveryOutput()
		output := &types.OutputConfig{
			Example: example,
			Schema: types.JSONSchema{
				"properties": properties,
				"required":   required,
			},
		}

		if transport == "mcp" {
			discovery, err := bazaar.DeclareMcpDiscoveryExtension(types.DeclareMcpDiscoveryConfig{
				ToolName:    McpToolName(route.Path),
				Transport:   types.TransportSSE,
				InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
				Output:      output,
			})
			if err != nil {
				return nil, fmt.Errorf("route %s: %w", route.Path, err)
			}
			return map[string]interface{}{types.BAZAAR.Key(): discovery}, nil
		}

		discovery, err := bazaar.DeclareDiscoveryExtension(bazaar.MethodGET, nil, nil, "", output)
		if err != nil {
			return nil, fmt.Errorf("route %s: %w", route.Path, err)
		}
		return map[string]interface{}{types.BAZAAR.Key(): discovery}, nil
	case "eip2612GasSponsoring":
		return eip2612gassponsor.DeclareEip2612GasSponsoringExtension(), nil
	case "erc20ApprovalGasSponsoring":
		return erc20approvalgassponsor.DeclareExtension(), nil
	default:
		return nil, fmt.Errorf("route %s declares unknown extension %q", route.Path, extensionID)
	}
}

// buildRouteExtensions declares every extension a route lists, for the given transport.
func buildRouteExtensions(route ResolvedRoute, transport string) map[string]interface{} {
	extensions := map[string]interface{}{}
	for _, extensionID := range route.Extensions {
		declared, err := declareExtension(extensionID, route, transport)
		if err != nil {
			fmt.Printf("❌ %v\n", err)
			os.Exit(1)
		}
		for key, value := range declared {
			extensions[key] = value
		}
	}
	return extensions
}

// BuildResolvedRouteConfig builds the payment accepts + declared extensions for
// a single resolved route, shared by the HTTP RoutesConfig builder and the MCP
// server's per-tool payment wrapper setup.
func BuildResolvedRouteConfig(route ResolvedRoute, transport string) (x402http.PaymentOptions, map[string]interface{}) {
	accepts := x402http.PaymentOptions{
		{
			Scheme:  route.Scheme,
			PayTo:   route.PayTo,
			Price:   route.Price,
			Network: networkFor(route.Network),
			Extra:   route.Extra,
		},
	}
	return accepts, buildRouteExtensions(route, transport)
}

// BuildRoutes returns the payment RoutesConfig for Go e2e servers, derived from
// the mechanisms catalog. Routes whose network has no payee address configured
// are omitted by the resolver.
func BuildRoutes() x402http.RoutesConfig {
	routes := x402http.RoutesConfig{}

	for _, route := range ResolvedRoutes() {
		accepts, extensions := BuildResolvedRouteConfig(route, "http")

		config := x402http.RouteConfig{Accepts: accepts}
		if len(extensions) > 0 {
			config.Extensions = extensions
		}

		routes[fmt.Sprintf("GET %s", route.Path)] = config
	}

	return routes
}
