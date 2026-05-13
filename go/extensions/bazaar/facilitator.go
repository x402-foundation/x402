package bazaar

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
	"unicode"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/extensions/types"
	v1 "github.com/x402-foundation/x402/go/extensions/v1"
	x402types "github.com/x402-foundation/x402/go/types"
	"github.com/xeipuuv/gojsonschema"
	"golang.org/x/net/idna"
)

// ValidationResult represents the result of validating a discovery extension
type ValidationResult struct {
	Valid  bool
	Errors []string
}

// ValidateDiscoveryExtension validates a discovery extension's info against its schema
//
// Args:
//   - extension: The discovery extension containing info and schema
//
// Returns:
//   - ValidationResult indicating if the info matches the schema
//
// Example:
//
//	extension, _ := bazaar.DeclareDiscoveryExtension(...)
//	result := bazaar.ValidateDiscoveryExtension(extension)
//
//	if result.Valid {
//	    fmt.Println("Extension is valid")
//	} else {
//	    fmt.Println("Validation errors:", result.Errors)
//	}
func ValidateDiscoveryExtension(extension types.DiscoveryExtension) ValidationResult {
	// Convert schema to JSON
	schemaJSON, err := json.Marshal(extension.Schema)
	if err != nil {
		return ValidationResult{
			Valid:  false,
			Errors: []string{fmt.Sprintf("Failed to marshal schema: %v", err)},
		}
	}

	// Convert info to JSON
	infoJSON, err := json.Marshal(extension.Info)
	if err != nil {
		return ValidationResult{
			Valid:  false,
			Errors: []string{fmt.Sprintf("Failed to marshal info: %v", err)},
		}
	}

	// Create schema loader
	schemaLoader := gojsonschema.NewBytesLoader(schemaJSON)

	// Create document loader
	documentLoader := gojsonschema.NewBytesLoader(infoJSON)

	// Validate
	result, err := gojsonschema.Validate(schemaLoader, documentLoader)
	if err != nil {
		return ValidationResult{
			Valid:  false,
			Errors: []string{fmt.Sprintf("Schema validation failed: %v", err)},
		}
	}

	if result.Valid() {
		return ValidationResult{Valid: true}
	}

	// Collect errors
	var errors []string
	for _, desc := range result.Errors() {
		errors = append(errors, fmt.Sprintf("%s: %s", desc.Context().String(), desc.Description()))
	}

	return ValidationResult{
		Valid:  false,
		Errors: errors,
	}
}

type DiscoveredResource struct {
	ResourceURL   string
	Method        string
	ToolName      string
	X402Version   int
	DiscoveryInfo *types.DiscoveryInfo
	Description   string
	MimeType      string
	RouteTemplate string
	// Sanitized service metadata. See SanitizeResourceServiceMetadata for rules.
	ServiceName string
	Tags        []string
	IconUrl     string
}

