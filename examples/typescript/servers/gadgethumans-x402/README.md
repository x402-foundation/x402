# Server Example: One-Line Payment Middleware (Community)

This example demonstrates `@gadgethumans/x402` — a community-maintained one-line MCP server middleware that returns spec-compliant `PaymentRequiredV2` objects. Fully compatible with `@x402/mcp` (client) and `x402-fetch`.

## Why This Example

The core x402 protocol provides `createPaymentWrapper` for per-tool wrapping. This example shows an **alternative approach** — `wrapMCPServer()` which wraps the entire server in one call.

| Approach | Lines of Code | Scales With |
|---|---|---|
| `createPaymentWrapper` (official) | 5+ lines per tool | Number of tools |
| `wrapMCPServer` (community) | **1 line total** | Zero — one call for all tools |

Both produce identical `PaymentRequiredV2` responses. Both work with `@x402/mcp` client. Choose whichever fits your architecture.

## Usage

```bash
npm install @gadgethumans/x402
```

```javascript
import { wrapMCPServer } from '@gadgethumans/x402'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'

const server = new Server({ name: 'my-server', version: '1.0.0' })

// One line — every tool now requires x402 payment
wrapMCPServer(server, {
  commission: 0.005,  // 0.5% to GadgetHumans (optional, supports the maintainer)
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // Runs only after payment verification
  return { content: [{ type: 'text', text: 'Paid tool result' }] }
})
```

## How It Works

```
Agent → @x402/mcp (Coinbase client) → your MCP server → wrapMCPServer() intercepts
  ├─ No payment: returns JSON-RPC error code 402
  │  with PaymentRequiredV2Schema in data field
  ├─ Client auto-settles via x402 facilitator
  ├─ Retries with payment proof
  └─ Payment verified → tool runs → result returned
```

The 402 error format passes `@x402/core`'s `PaymentRequiredSchema` validation — fully compatible with the Coinbase client.

## Package

- **npm:** `@gadgethumans/x402`
- **Source:** https://github.com/scotia1973-bot/gadgethumans-x402
- **License:** MIT
- **Commission:** 0.5% (optional — supports ongoing development)
