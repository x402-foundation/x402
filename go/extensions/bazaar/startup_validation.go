package bazaar

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/x402-foundation/x402/go/v2/extensions/types"
	x402http "github.com/x402-foundation/x402/go/v2/http"
)

var httpVerbRE = regexp.MustCompile(`(?i)^(GET|POST|PUT|PATCH|DELETE|HEAD)\b`)

// withSyntheticMethod injects a synthetic method for startup schema validation only.
//
// Pre-enrichment HTTP extensions intentionally omit method; it is added at request
// time by BazaarResourceServerExtension. Without a synthetic value, jsonschema reports
// a false positive for the required method field.
//
// Priority: (1) route pattern verb (e.g. "GET /api"), (2) body vs query inference.
// Returns the same extension unchanged if method is already present.
func withSyntheticMethod(ext types.DiscoveryExtension, pattern string) types.DiscoveryExtension {
	switch input := ext.Info.Input.(type) {
	case types.QueryInput:
		if input.Method != "" {
			return ext
		}
		input.Method = types.QueryParamMethods(inferSyntheticMethod(pattern, input))
		ext.Info.Input = input
	case types.BodyInput:
		if input.Method != "" {
			return ext
		}
		input.Method = types.BodyMethods(inferSyntheticMethod(pattern, input))
		ext.Info.Input = input
	}
	return ext
}

func inferSyntheticMethod(pattern string, input interface{}) string {
	if matches := httpVerbRE.FindStringSubmatch(pattern); len(matches) > 1 {
		return strings.ToUpper(matches[1])
	}

	switch in := input.(type) {
	case types.BodyInput:
		if in.Body != nil || in.BodyType != "" {
			return "POST"
		}
	case types.QueryInput:
		// Query-only extensions default to GET below.
	}

	return "GET"
}

// ValidateBazaarRouteExtensions validates bazaar extensions on all routes using
// JSON-schema validation. Emits warnings for invalid extensions but does not block startup.
func ValidateBazaarRouteExtensions(routes x402http.RoutesConfig) {
	for pattern, config := range routes {
		validateSingleBazaarExtension(pattern, config.Extensions)
	}
}

// ValidateBazaarRouteExtensionsFromServer validates bazaar extensions from pre-compiled routes.
func ValidateBazaarRouteExtensionsFromServer(server *x402http.HTTPServer) {
	for _, route := range server.GetCompiledRoutes() {
		pattern := route.Verb + " " + route.Regex.String()
		validateSingleBazaarExtension(pattern, route.Config.Extensions)
	}
}

func validateSingleBazaarExtension(pattern string, extensions map[string]interface{}) {
	extVal, ok := extensions[types.BAZAAR.Key()]
	if !ok || extVal == nil {
		return
	}

	switch v := extVal.(type) {
	case map[string]interface{}:
		if v["info"] == nil || v["schema"] == nil {
			fmt.Printf("x402 Warning: Route %q declares a bazaar extension but it is malformed "+
				"(expected an object with \"info\" and \"schema\" fields)\n", pattern)
			return
		}
	case types.DiscoveryExtension:
		if v.Schema == nil {
			fmt.Printf("x402 Warning: Route %q declares a bazaar extension but it is malformed "+
				"(expected an object with \"info\" and \"schema\" fields)\n", pattern)
			return
		}
	default:
		fmt.Printf("x402 Warning: Route %q declares a bazaar extension but it is malformed "+
			"(expected an object with \"info\" and \"schema\" fields)\n", pattern)
		return
	}

	extJSON, err := json.Marshal(extVal)
	if err != nil {
		return
	}
	var ext types.DiscoveryExtension
	if err := json.Unmarshal(extJSON, &ext); err != nil {
		return
	}
	specResult := ValidateDiscoveryExtensionSpec(ext)
	if !specResult.Valid {
		fmt.Printf("x402 Warning: Route %q has invalid bazaar extension: %s\n",
			pattern, strings.Join(specResult.Errors, ", "))
		return
	}
	result := ValidateDiscoveryExtension(withSyntheticMethod(ext, pattern))
	if !result.Valid {
		fmt.Printf("x402 Warning: Route %q has invalid bazaar extension: %s\n",
			pattern, strings.Join(result.Errors, ", "))
	}
}
