# MCP Server with x402 Paid Tools

This example demonstrates how to create an MCP (Model Context Protocol) server with paid tools using the x402 payment protocol.

## Overview

The server exposes:

- **get_weather** (paid) - Returns weather data for a city, costs $0.001
- **ping** (free) - Returns "pong", no payment required

## Setup

1. Copy `.env-local` to `.env` and fill in your values:

```bash
cp .env-local .env
```

2. Configure environment variables:

   - `EVM_ADDRESS`: Your EVM wallet address to receive payments
   - `FACILITATOR_URL`: x402 facilitator URL (default: https://x402.org/facilitator)
   - `PORT`: Server port (default: 4022)

3. Install dependencies:

```bash
pnpm install
```

## Running

All examples use the `createPaymentWrapper` API - a lean, functional approach to adding payments to MCP tools.

### Simple Mode (Recommended Starting Point)

Basic payment wrapper usage:

```bash
pnpm dev
```

Simple mode demonstrates:

- Creating a payment wrapper with shared configuration
- Wrapping tool handlers with payment logic
- Using native `McpServer.tool()` API
- Mixing paid and free tools

### Advanced Mode (Production Features)

Payment wrapper with hooks for monitoring and control:

```bash
pnpm dev:advanced
```

Advanced mode demonstrates:

- Server-side hooks for production features
- `onBeforeExecution`: Rate limiting, access control (can abort)
- `onAfterExecution`: Logging, metrics collection
- `onAfterSettlement`: Receipts, notifications

### Existing Server Mode

Adding payment to an existing MCP server:

```bash
pnpm dev:existing
```

Existing server mode demonstrates:

- Integrating x402 with an existing `McpServer` instance
- Minimal code changes to add payment
- Creating reusable payment wrappers

The server will start on `http://localhost:4022` with:

- SSE endpoint: `GET /sse`
- Messages endpoint: `POST /messages`
- Health check: `GET /health`

## Testing

Use the MCP client example (`@x402/mcp-client-example`) to connect and test:

```bash
cd ../../../clients/mcp
pnpm dev
```

Or use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) to interact with the server.

## Payment Flow

1. Client calls `get_weather` tool
2. Server returns 402 error with `PaymentRequired` data
3. Client creates payment payload and retries
4. Server verifies payment, executes tool, returns result
5. Payment is settled and receipt included in response

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   MCP Client    │────▶│    McpServer     │────▶│  x402Facilitator │
│  (with wallet)  │     │ + PaymentWrapper │     │  (verification)  │
│                 │◀────│  (paid tools)    │◀────│  (settlement)    │
└─────────────────┘     └──────────────────┘     └──────────────────┘
```

The payment wrapper is a lightweight function that adds payment verification and settlement to individual tool handlers.
