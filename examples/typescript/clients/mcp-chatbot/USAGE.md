# How to Use the OpenAI MCP Chatbot

## Quick Start

### 1. Setup Environment

```bash
cp .env-local .env
```

Edit `.env` and add:

```env
OPENAI_API_KEY=sk-your-actual-openai-key
EVM_PRIVATE_KEY=0xyour-actual-private-key
MCP_SERVER_URL=http://localhost:4022
```

### 2. Start MCP Server (Terminal 1)

```bash
cd ../../servers/mcp
pnpm dev
```

You should see:

```
🚀 x402 MCP Server running on http://localhost:4022
📋 Available tools:
   - get_weather (paid: $0.001)
   - ping (free)
```

### 3. Run Chatbot (Terminal 2)

```bash
cd examples/typescript/clients/mcp-chatbot
pnpm install  # First time only
pnpm dev
```

## Example Conversation

```
🤖 OpenAI + MCP Chatbot with x402 Payments
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ OpenAI client initialized
💳 Wallet address: 0x...
🔌 Connecting to MCP server: http://localhost:4022
✅ Connected to MCP server

📋 Discovering tools from MCP server...
Found 2 tools:
   💰 get_weather: Get current weather for a city. Requires payment of $0.001.
   🆓 ping: A free health check tool

✅ Converted to OpenAI tool format
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💬 Chat started! Try asking:
   - 'What's the weather in Tokyo?'
   - 'Can you ping the server?'
   - 'quit' to exit

You: What's the weather in Tokyo?

🔧 [Turn 1] LLM is calling 1 tool(s)...

   📞 Calling: get_weather
   📝 Args: {"city":"Tokyo"}

💰 Payment requested for tool: get_weather
   Amount: 1000 (0x036CbD53842c5426634e7929541eC2318f3dCF7e)
   Network: eip155:84532
   ✅ Approving payment...

   💳 Payment settled!
      Transaction: 0xabc123...
      Network: eip155:84532
   ✅ Result: {"city":"Tokyo","weather":"sunny","temperature":72}

🤖 Bot: The current weather in Tokyo is sunny with a temperature of 72°F.

You: Can you ping the server?

🔧 [Turn 1] LLM is calling 1 tool(s)...

   📞 Calling: ping
   📝 Args: {}
   ✅ Result: pong

🤖 Bot: The server is responding normally - ping returned "pong".

You: quit
👋 Goodbye!
```

## What MCP Client Methods Are Called

Watch the console output to see EXACTLY which methods are invoked:

### Startup (Lines 73-112)

```typescript
await mcpClient.connect(transport); // ← Touchpoint #1
const { tools } = await mcpClient.listTools(); // ← Touchpoint #2
```

### Chat Loop (Lines 181-183)

```typescript
const result = await mcpClient.callTool(name, args); // ← Touchpoint #3
// Called every time LLM wants to use a tool
```

### Shutdown (Line 266)

```typescript
await mcpClient.close(); // ← Touchpoint #4
```

**That's it! Only 4 methods used in a real chatbot.**

## Architecture Diagram

```
┌────────────────────────────────────────────────────────────┐
│                    Your Chatbot Process                     │
│                                                             │
│  ┌──────────────┐         ┌──────────────┐                │
│  │   OpenAI     │         │  MCP Client  │                │
│  │   GPT-4o     │         │   (x402)     │                │
│  └──────────────┘         └──────────────┘                │
│         ↕                         ↕                        │
│    Tool requests           Tool execution                  │
│    Tool results           (with payment)                   │
└────────────────────────────────────────────────────────────┘
                                   ↕
                            MCP Protocol
                            (JSON-RPC)
                                   ↕
                            ┌─────────────┐
                            │ MCP Server  │
                            │   (tools)   │
                            └─────────────┘
```

**Key Point**: OpenAI never talks to MCP directly. Your chatbot code bridges them.

## Customization

### Change Auto-Payment Behavior

```typescript
onPaymentRequested: async context => {
  // Show confirmation prompt
  const approved = await confirm(`Pay ${context.paymentRequired.accepts[0].amount}?`);
  return approved;
};
```

### Add More Tools

Just register them in the MCP server - the chatbot discovers them automatically via `listTools()`.

### Add Streaming

OpenAI supports streaming responses:

```typescript
const stream = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: conversationHistory,
  tools: openaiTools,
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

## Troubleshooting

### "Cannot find module 'openai'"

```bash
pnpm install
```

### "OPENAI_API_KEY not found"

- Get API key: https://platform.openai.com/api-keys
- Add to `.env` file

### "Cannot connect to MCP server"

- Make sure server is running: `cd ../../servers/mcp && pnpm dev`
- Check MCP_SERVER_URL in `.env`

### "Payment failed"

- Make sure wallet has funds on Base Sepolia
- Check EVM_PRIVATE_KEY is correct
- Verify facilitator is accessible
