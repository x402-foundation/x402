# `@x402/mcp` • [![npm version](https://img.shields.io/npm/v/%40x402%2Fmcp.svg)](https://www.npmjs.com/package/@x402/mcp)

MCP (Model Context Protocol) integration for the x402 payment protocol. This package enables paid tool calls in MCP servers and automatic payment handling in MCP clients.

## Installation

```bash
npm install @x402/mcp @x402/core @modelcontextprotocol/sdk
```

## Quick Start (Recommended)

### Server - Using Payment Wrapper

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPaymentWrapper, x402ResourceServer } from "@x402/mcp";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { z } from "zod";

// Create standard MCP server
const mcpServer = new McpServer({ name: "premium-api", version: "1.0.0" });

// Set up x402 for payment handling
const facilitatorClient = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
const resourceServer = new x402ResourceServer(facilitatorClient);
resourceServer.register("eip155:84532", new ExactEvmScheme());
await resourceServer.initialize();

// Build payment requirements
const accepts = await resourceServer.buildPaymentRequirements({
  scheme: "exact",
  network: "eip155:84532",
  payTo: "0x...", // Your wallet address
  price: "$0.10",
});

// Create payment wrapper with accepts array
const paid = createPaymentWrapper(resourceServer, {
  accepts,
});

// Register paid tools - wrap handler
mcpServer.tool(
  "financial_analysis",
  "Advanced AI-powered financial analysis. Costs $0.10.",
  { ticker: z.string() },
  paid(async (args) => {
    const analysis = await performAnalysis(args.ticker);
    return { content: [{ type: "text", text: analysis }] };
  })
);

// Register free tools - no wrapper needed
mcpServer.tool("ping", "Health check", {}, async () => ({
  content: [{ type: "text", text: "pong" }],
}));

// Connect to transport
await mcpServer.connect(transport);
```

### Client - Using Factory Function

```typescript
import { createX402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// Create client with factory (simplest approach)
const client = createX402MCPClient({
  name: "my-agent",
  version: "1.0.0",
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(walletAccount) }],
  autoPayment: true,
  onPaymentRequested: async ({ paymentRequired }) => {
    console.log(`Tool requires payment: ${paymentRequired.accepts[0].amount}`);
    return true; // Return false to deny payment
  },
});

// Connect and use
const transport = new SSEClientTransport(new URL("http://localhost:4022/sse"));
await client.connect(transport);

const result = await client.callTool("financial_analysis", { ticker: "AAPL" });
console.log(result.content);

if (result.paymentMade) {
  console.log("Payment settled:", result.paymentResponse?.transaction);
}
```

## Advanced Features

### Production Hooks

Add hooks for logging, rate limiting, receipts, and more:

```typescript
// Build payment requirements
const accepts = await resourceServer.buildPaymentRequirements({
  scheme: "exact",
  network: "eip155:84532",
  payTo: "0x...",
  price: "$0.10",
});

const paid = createPaymentWrapper(resourceServer, {
  accepts,
  hooks: {
    // Called after payment verification, before tool execution
    // Return false to abort execution
    onBeforeExecution: async ({ toolName, paymentPayload, paymentRequirements }) => {
      console.log(`Executing ${toolName} for ${paymentPayload.payer}`);
      
      // Rate limiting example
      if (await isRateLimited(paymentPayload.payer)) {
        console.log("Rate limit exceeded");
        return false; // Abort execution, don't charge
      }
      
      return true; // Continue
    },

    // Called after tool execution, before settlement
    onAfterExecution: async ({ toolName, result, paymentPayload }) => {
      // Log metrics
      await metrics.record(toolName, result.isError);
    },

    // Called after successful settlement
    onAfterSettlement: async ({ toolName, settlement, paymentPayload }) => {
      // Send receipt to user
      await sendReceipt(paymentPayload.payer, {
        tool: toolName,
        transaction: settlement.transaction,
        network: settlement.network,
      });
    },
  },
});

// All tools using this wrapper inherit the hooks
mcpServer.tool("search", "Premium search", { query: z.string() },
  paid(async (args) => ({ content: [...] }))
);
```

### Multiple Wrappers with Different Prices

Create separate wrappers for different payment tiers:

```typescript
// Build requirements for different price points
const basicAccepts = await resourceServer.buildPaymentRequirements({
  scheme: "exact",
  network: "eip155:84532",
  payTo: "0x...",
  price: "$0.05",
});

const premiumAccepts = await resourceServer.buildPaymentRequirements({
  scheme: "exact",
  network: "eip155:84532",
  payTo: "0x...",
  price: "$0.50",
});

// Create wrappers with different prices
const paidBasic = createPaymentWrapper(resourceServer, { accepts: basicAccepts });
const paidPremium = createPaymentWrapper(resourceServer, { accepts: premiumAccepts });

// Register tools with appropriate pricing
mcpServer.tool("basic_search", "...", {}, paidBasic(async (args) => ({ content: [...] })));
mcpServer.tool("premium_search", "...", {}, paidPremium(async (args) => ({ content: [...] })));
```

### Multiple Payment Options

Support multiple payment methods by including multiple requirements:

```typescript
// Build requirements for different payment schemes
const exactPayment = await resourceServer.buildPaymentRequirements({
  scheme: "exact",
  network: "eip155:84532",
  payTo: "0x...",
  price: "$0.10",
});

