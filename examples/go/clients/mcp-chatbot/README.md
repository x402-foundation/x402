# OpenAI Chatbot with MCP Tools + x402 Payments

An interactive chatbot that uses OpenAI GPT for natural language, MCP for tool discovery/execution, and x402 for automatic payment of paid tools.

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   User Chat  │────▶│  OpenAI GPT  │────▶│  MCP Client  │────▶│  MCP Server  │
│   (stdin)    │     │  (reasoning) │     │  + x402      │     │  (tools)     │
│              │◀────│  (response)  │◀────│  (payment)   │◀────│  (paid/free) │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
```

## How It Works

1. **User types a message** (e.g., "What's the weather in Tokyo?")
2. **OpenAI GPT decides** which MCP tool to call based on the conversation
3. **x402 MCP client calls the tool** - if payment is required, it automatically creates and submits a payment
4. **Tool result is sent back to GPT** which formulates a natural language response
5. **Response is displayed** to the user

## Setup

1. Copy `.env-example` to `.env` and fill in your values:

```bash
cp .env-example .env
```

2. Configure environment variables:

   - `OPENAI_API_KEY`: Your OpenAI API key
   - `EVM_PRIVATE_KEY`: Your EVM wallet private key (must have testnet USDC)
   - `MCP_SERVER_URL`: MCP server URL (default: http://localhost:4022)

3. Install dependencies:

```bash
go mod download
```

## Running

First, start an MCP server (can be TypeScript, Python, or Go):

```bash
# Go server
cd ../../servers/mcp
go run . simple

# Or TypeScript server
cd ../../../../typescript/examples/servers/mcp
pnpm dev

# Or Python server
cd ../../../../python/examples/servers/mcp
python main.py simple
```

Then run the chatbot:

```bash
go run .
```

## Example Conversation

```
OpenAI + MCP Chatbot with x402 Payments
======================================================================
OpenAI client initialized
Wallet address: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
Connecting to MCP server: http://localhost:4022
Connected to MCP server

Discovering tools from MCP server...
Found 2 tools:
   [paid] get_weather: Get current weather for a city. Requires payment of $0.001.
   [free] ping: A free health check tool
Converted to OpenAI tool format
======================================================================

Chat started! Try asking:
   - 'What's the weather in Tokyo?'
   - 'Can you ping the server?'
   - 'quit' to exit

You: What's the weather in San Francisco?

  [Turn 1] LLM is calling 1 tool(s)...

   Calling: get_weather
   Args: {"city":"San Francisco"}

  Payment requested for tool: get_weather
   Amount: 1000 (0x036CbD53842c5426634e7929541eC2318f3dCF7e)
   Network: eip155:84532
   Approving payment...

   Payment settled!
      Transaction: 0x...
   Result: {"city": "San Francisco", "weather": "sunny", "temperature": 65}

Bot: The weather in San Francisco is sunny with a temperature of 65°F!

You: quit

Closing connections...
Goodbye!
```

## MCP Client Methods Used

This chatbot uses exactly **4 MCP client methods**:

| Method | Purpose | When Called |
|--------|---------|------------|
| `Connect()` | Establish connection | Once at startup |
| `ListTools()` | Discover available tools | Once after connection |
| `CallTool()` | Execute a tool (with auto-payment) | Each time GPT wants to use a tool |
| `Close()` | Clean shutdown | On exit (deferred) |

## Cross-Language Interop

This Go chatbot can connect to **any** x402 MCP server:

- **Go server**: `examples/go/servers/mcp/`
- **TypeScript server**: `examples/typescript/servers/mcp/`
- **Python server**: `examples/python/servers/mcp/`

All servers expose the same tools and x402 payment protocol, enabling full interoperability.

## Key Insights

- **Only 4 MCP methods needed** for a complete chatbot integration
- **Payment is transparent** - the x402 wrapper handles 402 responses automatically
- **OpenAI decides** when to use tools based on conversation context
- **Works with any x402 MCP server** regardless of implementation language
