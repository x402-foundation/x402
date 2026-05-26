# x402/mcp

MCP (Model Context Protocol) integration for the x402 payment protocol. This package enables paid tool calls in MCP servers and automatic payment handling in MCP clients.

## Installation

```bash
go get github.com/x402-foundation/x402/go/mcp
```

## Quick Start

### Server - Using Payment Wrapper

```go
package main

import (
    "context"
    "github.com/x402-foundation/x402/go/mcp"
    mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
    // Create x402 resource server
    resourceServer := x402.Newx402ResourceServer(...)
    resourceServer.Register("eip155:84532", evmServerScheme)
    
    // Build payment requirements
    accepts, _ := resourceServer.BuildPaymentRequirementsFromConfig(ctx, config)

    // Create payment wrapper
    wrapper := mcp.NewPaymentWrapper(resourceServer, mcp.PaymentWrapperConfig{
        Accepts: accepts,
        Resource: &mcp.ResourceInfo{URL: "mcp://tool/get_weather", Description: "Get weather"},
    })

    // Register paid tool - wrap handler (SDK-style)
    mcpServer.AddTool(&mcpsdk.Tool{Name: "get_weather", ...}, wrapper.Wrap(
        func(ctx context.Context, req *mcpsdk.CallToolRequest) (*mcpsdk.CallToolResult, error) {
            return &mcpsdk.CallToolResult{
                Content: []mcpsdk.Content{&mcpsdk.TextContent{Text: "Result"}},
            }, nil
        },
    ))
}
```

### Client - Wrap Session with x402

```go
package main

import (
    "context"
    "fmt"
    "log"
    "github.com/x402-foundation/x402/go/mcp"
    mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
    // Connect to MCP server using the official SDK
    mcpClient := mcpsdk.NewClient(&mcpsdk.Implementation{
        Name: "my-agent", Version: "1.0.0",
    }, nil)
    session, err := mcpClient.Connect(ctx, transport, nil)
    if err != nil {
        log.Fatal(err)
    }
    defer session.Close()

    // Wrap session with x402 payment handling (AutoPayment defaults to true)
    x402Mcp := mcp.NewX402MCPClientFromConfig(session, []mcp.SchemeRegistration{
        {Network: "eip155:84532", Client: evmClientScheme},
    }, mcp.Options{})

    // Call tools - payment handled automatically
    ctx := context.Background()
    result, err := x402Mcp.CallTool(ctx, "get_weather", map[string]interface{}{
        "city": "NYC",
    })
    if err != nil {
        log.Fatal(err)
    }
    fmt.Println(result)
}
```

## API Reference

### Client

#### `NewX402MCPClient`

Creates an x402 MCP client from an MCP session (MCPCaller) and payment client.

```go
paymentClient := x402.Newx402Client()
paymentClient.Register("eip155:84532", evmClientScheme)

x402Mcp := mcp.NewX402MCPClient(session, paymentClient, mcp.Options{})
```

#### `NewX402MCPClientFromConfig`

Creates a fully configured x402 MCP client with scheme registrations.
Pass `*mcp.ClientSession` from the official MCP SDK.

```go
x402Mcp := mcp.NewX402MCPClientFromConfig(session, []mcp.SchemeRegistration{
    {Network: "eip155:84532", Client: evmClientScheme},
}, mcp.Options{}) // AutoPayment defaults to true
```

### Server

#### `NewPaymentWrapper` + `Wrap`

For servers using the official `modelcontextprotocol/go-sdk`. The MCP SDK's `AddTool` expects
handlers with signature `(ctx, *mcp.CallToolRequest) → (*mcp.CallToolResult, error)`.

Supports server hooks (OnBeforeExecution, OnAfterExecution, OnAfterSettlement):

```go
wrapper := mcp.NewPaymentWrapper(resourceServer, mcp.PaymentWrapperConfig{
    Accepts: accepts,
    Resource: &mcp.ResourceInfo{URL: "mcp://tool/get_weather", Description: "Get weather"},
    Hooks: &mcp.PaymentWrapperHooks{
        OnBeforeExecution: &beforeExecHook,
        OnAfterExecution:  &afterExecHook,
        OnAfterSettlement: &afterSettleHook,
    },
})
wrappedHandler := wrapper.Wrap(func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
    return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "result"}}}, nil
})
mcpServer.AddTool(tool, wrappedHandler)
```

### Utilities

#### Error Handling

```go
// Create payment required error
err := mcp.CreatePaymentRequiredError("Payment required", &paymentRequired)

// Check if error is payment required
if mcp.IsPaymentRequiredError(err) {
    paymentErr := err.(*mcp.PaymentRequiredError)
    // Handle payment required
}

// Extract PaymentRequired from JSON-RPC error
pr, err := mcp.ExtractPaymentRequiredFromError(jsonRpcError)
```

#### Type Guards

```go
// Check if value is an object
if mcp.IsObject(value) {
    obj := value.(map[string]interface{})
    // Use obj
}
```

## Constants

- `MCP_PAYMENT_REQUIRED_CODE` - JSON-RPC error code for payment required (402)
- `MCP_PAYMENT_META_KEY` - MCP _meta key for payment payload ("x402/payment")
- `MCP_PAYMENT_RESPONSE_META_KEY` - MCP _meta key for payment response ("x402/payment-response")

## Types

### Client Types

- `X402MCPClient` - x402-enabled MCP client
- `Options` - Options for x402 MCP client behavior (AutoPayment defaults to true)
- `SchemeRegistration` - Payment scheme registration for factory functions
- `MCPToolCallResult` - Result of a tool call with payment metadata
- `PaymentRequiredContext` - Context provided to payment required hooks
- `PaymentRequiredHookResult` - Result from payment required hook

### Server Types

- `PaymentWrapperConfig` - Configuration for payment wrapper
- `ServerHookContext` - Context provided to server-side hooks
- `AfterExecutionContext` - Context for after execution hook
- `SettlementContext` - Context for settlement hooks

### Hook Types

- `PaymentRequiredHook` - Hook called when payment is required
- `BeforePaymentHook` - Hook called before payment creation
- `AfterPaymentHook` - Hook called after payment submission
- `BeforeExecutionHook` - Hook called before tool execution
- `AfterExecutionHook` - Hook called after tool execution
- `AfterSettlementHook` - Hook called after settlement

## Examples

See the [examples directory](../../examples) for complete examples.

## License

Copyright (c) Coinbase, Inc.
