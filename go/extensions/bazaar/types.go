package bazaar

// Re-export types from the shared types package for convenience
import "github.com/x402-foundation/x402/go/extensions/types"

// Re-export extension identifier
var BAZAAR = types.BAZAAR

// Re-export method constants
const (
	MethodGET    = types.MethodGET
	MethodHEAD   = types.MethodHEAD
	MethodDELETE = types.MethodDELETE
	MethodPOST   = types.MethodPOST
	MethodPUT    = types.MethodPUT
	MethodPATCH  = types.MethodPATCH
)

// Re-export body type constants
const (
	BodyTypeJSON     = types.BodyTypeJSON
	BodyTypeFormData = types.BodyTypeFormData
	BodyTypeText     = types.BodyTypeText
)

// Re-export MCP transport constants
const (
	TransportStreamableHTTP = types.TransportStreamableHTTP
	TransportSSE            = types.TransportSSE
)

// Re-export types
type (
	QueryParamMethods         = types.QueryParamMethods
	BodyMethods               = types.BodyMethods
	BodyType                  = types.BodyType
	QueryDiscoveryInfo        = types.QueryDiscoveryInfo
	QueryInput                = types.QueryInput
	BodyDiscoveryInfo         = types.BodyDiscoveryInfo
	BodyInput                 = types.BodyInput
	OutputInfo                = types.OutputInfo
	DiscoveryInfo             = types.DiscoveryInfo
	JSONSchema                = types.JSONSchema
	QueryDiscoveryExtension   = types.QueryDiscoveryExtension
	BodyDiscoveryExtension    = types.BodyDiscoveryExtension
	DiscoveryExtension        = types.DiscoveryExtension
	OutputConfig              = types.OutputConfig
	McpTransport              = types.McpTransport
	McpInput                  = types.McpInput
	McpDiscoveryInfo          = types.McpDiscoveryInfo
	McpDiscoveryExtension     = types.McpDiscoveryExtension
	DeclareMcpDiscoveryConfig = types.DeclareMcpDiscoveryConfig
)

// Re-export utility functions
var (
	IsQueryMethod = types.IsQueryMethod
	IsBodyMethod  = types.IsBodyMethod
)
