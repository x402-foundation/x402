# OpenAI Chatbot with MCP Tools + x402 Payments

A complete chatbot implementation demonstrating how to integrate:

- **OpenAI GPT** for natural language understanding
- **MCP (Model Context Protocol)** for tool discovery and execution
- **x402 Payment Protocol** for automatic payment handling

This example shows the REAL MCP client usage patterns in production chatbots.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│              YOUR CHATBOT (Host Application)             │
│                                                          │
│  ┌──────────────┐              ┌──────────────┐        │
│  │   OpenAI     │◀────────────▶│  MCP Client  │        │
│  │   GPT-4o     │  Tool defs   │   (x402)     │        │
│  │              │  Tool results│              │        │
│  └──────────────┘              └──────────────┘        │
│         │                              │                │
│         │ Decides which tools          │ Executes       │
│         │ to call                      │ tools          │
└─────────┼──────────────────────────────┼────────────────┘
          │                              │
          │ (AI decision)                │ (MCP protocol)
          │                              ▼
          │                       ┌──────────────┐
          └──────────────────────▶│  MCP Server  │
                                  │   (tools)    │
                                  └──────────────┘
```

## How It Works

### 1. Startup: Discover Tools

```typescript
await mcpClient.connect(transport);
const { tools } = await mcpClient.listTools();
// Returns: [{ name: "get_weather", description: "...", inputSchema: {...} }]
```

### 2. Convert Tools to OpenAI Format

```typescript
const openaiTools = tools.map(tool => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  },
}));
```

### 3. Chat Loop

```typescript
// User says something
conversationHistory.push({ role: "user", content: "What's the weather in Tokyo?" });

// Send to OpenAI with available tools
const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: conversationHistory,
  tools: openaiTools, // ← MCP tools presented here
});

// OpenAI decides to call get_weather tool
// response.tool_calls = [{ function: { name: "get_weather", arguments: '{"city": "Tokyo"}' } }]
```

### 4. Execute Tools via MCP

```typescript
for (const toolCall of response.tool_calls) {
  // Execute via MCP client (payment handled automatically)
  const result = await mcpClient.callTool(
    toolCall.function.name,
    JSON.parse(toolCall.function.arguments),
  );

  // Send result back to OpenAI
  conversationHistory.push({
    role: "tool",
    tool_call_id: toolCall.id,
    content: result.content[0].text,
  });
}
```

### 5. Get Final Response

```typescript
// OpenAI processes tool results and responds to user
const finalResponse = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: conversationHistory, // Includes tool results
});

console.log("Bot:", finalResponse.choices[0].message.content);
```

## Setup

1. Copy `.env-local` to `.env` and configure:

```bash
cp .env-local .env
```

2. Add your API keys:

   - `OPENAI_API_KEY`: Get from https://platform.openai.com/api-keys
   - `EVM_PRIVATE_KEY`: Your wallet private key (needs funds on Base Sepolia)
   - `MCP_SERVER_URL`: MCP server URL (default: http://localhost:4022)

3. Install dependencies:

```bash
pnpm install
```

## Running

### Start MCP Server (Terminal 1)

```bash
cd ../../servers/mcp
pnpm dev
```

This starts the MCP server with tools:

- `get_weather` (paid: $0.001)
- `ping` (free)

### Run Chatbot (Terminal 2)

```bash
pnpm dev
```

## Example Conversation

```
You: What's the weather in San Francisco?

🔧 [Turn 1] LLM is calling 1 tool(s)...

   📞 Calling: get_weather
   📝 Args: {"city":"San Francisco"}

💰 Payment requested for tool: get_weather
   Amount: 1000 (0x...)
   Network: eip155:84532
   ✅ Approving payment...

   💳 Payment settled!
      Transaction: 0xabc123...
      Network: eip155:84532
   ✅ Result: {"city":"San Francisco","weather":"sunny","temperature":68}

🤖 Bot: The current weather in San Francisco is sunny with a temperature of 68°F.


You: Can you ping the server?

🔧 [Turn 1] LLM is calling 1 tool(s)...

   📞 Calling: ping
   📝 Args: {}
   ✅ Result: pong

🤖 Bot: The server is responding normally - ping returned "pong".


You: quit
👋 Goodbye!
```

## MCP Client Methods Actually Used

This chatbot uses **only 4 methods** from the MCP client:

1. ✅ `connect()` - Once at startup
2. ✅ `listTools()` - Once at startup
3. ✅ `callTool()` - Every time LLM calls a tool (THE MAIN ONE)
4. ✅ `close()` - Once at shutdown

**Other methods (readResource, getPrompt, ping, etc.) are NOT used** in basic chatbot flow.

## Payment Flow

When LLM calls a paid tool:

1. LLM decides: "I should call get_weather"
2. Host calls: `await mcpClient.callTool("get_weather", { city: "SF" })`
3. MCP server returns: 402 Payment Required
4. x402MCPClient automatically:
   - Extracts payment requirements
   - Calls `onPaymentRequested` hook (auto-approved)
   - Creates payment payload
   - Retries tool call with payment
5. MCP server:
   - Verifies payment
   - Executes tool
   - Returns result + settlement receipt
6. Host receives result and sends to OpenAI
7. OpenAI formats final response to user

## Key Insights

### The LLM Never Touches MCP

- OpenAI doesn't call MCP directly
- OpenAI only sees tool definitions and results
- Host application is the bridge

### Only 4 Methods Matter

- `connect()`, `listTools()`, `callTool()`, `close()`
- Everything else is edge cases

### Payment is Transparent

- LLM doesn't know about payment
- User doesn't need to approve each payment (if auto-approved)
- Payment happens automatically during tool execution

## Advanced Features (Not Shown)

If you wanted to add:

### Resource Access

```typescript
// List files/docs from MCP server
const { resources } = await mcpClient.listResources();

// Read content to send to LLM as context
const content = await mcpClient.readResource({ uri: "file://..." });

conversationHistory.push({
  role: "user",
  content: `Here's the code: ${content.contents[0].text}`,
});
```

### Prompt Templates

```typescript
// Get pre-built prompt templates
const { prompts } = await mcpClient.listPrompts();
const template = await mcpClient.getPrompt({ name: "code-review" });

// Use template in conversation
conversationHistory.push(...template.messages);
```

But these are **optional** - basic chatbots only need the 4 core methods!

## Troubleshooting

### "Error: Cannot connect to MCP server"

- Make sure MCP server is running: `cd ../../servers/mcp && pnpm dev`
- Check MCP_SERVER_URL in .env

### "Payment request denied"

- Make sure EVM_PRIVATE_KEY has funds on Base Sepolia
- Check wallet address has test USDC

### "OpenAI API error"

- Verify OPENAI_API_KEY is valid
- Check API key has credits: https://platform.openai.com/usage

## Next Steps

- Add conversation history persistence
- Implement multi-turn tool calling
- Add support for streaming responses
- Integrate more MCP servers (file system, databases, etc.)
- Add human-in-the-loop payment approval UI
