package mcp

import (
	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/types"
)

// Protocol constants for MCP x402 payment integration.
const (
	// MCP_PAYMENT_REQUIRED_CODE is the JSON-RPC error code for payment required (x402)
	MCP_PAYMENT_REQUIRED_CODE = 402

	// MCP_PAYMENT_META_KEY is the MCP _meta key for payment payload (client → server)
	MCP_PAYMENT_META_KEY = "x402/payment"

	// MCP_PAYMENT_RESPONSE_META_KEY is the MCP _meta key for payment response (server → client)
	MCP_PAYMENT_RESPONSE_META_KEY = "x402/payment-response"
)

// MCPToolContext provides context during tool execution
type MCPToolContext struct {
	ToolName  string
	Arguments map[string]interface{}
	Meta      map[string]interface{}
}

// PaymentRequiredContext is provided to onPaymentRequired hooks
type PaymentRequiredContext struct {
	ToolName        string
	Arguments       map[string]interface{}
	PaymentRequired types.PaymentRequired
}

// PaymentRequiredHookResult is returned from payment required hooks
type PaymentRequiredHookResult struct {
	Payment *types.PaymentPayload
	Abort   bool
}

// PaymentRequiredHook is called when a 402 response is received
type PaymentRequiredHook func(context PaymentRequiredContext) (*PaymentRequiredHookResult, error)

// BeforePaymentHook is called before payment is created
type BeforePaymentHook func(context PaymentRequiredContext) error

// AfterPaymentHook is called after payment is submitted
type AfterPaymentHook func(context AfterPaymentContext) error

// AfterPaymentContext is provided to after payment hooks
type AfterPaymentContext struct {
	ToolName       string
	PaymentPayload types.PaymentPayload
	Result         MCPToolResult
	SettleResponse *x402.SettleResponse
}

// Options configures x402MCPClient behavior
type Options struct {
	// AutoPayment enables automatic payment handling when a tool requires payment.
	// Defaults to true. When nil, defaults to true. Set to BoolPtr(false) to disable.
	AutoPayment *bool

	// OnPaymentRequested is called before creating a payment, allowing the caller
	// to approve or deny. Return (true, nil) to approve, (false, nil) to deny.
	OnPaymentRequested func(context PaymentRequiredContext) (bool, error)
}

// BoolPtr returns a pointer to the given bool value.
// This is a convenience helper for setting Options.AutoPayment.
//
// Example:
//
//	options := mcp.Options{AutoPayment: mcp.BoolPtr(false)}
func BoolPtr(b bool) *bool {
	return &b
}

// MCPToolResult represents an MCP tool call result
type MCPToolResult struct {
	Content           []MCPContentItem
	IsError           bool
	Meta              map[string]interface{}
	StructuredContent map[string]interface{}
}

// MCPContentItem represents an MCP content item
type MCPContentItem struct {
	Type string
	Text string
}

// MCPToolCallResult represents the result of a tool call with payment metadata
type MCPToolCallResult struct {
	Content         []MCPContentItem
	IsError         bool
	PaymentResponse *x402.SettleResponse
	PaymentMade     bool
}

// PaymentWrapperConfig configures payment wrapper behavior
type PaymentWrapperConfig struct {
	Accepts    []types.PaymentRequirements
	Resource   *ResourceInfo
	Hooks      *PaymentWrapperHooks
	Extensions map[string]interface{}
}

// ResourceInfo provides resource metadata. Alias for types.ResourceInfo for compatibility.
type ResourceInfo = types.ResourceInfo

// PaymentWrapperHooks provides server-side hooks
type PaymentWrapperHooks struct {
	OnBeforeExecution *BeforeExecutionHook
	OnAfterExecution  *AfterExecutionHook
	OnAfterSettlement *AfterSettlementHook
}

// ServerHookContext is provided to server-side hooks
type ServerHookContext struct {
	ToolName            string
	Arguments           map[string]interface{}
	PaymentRequirements types.PaymentRequirements
	PaymentPayload      types.PaymentPayload
}

// BeforeExecutionHook is called before tool execution (can abort)
type BeforeExecutionHook func(context ServerHookContext) (bool, error)

// AfterExecutionContext extends ServerHookContext with result
type AfterExecutionContext struct {
	ServerHookContext
	Result MCPToolResult
}

// AfterExecutionHook is called after tool execution
type AfterExecutionHook func(context AfterExecutionContext) error

// SettlementContext extends ServerHookContext with settlement
type SettlementContext struct {
	ServerHookContext
	Settlement x402.SettleResponse
}

// AfterSettlementHook is called after successful settlement
type AfterSettlementHook func(context SettlementContext) error

// PaymentRequiredError represents a payment required error
type PaymentRequiredError struct {
	Code            int
	Message         string
	PaymentRequired *types.PaymentRequired
}

func (e *PaymentRequiredError) Error() string {
	return e.Message
}

// DynamicPayTo resolves a payTo address dynamically based on tool call context.
// Use this type for custom server implementations that need per-request recipient resolution.
type DynamicPayTo func(context MCPToolContext) (string, error)

// DynamicPrice resolves a price dynamically based on tool call context.
// Use this type for custom server implementations that need per-request pricing.
type DynamicPrice func(context MCPToolContext) (x402.Price, error)

// SchemeRegistration represents a payment scheme registration
type SchemeRegistration struct {
	Network     x402.Network
	Client      x402.SchemeNetworkClient
	ClientV1    x402.SchemeNetworkClientV1
	X402Version int // 1 or 2 (defaults to 2)
}
