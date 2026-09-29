# MCP Client Touchpoints in Real Chatbot

This document shows EXACTLY which MCP client methods are called and when in a real OpenAI chatbot.

## The 4 Critical Touchpoints

### Touchpoint #1: connect() - Startup

**When**: Once at chatbot initialization
**Code Location**: Line 96-98 in index.ts

```typescript
const transport = new SSEClientTransport(new URL(`${serverUrl}/sse`));
await mcpClient.connect(transport);
```

**What happens**:

- Establishes JSON-RPC connection to MCP server
- Negotiates capabilities
- Returns when connection is ready

---

### Touchpoint #2: listTools() - Tool Discovery

**When**: Once at startup (after connect)
**Code Location**: Line 104-105 in index.ts

```typescript
const { tools } = await mcpClient.listTools();
// Returns: [{ name: "get_weather", description: "...", inputSchema: {...} }]
```

**What happens**:

- Queries MCP server for available tools
- Returns tool metadata (name, description, schema)
- These tools are presented to OpenAI

**Result Format**:

```json
{
  "tools": [
    {
      "name": "get_weather",
      "description": "Get current weather for a city. Requires payment of $0.001.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "city": { "type": "string", "description": "City name" }
        },
        "required": ["city"]
      }
    }
  ]
}
```

---

### Touchpoint #3: callTool() - Tool Execution (THE MAIN ONE)

**When**: Every time LLM decides to call a tool
**Code Location**: Line 181-183 in index.ts

```typescript
const mcpResult = await mcpClient.callTool(toolName, toolArgs);
// toolName: "get_weather" (from LLM)
// toolArgs: { city: "Tokyo" } (from LLM)
```

**What happens**:

1. Sends `tools/call` JSON-RPC request to MCP server
2. If server returns 402 Payment Required:
   - Extracts payment requirements from response
   - Calls `onPaymentRequested` hook
   - Creates payment payload (via x402Client)
   - Retries tool call with payment in `_meta`
3. Server verifies payment, executes tool, settles payment
4. Returns result with settlement receipt

**Result Format**:

```typescript
{
  content: [{ type: "text", text: '{"city":"Tokyo","weather":"sunny","temperature":72}' }],
  isError: false,
  paymentMade: true,
  paymentResponse: {
    success: true,
    transaction: "0xabc123...",
    network: "eip155:84532"
  }
}
```

---

### Touchpoint #4: close() - Cleanup

**When**: Once at shutdown
**Code Location**: Line 266 in index.ts

```typescript
await mcpClient.close();
```

**What happens**:

- Closes JSON-RPC connection
- Cleans up resources
- Server removes session

---

## Complete Message Flow

### Example: User asks "What's the weather in Tokyo?"

```
[1] User Input
    ↓
[2] Host adds to conversation history
    ↓
[3] Host calls OpenAI API
    POST https://api.openai.com/v1/chat/completions
    Body: {
      messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
      tools: [{ name: "get_weather", ... }]  ← From MCP listTools()
    }
    ↓
[4] OpenAI responds with tool call
    Response: {
      message: {
        tool_calls: [{
          function: { name: "get_weather", arguments: '{"city":"Tokyo"}' }
        }]
      }
    }
    ↓
[5] Host executes tool via MCP
    await mcpClient.callTool("get_weather", { city: "Tokyo" })
    ↓
[6] MCP server returns 402 Payment Required
    ↓
[7] x402MCPClient handles payment automatically
    - Calls onPaymentRequested hook → approved
    - Creates payment payload
    - Retries with payment
    ↓
[8] MCP server verifies, executes, settles
    Returns: { content: [{ text: '{"weather":"sunny","temp":72}' }] }
    ↓
[9] Host sends tool result to OpenAI
    POST https://api.openai.com/v1/chat/completions
    Body: {
      messages: [
        ...,
        { role: "tool", content: '{"weather":"sunny","temp":72}' }
      ]
    }
    ↓
[10] OpenAI formats final response
     Response: {
       message: {
         content: "The weather in Tokyo is sunny with a temperature of 72°F."
       }
     }
     ↓
[11] Host displays to user
     Bot: The weather in Tokyo is sunny with a temperature of 72°F.
```

---

## Method Usage Statistics

From real chatbot usage:

| Method              | Usage Frequency | Purpose                               |
| ------------------- | --------------- | ------------------------------------- |
| `callTool()`        | ⭐⭐⭐⭐⭐ High | Every tool call (10-100x per session) |
| `listTools()`       | ⭐ Low          | Once at startup                       |
| `connect()`         | ⭐ Low          | Once at startup                       |
| `close()`           | ⭐ Low          | Once at shutdown                      |
| `listResources()`   | ⚠️ Rare         | Only if sending files to LLM          |
| `readResource()`    | ⚠️ Rare         | Only if sending file content to LLM   |
| `getPrompt()`       | ⚠️ Rare         | Only if using prompt templates        |
| `ping()`            | ⚠️ Rare         | Health checks (optional)              |
| Others (11 methods) | ❌ Almost never | Edge cases                            |

---

## Key Insights

### 1. callTool() is 99% of the Usage

In a typical chat session:

- `connect()`: 1 call
- `listTools()`: 1 call
- `callTool()`: 50+ calls (every tool execution)
- `close()`: 1 call

**callTool() is THE method that matters!**

### 2. LLM Never Touches MCP

- OpenAI doesn't know about MCP
- OpenAI just sees generic "function calling" API
- Host translates between OpenAI ↔ MCP

### 3. Payment is Invisible to LLM

- OpenAI thinks all tools are free
- x402MCPClient handles payment transparently
- User experience is seamless

### 4. Most Methods Are Unused

Methods like `subscribeResource()`, `listResourceTemplates()`, `setLoggingLevel()` are **never called** in typical chatbot usage.

---

## Recommendation: Minimal Wrapper

Based on this analysis, our wrapper should:

✅ **Wrap these 4 methods** (what chatbots use):

- `connect()`
- `listTools()`
- `callTool()` (with payment)
- `close()`

✅ **Expose raw client** for edge cases:

```typescript
public readonly client: Client;
```

❌ **Remove 15 passthrough methods** (brittle, unused):

- `readResource()`, `getPrompt()`, `ping()`, etc.
- Access via `mcpClient.client.readResource()` if needed

---

## Testing

```bash
# Terminal 1: Start MCP server
cd ../../servers/mcp
pnpm dev

# Terminal 2: Run chatbot
cd examples/typescript/client/mcp-chatbot
pnpm install
pnpm dev
```

Then try:

- "What's the weather in Paris?" (paid tool)
- "Ping the server" (free tool)
- Natural conversation with automatic tool calling

The chatbot will show you **exactly** when each MCP method is called!
