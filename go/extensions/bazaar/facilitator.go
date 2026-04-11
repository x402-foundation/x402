package bazaar

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/extensions/types"
	v1 "github.com/x402-foundation/x402/go/extensions/v1"
	x402types "github.com/x402-foundation/x402/go/types"
	"github.com/xeipuuv/gojsonschema"
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

	// Extract method or toolName from discovery info
	method := ""
	toolName := ""
	switch input := discoveryInfo.Input.(type) {
	case types.QueryInput:
		method = string(input.Method)
	case types.BodyInput:
		method = string(input.Method)
	case types.McpInput:
		toolName = input.ToolName
	}

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

	// Extract method or toolName from discovery info
	method := ""
	toolName := ""
	switch input := discoveryInfo.Input.(type) {
	case types.QueryInput:
		method = string(input.Method)
	case types.BodyInput:
		method = string(input.Method)
	case types.McpInput:
		toolName = input.ToolName
	}

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
	}, nil
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
