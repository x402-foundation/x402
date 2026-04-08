package bazaar

import (
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/x402-foundation/x402/go/extensions/types"
	"github.com/x402-foundation/x402/go/http"
)

// bracketParamRegex matches [paramName] route segments (Next.js style).
var bracketParamRegex = regexp.MustCompile(`\[([^\]]+)\]`)

// colonParamRegex is a package-local alias for the shared regex in extensions/types.
var colonParamRegex = types.ColonParamRegex

// patternCache caches compiled capture regexes and param names per route pattern
// to avoid recompilation on every request.
type patternCacheEntry struct {
	regex      *regexp.Regexp
	paramNames []string
}

var patternCache sync.Map // map[string]*patternCacheEntry

// normalizeWildcardPattern converts wildcard * segments to :var1, :var2, etc.
func normalizeWildcardPattern(pattern string) string {
	if !strings.Contains(pattern, "*") {
		return pattern
	}
	segments := strings.Split(pattern, "/")
	counter := 0
	for i, seg := range segments {
		if seg == "*" {
			counter++
			segments[i] = fmt.Sprintf(":var%d", counter)
		}
	}
	return strings.Join(segments, "/")
}

type bazaarResourceServerExtension struct{}

func (e *bazaarResourceServerExtension) Key() string {
	return types.BAZAAR.Key()
}

// extractDynamicRouteInfo converts a parameterized route pattern into a :param template
// and extracts concrete param values from the URL path in a single call.
// Supports both [param] (Next.js) and :param (Express) syntax. The output routeTemplate
// always uses :param syntax regardless of input format.
// Returns an empty routeTemplate and nil pathParams when routePattern has no param segments.
func extractDynamicRouteInfo(routePattern, urlPath string) (routeTemplate string, pathParams map[string]string) {
	hasBracket := bracketParamRegex.MatchString(routePattern)
	hasColon := colonParamRegex.MatchString(routePattern)
	if !hasBracket && !hasColon {
		return "", nil
	}
	// When both [param] and :param are present, normalize brackets to colons first
	// so all params are extracted uniformly.
	normalizedPattern := routePattern
	if hasBracket {
		normalizedPattern = bracketParamRegex.ReplaceAllString(routePattern, ":$1")
	}
	routeTemplate = normalizedPattern
	pathParams = extractPathParams(normalizedPattern, urlPath, false)
	return
}

// getOrCompilePattern returns a cached capture regex and param names for the given
// route pattern, compiling and caching on first access.
func getOrCompilePattern(routePattern string, isBracket bool) *patternCacheEntry {
	if cached, ok := patternCache.Load(routePattern); ok {
		return cached.(*patternCacheEntry)
	}

	paramRegex := colonParamRegex
	if isBracket {
		paramRegex = bracketParamRegex
	}
	matches := paramRegex.FindAllStringSubmatch(routePattern, -1)
	paramNames := make([]string, 0, len(matches))
	for _, m := range matches {
		paramNames = append(paramNames, m[1])
	}

	parts := paramRegex.Split(routePattern, -1)
	regexParts := make([]string, 0, len(parts)+len(paramNames))
	for i, part := range parts {
		regexParts = append(regexParts, regexp.QuoteMeta(part))
		if i < len(paramNames) {
			regexParts = append(regexParts, "([^/]+)")
		}
	}
	captureRegex, err := regexp.Compile("^" + strings.Join(regexParts, "") + "$")
	if err != nil {
		return &patternCacheEntry{paramNames: paramNames}
	}

	entry := &patternCacheEntry{regex: captureRegex, paramNames: paramNames}
	patternCache.Store(routePattern, entry)
	return entry
}

// extractPathParams extracts concrete path parameter values by matching a URL path
// against a route pattern containing [paramName] or :paramName segments.
func extractPathParams(routePattern, urlPath string, isBracket bool) map[string]string {
	entry := getOrCompilePattern(routePattern, isBracket)
	if entry.regex == nil {
		return map[string]string{}
	}

	submatches := entry.regex.FindStringSubmatch(urlPath)
	if submatches == nil {
		return map[string]string{}
	}

	result := make(map[string]string, len(entry.paramNames))
	for i, name := range entry.paramNames {
		if i+1 < len(submatches) {
			result[name] = submatches[i+1]
		}
	}
	return result
}

func (e *bazaarResourceServerExtension) EnrichDeclaration(
	declaration interface{},
	transportContext interface{},
) interface{} {
	httpContext, ok := transportContext.(http.HTTPRequestContext)
	if !ok {
		return declaration
	}

	extension, ok := declaration.(types.DiscoveryExtension)
	if !ok {
		return declaration
	}

	// MCP extensions pass through unchanged — they don't need HTTP method narrowing
	// or dynamic route extraction.
	if _, ok := extension.Info.Input.(types.McpInput); ok {
		return declaration
	}

	method := httpContext.Method

	if queryInput, ok := extension.Info.Input.(types.QueryInput); ok {
		queryInput.Method = types.QueryParamMethods(method)
		extension.Info.Input = queryInput
	} else if bodyInput, ok := extension.Info.Input.(types.BodyInput); ok {
		bodyInput.Method = types.BodyMethods(method)
		extension.Info.Input = bodyInput
	}

	if inputSchema, ok := extension.Schema["properties"].(map[string]interface{}); ok {
		if input, ok := inputSchema["input"].(map[string]interface{}); ok {
			if required, ok := input["required"].([]string); ok {
				hasMethod := false
				for _, r := range required {
					if r == "method" {
						hasMethod = true
						break
					}
				}
				if !hasMethod {
					input["required"] = append(required, "method")
				}
			}
		}
	}

	// Dynamic routes: translate [param]/:param → :param for the routeTemplate catalog key;
	// pathParams carries runtime values (distinct from pathParamsSchema in the declaration).
	// Wildcard * segments are auto-converted to :var1, :var2, etc. for catalog normalization.
	var urlPath string
	if httpContext.Adapter != nil {
		urlPath = httpContext.Adapter.GetPath()
	}
	normalizedPattern := normalizeWildcardPattern(httpContext.RoutePattern)
	routeTemplate, pathParams := extractDynamicRouteInfo(normalizedPattern, urlPath)
	if routeTemplate != "" {
		// Widen map[string]string to map[string]interface{} for the wire-level PathParams field
		pathParamsIface := make(map[string]interface{}, len(pathParams))
		for k, v := range pathParams {
			pathParamsIface[k] = v
		}

		// Update input with pathParams
		if queryInput, ok := extension.Info.Input.(types.QueryInput); ok {
			queryInput.PathParams = pathParamsIface
			extension.Info.Input = queryInput
		} else if bodyInput, ok := extension.Info.Input.(types.BodyInput); ok {
			bodyInput.PathParams = pathParamsIface
			extension.Info.Input = bodyInput
		}

		// Ensure pathParams is allowed in the schema (additionalProperties: false would reject it)
		if schemaProps, ok := extension.Schema["properties"].(map[string]interface{}); ok {
			if inputSchema, ok := schemaProps["input"].(map[string]interface{}); ok {
				if props, ok := inputSchema["properties"].(map[string]interface{}); ok {
					if _, hasPathParams := props["pathParams"]; !hasPathParams {
						props["pathParams"] = map[string]interface{}{"type": "object"}
					}
				}
			}
		}

		extension.RouteTemplate = routeTemplate
		return extension
	}

	return extension
}

var BazaarResourceServerExtension = &bazaarResourceServerExtension{}
