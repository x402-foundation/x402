# MCP Client with x402 Payment Support

This example demonstrates how to create an MCP (Model Context Protocol) client that can automatically pay for tool calls using the x402 payment protocol.

## Overview

The client connects to an x402-enabled MCP server and:
1. Discovers available tools
2. Calls a free tool (ping)
3. Calls a paid tool (get_weather) with automatic payment
4. Shows how to check payment requirements before calling

## Setup

1. Copy `.env-local` to `.env` and fill in your values:

```bash
cp .env-local .env
```

2. Configure environment variables:
   - `EVM_PRIVATE_KEY`: Your EVM wallet private key (must have testnet funds)
   - `MCP_SERVER_URL`: MCP server URL (default: http://localhost:4022)

3. Install dependencies:

```bash
pnpm install
```

## Running

First, start the MCP server:

```bash
cd ../../../servers/mcp
pnpm dev
```

Then run the client:

### Simple Mode (Recommended)

Uses the `createX402MCPClient` factory function for easy setup:

```bash
pnpm dev
```

### Advanced Mode

Uses `x402MCPClient` with manual setup for full control:

```bash
pnpm dev:advanced
```

Advanced mode demonstrates:
- Manual MCP client and x402Client creation
- Client-side hooks (onPaymentRequired, onBeforePayment, onAfterPayment)
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

### x402MCPClientOptions

```typescript
const x402Mcp = new x402MCPClient(mcpClient, paymentClient, {
  // Enable automatic payment (default: true)
  autoPayment: true,

  // Custom approval logic (optional)
  onPaymentRequested: async (context) => {
    console.log(`Pay ${context.paymentRequired.accepts[0].amount}?`);
    return true; // or false to deny
  },
});
```

### Hooks

```typescript
// Called before payment is made
x402Mcp.onBeforePayment(async (context) => {
  console.log("About to pay for:", context.toolName);
});

// Called after payment settles
x402Mcp.onAfterPayment(async (context) => {
  console.log("Payment settled:", context.settleResponse?.transaction);
});
```