// ExtractDiscoveredResourceFromPaymentPayload extracts a discovered resource from a client's payment payload and requirements.
// This is useful for facilitators processing payments in their hooks.
//
// Args:
//   - payloadBytes: Raw JSON bytes of the payment payload (client's payment)
//   - requirementsBytes: Raw JSON bytes of the payment requirements (what the client accepted)
//   - validate: Whether to validate the discovery info against the schema (default: true)
//
// Returns:
//   - DiscoveredResource with URL, method, version and discovery data, or nil if not found
//   - Error if extraction or validation fails
//
// Logic:
//   - V2: Reads PaymentPayload.extensions[bazaar] and PaymentPayload.resource
//   - V1: Reads PaymentRequirements.outputSchema and PaymentRequirements.resource
//
// Example:
//
//	discovered, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(
//	    ctx.PayloadBytes,
//	    ctx.RequirementsBytes,
//	    true, // validate
//	)
//	if err != nil {
//	    log.Printf("Failed to extract discovered resource: %v", err)
//	    return nil
//	}
//	if discovered != nil {
//	    // Catalog the discovered resource
//	}
func ExtractDiscoveredResourceFromPaymentPayload(
	payloadBytes []byte,
	requirementsBytes []byte,
	validate bool,
) (*DiscoveredResource, error) {
	// First detect version to know how to unmarshal
	var versionCheck struct {
		X402Version int `json:"x402Version"`
	}
	if err := json.Unmarshal(payloadBytes, &versionCheck); err != nil {
		return nil, fmt.Errorf("failed to parse version: %w", err)
	}

	var discoveryInfo *types.DiscoveryInfo
	var resourceURL string
	var description string
	var mimeType string
	var routeTemplate string
	var rawInput map[string]interface{}
	var serviceMetadata SanitizedResourceServiceMetadata
	version := versionCheck.X402Version

	switch version {
	case 2:
		// V2: Unmarshal full payload to access extensions and resource
		var payload x402.PaymentPayload
		if err := json.Unmarshal(payloadBytes, &payload); err != nil {
			return nil, fmt.Errorf("failed to unmarshal v2 payload: %w", err)
		}

		// Extract resource URL
		if payload.Resource != nil {
			resourceURL = payload.Resource.URL
			description = payload.Resource.Description
			mimeType = payload.Resource.MimeType
			serviceMetadata = SanitizeResourceServiceMetadata(payload.Resource)
		}

		// Extract discovery info from extensions
		if payload.Extensions != nil {
			if bazaarExt, ok := payload.Extensions[types.BAZAAR.Key()]; ok {
				// routeTemplate uses :param syntax (e.g. "/users/:userId", "/weather/:country/:city").
				// Must start with "/", must not contain ".." or "://".
				var rawTemplate string
				if m, ok := bazaarExt.(map[string]interface{}); ok {
					if v, ok := m["routeTemplate"]; ok {
						rawTemplate, _ = v.(string)
					}
					if infoMap, ok := m["info"].(map[string]interface{}); ok {
						if inputMap, ok := infoMap["input"].(map[string]interface{}); ok {
							rawInput = inputMap
						}
					}
				}
				if isValidRouteTemplate(rawTemplate) {
					routeTemplate = rawTemplate
				}

				extensionJSON, err := json.Marshal(bazaarExt)
				if err != nil {
					return nil, fmt.Errorf("failed to marshal bazaar extension: %w", err)
				}

				var extension types.DiscoveryExtension
				if err := json.Unmarshal(extensionJSON, &extension); err != nil {
					return nil, fmt.Errorf("v2 discovery extension extraction failed: %w", err)
				}

				if validate {
					result := ValidateDiscoveryExtension(extension)
					if !result.Valid {
						return nil, fmt.Errorf("v2 discovery extension validation failed: %s", result.Errors)
					}
				}
				discoveryInfo = &extension.Info
			}
		}
	case 1:
		// V1: Unmarshal requirements to access outputSchema
		var requirementsV1 x402types.PaymentRequirementsV1
		if err := json.Unmarshal(requirementsBytes, &requirementsV1); err != nil {
			return nil, fmt.Errorf("failed to unmarshal v1 requirements: %w", err)
		}

		// Extract resource URL from requirements
		resourceURL = requirementsV1.Resource
		description = requirementsV1.Description
		mimeType = requirementsV1.MimeType

		// Extract discovery info from outputSchema
		infoV1, err := v1.ExtractDiscoveryInfoV1(requirementsV1)
		if err != nil {
			return nil, fmt.Errorf("v1 discovery extraction failed: %w", err)
		}
		discoveryInfo = infoV1
	default:
		return nil, fmt.Errorf("unsupported version: %d", version)
	}

	// No discovery info found (not an error, just not discoverable)
	if discoveryInfo == nil {
		return nil, nil
	}

	// Extract method or toolName from discovery info.
	// For MCP, recover toolName from raw input if upstream deserialization produced QueryInput.
	method, toolName := extractMethodAndToolName(discoveryInfo, rawInput)

	if method == "" && toolName == "" {
		return nil, fmt.Errorf("failed to extract method/toolName from discovery info")
	}

	normalizedURL := normalizeResourceURL(resourceURL, routeTemplate)

	return &DiscoveredResource{
		ResourceURL:   normalizedURL,
		Description:   description,
		MimeType:      mimeType,
		Method:        method,
		ToolName:      toolName,
		X402Version:   version,
		DiscoveryInfo: discoveryInfo,
		RouteTemplate: routeTemplate,
		ServiceName:   serviceMetadata.ServiceName,
		Tags:          serviceMetadata.Tags,
		IconUrl:       serviceMetadata.IconUrl,
	}, nil
}

