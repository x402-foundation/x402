# MCP Client with x402 Payment Support

This example demonstrates how to create an MCP (Model Context Protocol) client that can automatically pay for tool calls using the x402 payment protocol.

## Overview

The client connects to an x402-enabled MCP server and:
1. Discovers available tools
2. Calls a free tool (ping)
3. Calls a paid tool (get_weather) with automatic payment
4. Shows how to check payment requirements before calling

## Setup

1. Copy `.env-example` to `.env` and fill in your values:

```bash
cp .env-example .env
```

2. Configure environment variables:
   - `EVM_PRIVATE_KEY`: Your EVM wallet private key (must have testnet funds)
   - `MCP_SERVER_URL`: MCP server URL (default: http://localhost:4022)

3. Install dependencies:

```bash
go mod download
```

## Running

First, start the MCP server:

```bash
cd ../../servers/mcp
go run . simple
```

Then run the client:

### Simple Mode (Recommended)

Uses the `CreateX402MCPClient` factory function for easy setup:

```bash
go run . simple
```

### Advanced Mode

Uses `X402MCPClient` with manual setup for full control:

```bash
go run . advanced
```

Advanced mode demonstrates:
- Manual MCP client and x402Client creation
- Client-side hooks (OnPaymentRequired, OnBeforePayment, OnAfterPayment)
- Accessing underlying client instances

## Expected Output

```
🔌 Connecting to MCP server at: http://localhost:4022
💳 Using wallet: 0x...
✅ Connected to MCP server

📋 Discovering available tools...
Available tools:
   - get_weather: Get current weather for a city. Requires payment of $0.001.
   - ping: A free tool that returns pong

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🆓 Test 1: Calling free tool (ping)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Response: pong
Payment made: false

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 Test 2: Calling paid tool (get_weather)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💰 Payment required for tool: get_weather
   Amount: 1000 (0x036CbD53842c5426634e7929541eC2318f3dCF7e)
   Network: eip155:84532
   Approving payment...

Response: {
  "city": "San Francisco",
  "weather": "sunny",
  "temperature": 65
}
Payment made: true

📦 Payment Receipt:
   Success: true
   Transaction: 0x...

✅ Demo complete!
```

## Payment Flow

```
┌──────────────┐                    ┌──────────────┐
│  MCP Client  │                    │  MCP Server  │
└──────┬───────┘                    └──────┬───────┘
       │                                   │
       │  1. callTool("get_weather")       │
       │──────────────────────────────────▶│
       │                                   │
       │  2. 402 PaymentRequired           │
       │◀──────────────────────────────────│
       │                                   │
       │  3. createPaymentPayload()        │
       │  (signs transaction)              │
       │                                   │
       │  4. callTool + PaymentPayload     │
       │──────────────────────────────────▶│
       │                                   │
       │                    5. verify()    │
       │                    6. execute()   │
       │                    7. settle()    │
       │                                   │
       │  8. Result + SettleResponse       │
       │◀──────────────────────────────────│
       │                                   │
```

## Configuration Options

### X402MCPClientOptions

```go
x402Mcp := mcp.NewX402MCPClient(session, paymentClient, mcp.Options{
    // Enable automatic payment (default: true)
    AutoPayment: mcp.BoolPtr(true),

    // Custom approval logic (optional)
    OnPaymentRequested: func(context mcp.PaymentRequiredContext) (bool, error) {
        fmt.Printf("Pay %s?\n", context.PaymentRequired.Accepts[0].Amount)
        return true, nil // or false to deny
    },
})
```

Configure spend controls on the payment client, then wrap:

```go
paymentClient := x402.Newx402Client().
    Register("eip155:84532", evmClientScheme).
    SetSpendControls(x402.SpendControls{
        MaxAmountPerPayment: "$5",
        AllowedAssets: []x402.SpendControlAsset{
            {Network: "eip155:84532", Asset: "0xCustomToken"},
        },
    })
    // .DisableSpendControls() // any asset, no caps

x402Mcp := mcp.NewX402MCPClient(session, paymentClient, mcp.Options{
    AutoPayment: mcp.BoolPtr(true),
})
```

`NewX402MCPClientFromConfig` uses the default `$1` USD cap and default-asset allowlist from `Newx402Client()`.

### Hooks

```go
// Called before payment is made
x402Mcp.OnBeforePayment(func(context mcp.PaymentRequiredContext) error {
    fmt.Println("About to pay for:", context.ToolName)
    return nil
})

// Called after payment settles
x402Mcp.OnAfterPayment(func(context mcp.AfterPaymentContext) error {
    fmt.Println("Payment settled:", context.SettleResponse.Transaction)
    return nil
})
```