const subscriptionPayment = await resourceServer.buildPaymentRequirements({
  scheme: "subscription",
  network: "eip155:1",
  payTo: "0x...",
  price: "$50", // Monthly subscription
});

// Client can choose either payment method
const paid = createPaymentWrapper(resourceServer, {
  accepts: [exactPayment[0], subscriptionPayment[0]],
});
```

### Client - Wrapper Functions

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { wrapMCPClientWithPayment, wrapMCPClientWithPaymentFromConfig } from "@x402/mcp";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";

// Option 1: Wrap existing client with existing payment client
const mcpClient = new Client({ name: "my-agent", version: "1.0.0" });
const paymentClient = new x402Client()
  .register("eip155:84532", new ExactEvmScheme(walletAccount));

const x402Mcp = wrapMCPClientWithPayment(mcpClient, paymentClient, {
  autoPayment: true,
});

// Option 2: Wrap existing client with config
const x402Mcp2 = wrapMCPClientWithPaymentFromConfig(mcpClient, {
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(walletAccount) }],
});
```

## Payment Flow

1. **Client calls tool** → No payment attached
2. **Server returns 402** → PaymentRequired in structured result (see SDK Limitation below)
3. **Client creates payment** → Using x402Client
4. **Client retries with payment** → PaymentPayload in `_meta["x402/payment"]`
5. **Server verifies & executes** → Tool runs if payment valid
6. **Server settles payment** → Transaction submitted
7. **Server returns result** → SettleResponse in `_meta["x402/payment-response"]`

## MCP SDK Limitation

The x402 MCP transport spec defines payment errors using JSON-RPC's native error format:
```json
{ "error": { "code": 402, "data": { /* PaymentRequired */ } } }
```

However, the MCP SDK converts `McpError` exceptions to tool results with `isError: true`, losing the `error.data` field. To work around this, we embed the error structure in the result content:

```json
{
  "content": [{ "type": "text", "text": "{\"x402/error\": {\"code\": 402, \"data\": {...}}}" }],
  "isError": true
}
```

The client parses this structure to extract PaymentRequired data. This is a pragmatic workaround that maintains compatibility while we track upstream SDK improvements.

## Configuration Options

### x402MCPClientOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoPayment` | `boolean` | `true` | Automatically retry with payment on 402 |
| `onPaymentRequested` | `function` | `() => true` | Hook for human-in-the-loop approval when payment is requested |

### X402MCPServerConfig (Factory)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | Required | MCP server name |
| `version` | `string` | Required | MCP server version |
| `facilitator` | `string \| FacilitatorClient` | Default facilitator | Facilitator for payment processing |
| `schemes` | `SchemeRegistration[]` | `[]` | Payment scheme registrations |
| `syncFacilitatorOnStart` | `boolean` | `true` | Initialize facilitator immediately |

### MCPToolPaymentConfig

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `scheme` | `string` | Yes | Payment scheme (e.g., "exact") |
| `network` | `Network` | Yes | CAIP-2 network ID (e.g., "eip155:84532") |
| `price` | `Price` | Yes | Price (e.g., "$0.10" or "1000000") |
| `payTo` | `string` | Yes | Recipient wallet address |
| `maxTimeoutSeconds` | `number` | No | Payment timeout (default: 60) |
| `extra` | `object` | No | Scheme-specific parameters (e.g., EIP-712 domain) |
| `resource` | `object` | No | Resource metadata |

### PaymentWrapperConfig (for createPaymentWrapper)

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `scheme` | `string` | Yes | Payment scheme (e.g., "exact") |
| `network` | `Network` | Yes | CAIP-2 network ID (e.g., "eip155:84532") |
| `payTo` | `string` | Yes | Recipient wallet address |
| `price` | `Price` | No | Price - omit to specify per-tool |
| `maxTimeoutSeconds` | `number` | No | Payment timeout (default: 60) |
| `extra` | `object` | No | Scheme-specific parameters |
| `resource` | `object` | No | Resource metadata |

## Hooks

### Client Hooks

```typescript
const client = createX402MCPClient({...});

// Called when a 402 is received (before payment)
// Return { payment } to use custom payment, { abort: true } to stop
client.onPaymentRequired(async ({ toolName, paymentRequired }) => {
  const cached = await cache.get(toolName);
  if (cached) return { payment: cached };
});

// Called before payment is created
client.onBeforePayment(async ({ paymentRequired }) => {
  await logPaymentAttempt(paymentRequired);
});

// Called after payment is submitted
client.onAfterPayment(async ({ paymentPayload, settleResponse }) => {
  await saveReceipt(settleResponse.transaction);
});
```

### Server Hooks

```typescript
const server = createX402MCPServer({...});

// Called after verification, before tool execution
// Return false to abort and return 402
server.onBeforeExecution(async ({ toolName, paymentPayload }) => {
  if (isBlocked(paymentPayload.signer)) {
    return false; // Aborts execution
  }
});

// Called after tool execution, before settlement
server.onAfterExecution(async ({ toolName, result }) => {
  metrics.recordExecution(toolName, result.isError);
});

// Called after successful settlement
server.onAfterSettlement(async ({ toolName, settlement }) => {
  await logTransaction(toolName, settlement.transaction);
});
```

## License

Apache-2.0
