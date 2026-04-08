package types

import (
	"encoding/json"
	"regexp"

	x402 "github.com/x402-foundation/x402/go"
)

// BAZAAR is the extension identifier for the Bazaar discovery extension.
var BAZAAR = x402.NewFacilitatorExtension("bazaar")

// ColonParamRegex matches :paramName route segments (Express style).
// Shared across http/server.go and extensions/bazaar/server.go to avoid drift.
var ColonParamRegex = regexp.MustCompile(`:([a-zA-Z_][a-zA-Z0-9_]*)`)

// Extension identifier constant for the Payment Identifier extension
const PAYMENT_IDENTIFIER = "payment-identifier"

// Payment identifier validation constants
const (
	PAYMENT_ID_MIN_LENGTH = 16
	PAYMENT_ID_MAX_LENGTH = 128
)

// PAYMENT_ID_PATTERN is a regex pattern for valid payment identifier characters
var PAYMENT_ID_PATTERN = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// QueryParamMethods are HTTP methods that use query parameters
type QueryParamMethods string

const (
	MethodGET    QueryParamMethods = "GET"
	MethodHEAD   QueryParamMethods = "HEAD"
	MethodDELETE QueryParamMethods = "DELETE"
)

// BodyMethods are HTTP methods that use request bodies
type BodyMethods string

const (
	MethodPOST  BodyMethods = "POST"
	MethodPUT   BodyMethods = "PUT"
	MethodPATCH BodyMethods = "PATCH"
)

// BodyType represents the type of request body
type BodyType string

const (
	BodyTypeJSON     BodyType = "json"
	BodyTypeFormData BodyType = "form-data"
	BodyTypeText     BodyType = "text"
)

// QueryDiscoveryInfo represents discovery info for query parameter methods (GET, HEAD, DELETE)
type QueryDiscoveryInfo struct {
	Input  QueryInput  `json:"input"`
	Output *OutputInfo `json:"output,omitempty"`
}

// QueryInput represents input information for query parameter methods
type QueryInput struct {
	Type        string                 `json:"type"` // "http"
	Method      QueryParamMethods      `json:"method"`
	QueryParams map[string]interface{} `json:"queryParams,omitempty"`
	PathParams  map[string]interface{} `json:"pathParams,omitempty"`
	Headers     map[string]string      `json:"headers,omitempty"`
}

// BodyDiscoveryInfo represents discovery info for body methods (POST, PUT, PATCH)
type BodyDiscoveryInfo struct {
	Input  BodyInput   `json:"input"`
	Output *OutputInfo `json:"output,omitempty"`
}

// BodyInput represents input information for body methods
type BodyInput struct {
	Type        string                 `json:"type"` // "http"
	Method      BodyMethods            `json:"method"`
	BodyType    BodyType               `json:"bodyType"`
	Body        interface{}            `json:"body"`
	QueryParams map[string]interface{} `json:"queryParams,omitempty"`
	PathParams  map[string]interface{} `json:"pathParams,omitempty"`
	Headers     map[string]string      `json:"headers,omitempty"`
}

// OutputInfo represents output information
type OutputInfo struct {
	Type    string      `json:"type,omitempty"`    // e.g., "json"
	Format  string      `json:"format,omitempty"`  // e.g., "application/json"
	Example interface{} `json:"example,omitempty"` // Example response
}

// McpTransport represents the transport protocol for MCP tools
type McpTransport string

const (
	TransportStreamableHTTP McpTransport = "streamable-http"
	TransportSSE            McpTransport = "sse"
)

// McpInput represents input information for MCP tool discovery
type McpInput struct {
	Type        string       `json:"type"` // "mcp"
	ToolName    string       `json:"toolName"`
	Description string       `json:"description,omitempty"`
	Transport   McpTransport `json:"transport,omitempty"`
	InputSchema interface{}  `json:"inputSchema"`
	Example     interface{}  `json:"example,omitempty"`
}

// McpDiscoveryInfo represents discovery info for MCP tools
type McpDiscoveryInfo struct {
	Input  McpInput    `json:"input"`
	Output *OutputInfo `json:"output,omitempty"`
}

