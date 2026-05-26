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
uv sync
```

## Running

First, start the MCP server:

```bash
cd ../../servers/mcp
python main.py simple
```

Then run the client:

### Simple Mode (Recommended)

Uses the `wrap_mcp_client_with_payment_from_config` factory function for easy setup:

```bash
python main.py simple
```

### Advanced Mode

Uses `x402MCPClient` with manual setup for full control:

```bash
python main.py advanced
```

Advanced mode demonstrates:
- Manual MCP client and x402Client creation
- Client-side hooks (on_payment_required, on_before_payment, on_after_payment)
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
Payment made: False

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
Payment made: True

📦 Payment Receipt:
   Success: True
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

```python
x402_mcp = x402MCPClient(
    mcp_client,
    payment_client,
    # Enable automatic payment (default: True)
    auto_payment=True,

    # Custom approval logic (optional)
    on_payment_requested=lambda context: (
        print(f"Pay {context.payment_required.accepts[0].amount}?"),
        True  # or False to deny
    )[1],
)
```

### Hooks

```python
# Called before payment is made
x402_mcp.on_before_payment(lambda context: print(f"About to pay for: {context.tool_name}"))

# Called after payment settles
x402_mcp.on_after_payment(lambda context: print(f"Payment settled: {context.settle_response.transaction}"))
```