// routeTemplateRegex validates the overall shape of a routeTemplate:
// must start with "/" and contain only safe URL path characters and :param identifiers.
// Expected format: "/users/:userId", "/weather/:country/:city", "/api/v1/items".
var routeTemplateRegex = regexp.MustCompile(`^/[a-zA-Z0-9_/:.\-~%]+$`)

// isValidRouteTemplate checks whether a routeTemplate value is structurally valid.
//
// Expected format: ":param" segments using colon-prefixed identifiers
// (e.g. "/users/:userId", "/weather/:country/:city").
//
// The facilitator is a trust boundary: the client controls the payment payload and can modify
// routeTemplate before submission. A malicious value could cause the facilitator to catalog the
// payment under an arbitrary URL (catalog poisoning). This enforces minimal structural requirements:
//   - Must be a non-empty string starting with "/"
//   - Must match the safe URL path character set (alphanumeric, _, :, /, ., -, ~, %)
//   - Must not contain ".." (path traversal)
//   - Must not contain "://" (URL injection)
func isValidRouteTemplate(s string) bool {
	if s == "" {
		return false
	}
	if !routeTemplateRegex.MatchString(s) {
		return false
	}
	// Decode percent-encoding before traversal checks so that %2e%2e is caught.
	decoded, err := url.PathUnescape(s)
	if err != nil {
		return false
	}
	if strings.Contains(decoded, "..") {
		return false
	}
	if strings.Contains(decoded, "://") {
		return false
	}
	return true
}

// Maximum lengths for resource service metadata fields. Spec: see
// specs/extensions/bazaar.md "Service Metadata on `resource`".
const (
	maxServiceNameLen = 32
	maxTagLen         = 32
	maxTags           = 5
	maxIconURLLen     = 2048
)

// matches a bare IPv4 dotted-quad. IPv6 literals are detected via net.ParseIP.
var ipv4Regex = regexp.MustCompile(`^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$`)

// SSRF defense: any all-digit hostname is suspect because no legitimate DNS name
// is purely numeric. Catches decimal-encoded IPs (http://2130706433/ → 127.0.0.1)
// and short-form IPs (http://0/ → 0.0.0.0, treated as loopback on Linux).
var allDigitsRegex = regexp.MustCompile(`^\d+$`)

// SSRF defense: hex-encoded IPs (http://0x7f000001/ → 127.0.0.1) — same family
// of bypasses as the decimal form above.
var hexLiteralRegex = regexp.MustCompile(`(?i)^0x[0-9a-f]+$`)

// Printable ASCII range (U+0020–U+007E). serviceName and tags are constrained
// to this range so that String.length (UTF-16 code units) in TS, len() (code
// points) in Python, and len() (UTF-8 bytes) here all agree on the character
// count. Same convention as paymentidentifier.id.
var printableASCIIRegex = regexp.MustCompile(`^[\x20-\x7e]+$`)

// Loopback hostnames that must be rejected for SSRF defense. Includes the
// common /etc/hosts aliases on Linux/macOS (`localhost.localdomain`,
// `ip6-localhost`, `ip6-loopback`) — without these, a hostile provider could
// route the facilitator's image fetcher to its own loopback interface.
var loopbackHostnames = map[string]struct{}{
	"localhost":             {},
	"localhost.localdomain": {},
	"ip6-localhost":         {},
	"ip6-loopback":          {},
}

// hasControlChar reports whether s contains any ASCII control character
// (C0 range U+0000–U+001F or DEL U+007F). Used by isValidIconUrl on the raw
// URL byte string before parsing.
func hasControlChar(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c <= 0x1f || c == 0x7f {
			return true
		}
	}
	return false
}

