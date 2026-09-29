# MCP Server with x402 Paid Tools

This example demonstrates how to create an MCP (Model Context Protocol) server with paid tools using the x402 payment protocol.

## Overview

The server exposes:

- **get_weather** (paid) - Returns weather data for a city, costs $0.001
- **ping** (free) - Returns "pong", no payment required

## Setup

1. Copy `.env-example` to `.env` and fill in your values:

```bash
cp .env-example .env
```

2. Configure environment variables:

   - `EVM_ADDRESS`: Your EVM wallet address to receive payments
   - `FACILITATOR_URL`: x402 facilitator URL (default: https://x402.org/facilitator)
   - `PORT`: Server port (default: 4022)

3. Install dependencies:

```bash
go mod download
```

## Running

All examples use the `NewPaymentWrapper` API - a lean approach to adding payments to MCP tools with the official SDK.

### Simple Mode (Recommended Starting Point)

Basic payment wrapper usage:

```bash
go run . simple
```

Simple mode demonstrates:

- Creating a payment wrapper with shared configuration
- Wrapping tool handlers with payment logic
- Using native tool registration API
- Mixing paid and free tools

### Advanced Mode (Production Features)

Payment wrapper with hooks for monitoring and control:

```bash
go run . advanced
```

Advanced mode demonstrates:

- Server-side hooks for production features
- `OnBeforeExecution`: Rate limiting, access control (can abort)
- `OnAfterExecution`: Logging, metrics collection
- `OnAfterSettlement`: Receipts, notifications

### Existing Server Mode

Adding payment to an existing MCP server:

```bash
go run . existing
```

Existing server mode demonstrates:

- Integrating x402 with an existing MCP server instance
- Minimal code changes to add payment
- Creating reusable payment wrappers

The server will start on `http://localhost:4022` with:

- SSE endpoint: `GET /sse`
- Messages endpoint: `POST /messages`
- Health check: `GET /health`

## Testing

Use the MCP client example (`examples/go/clients/mcp`) to connect and test:

```bash
cd ../../clients/mcp
go run . simple
```

## Payment Flow

1. Client calls `get_weather` tool
2. Server returns 402 error with `PaymentRequired` data
3. Client creates payment payload and retries
4. Server verifies payment, executes tool, returns result
5. Payment is settled and receipt included in response

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   MCP Client    │────▶│    MCPServer     │────▶│  x402Facilitator │
│  (with wallet)  │     │ + PaymentWrapper │     │  (verification)  │
│                 │◀────│  (paid tools)    │◀────│  (settlement)    │
└─────────────────┘     └──────────────────┘     └──────────────────┘
```

The payment wrapper is a lightweight function that adds payment verification and settlement to individual tool handlers.