// McpDiscoveryExtension represents a discovery extension for MCP tools
type McpDiscoveryExtension struct {
	Info   McpDiscoveryInfo `json:"info"`
	Schema JSONSchema       `json:"schema"`
}

// DeclareMcpDiscoveryConfig is the configuration for declaring an MCP discovery extension
type DeclareMcpDiscoveryConfig struct {
	ToolName    string       // MCP tool name
	Description string       // Human-readable description
	Transport   McpTransport // Transport protocol (streamable-http, sse)
	InputSchema interface{}  // JSON Schema for the tool's input
	Example     interface{}  // Example input
	Output      *OutputConfig
}

// DiscoveryInfo is a union type that can be either Query or Body discovery info
type DiscoveryInfo struct {
	Input  interface{} `json:"input"`
	Output *OutputInfo `json:"output,omitempty"`
}

// UnmarshalJSON custom unmarshaler to handle the union type
func (d *DiscoveryInfo) UnmarshalJSON(data []byte) error {
	var raw struct {
		Input  json.RawMessage `json:"input"`
		Output *OutputInfo     `json:"output,omitempty"`
	}

	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	// Check the type field first to discriminate between http and mcp inputs
	var checkFields struct {
		Type     string  `json:"type"`
		BodyType *string `json:"bodyType"`
	}
	// Intentionally ignore error - we're just probing for field existence
	_ = json.Unmarshal(raw.Input, &checkFields)

	switch {
	case checkFields.Type == "mcp":
		var mcpInput McpInput
		if err := json.Unmarshal(raw.Input, &mcpInput); err != nil {
			return err
		}
		d.Input = mcpInput
	case checkFields.BodyType != nil:
		var bodyInput BodyInput
		if err := json.Unmarshal(raw.Input, &bodyInput); err != nil {
			return err
		}
		d.Input = bodyInput
	default:
		var queryInput QueryInput
		if err := json.Unmarshal(raw.Input, &queryInput); err != nil {
			return err
		}
		d.Input = queryInput
	}

	d.Output = raw.Output
	return nil
}

// JSONSchema represents a JSON Schema object
type JSONSchema map[string]interface{}

// QueryDiscoveryExtension represents a discovery extension for query methods
type QueryDiscoveryExtension struct {
	Info   QueryDiscoveryInfo `json:"info"`
	Schema JSONSchema         `json:"schema"`
}

// BodyDiscoveryExtension represents a discovery extension for body methods
type BodyDiscoveryExtension struct {
	Info   BodyDiscoveryInfo `json:"info"`
	Schema JSONSchema        `json:"schema"`
}

// DiscoveryExtension is a union type that can be either Query or Body discovery extension
type DiscoveryExtension struct {
	Info          DiscoveryInfo `json:"info"`
	Schema        JSONSchema    `json:"schema"`
	RouteTemplate string        `json:"routeTemplate,omitempty"`
}

// DeclareQueryDiscoveryConfig is the configuration for declaring a query discovery extension
type DeclareQueryDiscoveryConfig struct {
	Method      QueryParamMethods      // HTTP method
	Input       map[string]interface{} // Example input data
	InputSchema JSONSchema             // JSON Schema for the input
	Output      *OutputConfig          // Output configuration
}

// DeclareBodyDiscoveryConfig is the configuration for declaring a body discovery extension
type DeclareBodyDiscoveryConfig struct {
	Method      BodyMethods   // HTTP method
	Input       interface{}   // Example input data
	InputSchema JSONSchema    // JSON Schema for the input
	BodyType    BodyType      // Body type (json, form-data, text)
	Output      *OutputConfig // Output configuration
}

// OutputConfig represents output configuration
type OutputConfig struct {
	Example interface{} // Example output data
	Schema  JSONSchema  // JSON Schema for the output example
}

// IsQueryMethod checks if a string is a query parameter method
func IsQueryMethod(method string) bool {
	switch QueryParamMethods(method) {
	case MethodGET, MethodHEAD, MethodDELETE:
		return true
	}
	return false
}

// IsBodyMethod checks if a string is a body method
func IsBodyMethod(method string) bool {
	switch BodyMethods(method) {
	case MethodPOST, MethodPUT, MethodPATCH:
		return true
	}
	return false
}