// containsControlChar reports whether s contains any Unicode control character
// (Unicode category Cc). Defense-in-depth: the printable-ASCII regex used by
// isValidServiceName / sanitizeTags already rejects every control character,
// but this explicit check documents intent and would survive any future
// relaxation of the ASCII restriction.
func containsControlChar(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

// isValidServiceName checks whether a serviceName value is structurally valid
// for the bazaar resource.serviceName field. Non-empty string of printable
// ASCII (U+0020–U+007E), length ≤ 32.
//
// The ASCII restriction matches the paymentidentifier.id convention and keeps
// len() semantics identical across TS / Python / Go.
//
// Mirrors isValidServiceName (TypeScript) and _is_valid_service_name (Python).
// All three implementations must stay in sync.
func isValidServiceName(s string) bool {
	if s == "" {
		return false
	}
	if len(s) > maxServiceNameLen {
		return false
	}
	if containsControlChar(s) {
		return false
	}
	if !printableASCIIRegex.MatchString(s) {
		return false
	}
	return true
}

// sanitizeTags sanitizes a tags array. Drops entries that are not non-empty
// printable-ASCII strings of at most 32 characters, then truncates to the
// first 5 valid entries. Returns nil when nothing survives so the field can
// be omitted from the catalog.
//
// The ASCII restriction matches the paymentidentifier.id convention and keeps
// len() semantics identical across TS / Python / Go.
//
// Mirrors sanitizeTags (TypeScript) and _sanitize_tags (Python).
// All three implementations must stay in sync.
func sanitizeTags(tags []string) []string {
	if len(tags) == 0 {
		return nil
	}
	out := make([]string, 0, maxTags)
	// Case-insensitive dedup: keeps the first occurrence's casing.
	// Prevents catalog noise like ["Weather", "weather", "WEATHER"].
	seen := make(map[string]struct{}, maxTags)
	for _, t := range tags {
		if t == "" || len(t) > maxTagLen {
			continue
		}
		if containsControlChar(t) {
			continue
		}
		if !printableASCIIRegex.MatchString(t) {
			continue
		}
		key := strings.ToLower(t)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, t)
		if len(out) == maxTags {
			break
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// isValidIconUrl checks whether an iconUrl value is structurally safe for the
// bazaar resource.iconUrl field.
//
// Rules (see specs/extensions/bazaar.md "Service Metadata on `resource`"):
//   - String of length ≤ 2048
//   - No ASCII control characters
//   - Parses as an absolute http:// or https:// URL
//   - No userinfo (user@host)
//   - Host is IDN-normalized (UTS #46 via idna.Lookup.ToASCII) before checks,
//     so confusable full-width / Unicode forms (e.g. "ｌｏｃａｌｈｏｓｔ")
//     collapse to their ASCII canonical and get caught by the loopback check
//   - Host is not an IP literal (v4 or v6), not in the loopback set
//     (localhost, localhost.localdomain, ip6-localhost, ip6-loopback)
//   - Host is not a decimal IP encoding (e.g. 2130706433 → 127.0.0.1) or
//     hex literal (e.g. 0x7f000001) — common SSRF bypass forms
//
// Percent-decoding is applied to the hostname before IDN normalization, and
// IDN normalization runs before the IP / loopback checks (parallel to the
// routeTemplate decoder).
//
// Mirrors isValidIconUrl (TypeScript) and _is_valid_icon_url (Python).
// All three implementations must stay in sync.
func isValidIconUrl(s string) bool {
	if s == "" || len(s) > maxIconURLLen {
		return false
	}
	if hasControlChar(s) {
		return false
	}
	parsed, err := url.Parse(s)
	if err != nil {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	if parsed.User != nil {
		return false
	}
	host := parsed.Hostname()
	if host == "" {
		return false
	}
	decoded, err := url.PathUnescape(host)
	if err != nil {
		return false
	}
	// IDN/full-width normalization: e.g. "ｌｏｃａｌｈｏｓｔ" (full-width Latin)
	// → "localhost". Without this the loopback alias check would miss
	// confusable Unicode hostnames. idna.Lookup is the strict profile; it
	// rejects malformed IDN as well as normalizing.
	asciiHost, err := idna.Lookup.ToASCII(decoded)
	if err != nil {
		return false
	}
	host = strings.ToLower(asciiHost)
	if host == "" {
		return false
	}
	if _, isLoopback := loopbackHostnames[host]; isLoopback {
		return false
	}
	if ipv4Regex.MatchString(host) {
		return false
	}
	if net.ParseIP(host) != nil {
		// Catches IPv6 literals (url.URL.Hostname() strips the brackets).
		return false
	}
	if strings.Contains(host, ":") {
		// Defensive: any colon-bearing host after IPv6 bracket-stripping.
		return false
	}
	if allDigitsRegex.MatchString(host) {
		return false
	}
	if hexLiteralRegex.MatchString(host) {
		return false
	}
	return true
}

// SanitizedResourceServiceMetadata holds the surviving service metadata fields
// after applying the soft-drop validation rules. Mirrors the
// `SanitizedResourceServiceMetadata` type in TypeScript and the
// `SanitizedResourceServiceMetadata` dataclass in Python.
type SanitizedResourceServiceMetadata struct {
	ServiceName string
	Tags        []string
	IconUrl     string
}

// SanitizeResourceServiceMetadata applies the bazaar service-metadata
// validation rules to a resource and returns only the fields that survive.
// Missing or invalid fields are dropped silently (soft-drop semantics — see
// spec).
func SanitizeResourceServiceMetadata(r *x402types.ResourceInfo) SanitizedResourceServiceMetadata {
	if r == nil {
		return SanitizedResourceServiceMetadata{}
	}
	out := SanitizedResourceServiceMetadata{}
	if isValidServiceName(r.ServiceName) {
		out.ServiceName = r.ServiceName
	}
	out.Tags = sanitizeTags(r.Tags)
	if isValidIconUrl(r.IconUrl) {
		out.IconUrl = r.IconUrl
	}
	return out
}

// stripQueryParams removes query parameters and fragments from a URL for cataloging
func stripQueryParams(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL // Return original if parsing fails
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

// normalizeResourceURL returns the canonical URL for discovery cataloging.
// If routeTemplate is non-empty (dynamic route), it replaces the URL path with the
// template and strips query/fragment. Otherwise it just strips query/fragment.
func normalizeResourceURL(rawURL, routeTemplate string) string {
	if routeTemplate != "" {
		parsed, err := url.Parse(rawURL)
		if err == nil {
			parsed.Path = routeTemplate
			parsed.RawQuery = ""
			parsed.Fragment = ""
			return parsed.String()
		}
	}
	return stripQueryParams(rawURL)
}

// ExtractDiscoveredResourceFromPaymentRequired extracts a discovered resource from a 402 PaymentRequired response.
// This is useful for clients/facilitators that receive a 402 response and want to discover resource capabilities.
//
// Args:
//   - paymentRequiredBytes: Raw JSON bytes of the 402 PaymentRequired response
//   - validate: Whether to validate the discovery info against the schema (default: true)
//
// Returns:
//   - DiscoveredResource with URL, method, version and discovery data, or nil if not found
//   - Error if extraction or validation fails
//
// Logic:
//   - V2: First checks PaymentRequired.extensions[bazaar]
//     If not found, falls back to PaymentRequired.accepts[0] extensions
//     Resource URL from PaymentRequired.resource
//   - V1: Checks PaymentRequired.accepts[0].outputSchema
//     Resource URL from PaymentRequired.accepts[0].resource
//
// Example:
//
//	// When receiving a 402 response
//	discovered, err := bazaar.ExtractDiscoveredResourceFromPaymentRequired(
//	    paymentRequiredBytes,
//	    true, // validate
//	)
//	if err != nil {
//	    log.Printf("Failed to extract discovered resource: %v", err)
//	    return nil
//	}
//	if discovered != nil {
//	    // Show UI for calling the discovered endpoint
//	}
func ExtractDiscoveredResourceFromPaymentRequired(
	paymentRequiredBytes []byte,
	validate bool,
) (*DiscoveredResource, error) {
	// First detect version to know how to unmarshal
	var versionCheck struct {
		X402Version int `json:"x402Version"`
	}
	if err := json.Unmarshal(paymentRequiredBytes, &versionCheck); err != nil {
		return nil, fmt.Errorf("failed to parse version: %w", err)
	}

	var discoveryInfo *types.DiscoveryInfo
	var resourceURL string
	var description string
	var mimeType string
	var routeTemplate string
	var rawInput map[string]interface{}
	var serviceMetadata SanitizedResourceServiceMetadata
	version := versionCheck.X402Version

	switch version {
	case 2:
		// V2: Unmarshal full PaymentRequired to access extensions and accepts
		var paymentRequired x402types.PaymentRequired
		if err := json.Unmarshal(paymentRequiredBytes, &paymentRequired); err != nil {
			return nil, fmt.Errorf("failed to unmarshal v2 payment required: %w", err)
		}

		// Extract resource URL
		if paymentRequired.Resource != nil {
			resourceURL = paymentRequired.Resource.URL
			description = paymentRequired.Resource.Description
			mimeType = paymentRequired.Resource.MimeType
			serviceMetadata = SanitizeResourceServiceMetadata(paymentRequired.Resource)
		}

		// First check PaymentRequired.extensions for bazaar extension
		if paymentRequired.Extensions != nil {
			if bazaarExt, ok := paymentRequired.Extensions[types.BAZAAR.Key()]; ok {
				// routeTemplate uses :param syntax (e.g. "/users/:userId", "/weather/:country/:city").
				// Must start with "/", must not contain ".." or "://".
				var rawTemplate string
				if m, ok := bazaarExt.(map[string]interface{}); ok {
					if v, ok := m["routeTemplate"]; ok {
						rawTemplate, _ = v.(string)
					}
					if infoMap, ok := m["info"].(map[string]interface{}); ok {
						if inputMap, ok := infoMap["input"].(map[string]interface{}); ok {
							rawInput = inputMap
						}
					}
				}
				if isValidRouteTemplate(rawTemplate) {
					routeTemplate = rawTemplate
				}

				extensionJSON, err := json.Marshal(bazaarExt)
				if err != nil {
					return nil, fmt.Errorf("failed to marshal bazaar extension: %w", err)
				}

				var extension types.DiscoveryExtension
				if err := json.Unmarshal(extensionJSON, &extension); err != nil {
					return nil, fmt.Errorf("v2 discovery extension extraction failed: %w", err)
				}

				if validate {
					result := ValidateDiscoveryExtension(extension)
					if !result.Valid {
						return nil, fmt.Errorf("v2 discovery extension validation failed: %s", result.Errors)
					}
				}
				discoveryInfo = &extension.Info
			}
		}

	case 1:
		// V1: Unmarshal PaymentRequiredV1 to access accepts array
		var paymentRequiredV1 x402types.PaymentRequiredV1
		if err := json.Unmarshal(paymentRequiredBytes, &paymentRequiredV1); err != nil {
			return nil, fmt.Errorf("failed to unmarshal v1 payment required: %w", err)
		}

		// Check if accepts array has elements
		if len(paymentRequiredV1.Accepts) == 0 {
			return nil, nil // No accepts, no discovery info
		}

		// Extract resource URL from first accept
		resourceURL = paymentRequiredV1.Accepts[0].Resource
		description = paymentRequiredV1.Accepts[0].Description
		mimeType = paymentRequiredV1.Accepts[0].MimeType

		// Extract discovery info from outputSchema
		infoV1, err := v1.ExtractDiscoveryInfoV1(paymentRequiredV1.Accepts[0])
		if err != nil {
			return nil, fmt.Errorf("v1 discovery extraction failed: %w", err)
		}
		discoveryInfo = infoV1
	default:
		return nil, fmt.Errorf("unsupported version: %d", version)
	}

	// No discovery info found (not an error, just not discoverable)
	if discoveryInfo == nil {
		return nil, nil
	}

	// Extract method or toolName from discovery info.
	// For MCP, recover toolName from raw input if upstream deserialization produced QueryInput.
	method, toolName := extractMethodAndToolName(discoveryInfo, rawInput)

	if method == "" && toolName == "" {
		return nil, fmt.Errorf("failed to extract method/toolName from discovery info")
	}

	normalizedURL := normalizeResourceURL(resourceURL, routeTemplate)

	return &DiscoveredResource{
		ResourceURL:   normalizedURL,
		Description:   description,
		MimeType:      mimeType,
		Method:        method,
		ToolName:      toolName,
		X402Version:   version,
		DiscoveryInfo: discoveryInfo,
		RouteTemplate: routeTemplate,
		ServiceName:   serviceMetadata.ServiceName,
		Tags:          serviceMetadata.Tags,
		IconUrl:       serviceMetadata.IconUrl,
	}, nil
}

func extractMethodAndToolName(
	discoveryInfo *types.DiscoveryInfo,
	rawInput map[string]interface{},
) (string, string) {
	if discoveryInfo == nil {
		return "", ""
	}

	if rawInputLooksLikeMCP(rawInput) {
		mcpInput, ok := discoveryInfo.Input.(types.McpInput)
		if !ok {
			mcpInput = types.McpInput{}
		}
		mcpInput = mergeRawMCPInput(rawInput, mcpInput)
		discoveryInfo.Input = mcpInput
		return "", strings.TrimSpace(mcpInput.ToolName)
	}

	switch input := discoveryInfo.Input.(type) {
	case types.QueryInput:
		return string(input.Method), ""
	case types.BodyInput:
		return string(input.Method), ""
	case types.McpInput:
		normalized := mergeRawMCPInput(rawInput, input)
		discoveryInfo.Input = normalized
		return "", strings.TrimSpace(normalized.ToolName)
	default:
		return "", ""
	}
}

func rawInputLooksLikeMCP(rawInput map[string]interface{}) bool {
	if len(rawInput) == 0 {
		return false
	}
	if strings.EqualFold(rawString(rawInput, "type"), "mcp") {
		return true
	}
	return rawString(rawInput, "toolName") != ""
}

func mergeRawMCPInput(rawInput map[string]interface{}, input types.McpInput) types.McpInput {
	if strings.TrimSpace(input.Type) == "" {
		input.Type = "mcp"
	}
	if strings.TrimSpace(input.ToolName) == "" {
		input.ToolName = rawString(rawInput, "toolName")
	}
	if strings.TrimSpace(string(input.Transport)) == "" {
		if transport := rawString(rawInput, "transport"); transport != "" {
			input.Transport = types.McpTransport(transport)
		}
	}
	if input.Description == "" {
		input.Description = rawString(rawInput, "description")
	}
	if input.InputSchema == nil {
		if schema, ok := rawInput["inputSchema"]; ok {
			input.InputSchema = schema
		}
	}
	if input.Example == nil {
		if example, ok := rawInput["example"]; ok {
			input.Example = example
		}
	}
	return input
}

func rawString(raw map[string]interface{}, key string) string {
	if len(raw) == 0 {
		return ""
	}
	value, ok := raw[key]
	if !ok {
		return ""
	}
	s, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(s)
}

// ExtractDiscoveryInfoFromExtension extracts discovery info from a v2 extension directly
//
// This is a lower-level function for when you already have the extension object.
// For general use, prefer the main ExtractDiscoveryInfo function.
//
// Args:
//   - extension: The discovery extension to extract info from
//   - validate: Whether to validate before extracting (default: true)
//
// Returns:
//   - The discovery info if valid
//   - Error if validation fails and validate is true
func ExtractDiscoveryInfoFromExtension(
	extension types.DiscoveryExtension,
	validate bool,
) (*types.DiscoveryInfo, error) {
	if validate {
		result := ValidateDiscoveryExtension(extension)
		if !result.Valid {
			errorMsg := "Unknown error"
			if len(result.Errors) > 0 {
				errorMsg = result.Errors[0]
				for i := 1; i < len(result.Errors); i++ {
					errorMsg += ", " + result.Errors[i]
				}
			}
			return nil, fmt.Errorf("invalid discovery extension: %s", errorMsg)
		}
	}

	return &extension.Info, nil
}

// ValidateAndExtract validates and extracts discovery info in one step
//
// This is a convenience function that combines validation and extraction,
// returning both the validation result and the info if valid.
//
// Args:
//   - extension: The discovery extension to validate and extract
//
// Returns:
//   - ValidationResult with the discovery info if valid
//
// Example:
//
//	extension, _ := bazaar.DeclareDiscoveryExtension(...)
//	result := bazaar.ValidateAndExtract(extension)
//
//	if result.Valid {
//	    // Use result.Info
//	} else {
//	    fmt.Println("Validation errors:", result.Errors)
//	}
func ValidateAndExtract(extension types.DiscoveryExtension) struct {
	Valid  bool
	Info   *types.DiscoveryInfo
	Errors []string
} {
	result := ValidateDiscoveryExtension(extension)

	if result.Valid {
		return struct {
			Valid  bool
			Info   *types.DiscoveryInfo
			Errors []string
		}{
			Valid: true,
			Info:  &extension.Info,
		}
	}

	return struct {
		Valid  bool
		Info   *types.DiscoveryInfo
		Errors []string
	}{
		Valid:  false,
		Errors: result.Errors,
	}
}
