# Spraay Gateway – x402 Server Example

An Express.js server that exposes [Spraay's](https://spraay.app) multi-chain payment infrastructure as x402-protected endpoints. AI agents pay per-request in USDC to access batch payments, payroll, token transfers, AI inference, and robot hiring (RTP) — across 13 blockchains.

This example demonstrates how to put a **real production API with 76+ DeFi primitives** behind x402, so any agent with a wallet can discover and use them without accounts, API keys, or subscriptions.

## What is Spraay?

Spraay is a multi-chain batch payment protocol and x402 gateway. It lets AI agents:

- **Send tokens to hundreds of recipients** in a single transaction (batch payments)
- **Run crypto payroll** for teams with one API call
- **Hire robots** to perform physical tasks via the Robot Task Protocol (RTP)
- **Access AI inference** across 43+ models (BlockRun multi-provider)
- **Swap, bridge, stake, and manage agent wallets** across Base, Ethereum, Solana, Bitcoin, and 9 other chains

Live gateway: [gateway.spraay.app](https://gateway.spraay.app)
Docs: [docs.spraay.app](https://docs.spraay.app)
MCP Server: [@plagtech/spraay-x402-mcp](https://smithery.ai/server/@plagtech/spraay-x402-mcp) (60+ tools on Smithery)

## Prerequisites

- Node.js 18+
- An Ethereum address to receive payments

Optional (for mainnet):
- [Coinbase Developer Platform](https://portal.cdp.coinbase.com/projects) API Key & Secret

## Setup

Copy `.env-local` to `.env` and add your Ethereum address:

```bash
cp .env-local .env
```

Install and build all packages from the typescript examples root:

```bash
cd ../../
pnpm install
pnpm build
cd servers/spraay-gateway
```

Run the server:

```bash
pnpm dev
```

## Endpoints

| Method | Path | Price | Description |
|--------|------|-------|-------------|
| `POST` | `/batch-payment` | $0.01 | Send USDC to multiple recipients in one tx |
| `POST` | `/token-transfer` | $0.01 | Transfer any ERC-20 token |
| `POST` | `/payroll` | $0.05 | Process recurring crypto payroll |
| `POST` | `/ai/inference` | $0.03 | Run AI inference (43+ models) |
| `POST` | `/rtp/task` | $0.05 | Hire a robot via Robot Task Protocol |
| `GET` | `/discover` | Free | List all gateway endpoints and pricing |

These are a representative subset — the full Spraay gateway has **76+ paid endpoints across 16 categories**.

## Testing

You can test the server using any of the example x402 clients:

```bash
cd ../../clients/fetch
# Ensure .env is set up with your private key
pnpm dev
```

Or use `curl` to see the 402 response:

```bash
curl -i http://localhost:4021/batch-payment \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"chain":"base","recipients":["0x123..."],"amounts":["1.0"],"token":"USDC"}'
```

You'll receive a `402 Payment Required` response with payment details in the `PAYMENT-REQUIRED` header.

## Example: Agent Batch Payment

An AI agent paying to send USDC to 3 recipients:

```typescript
import { withPaymentInterceptor } from "@x402/axios";
import axios from "axios";

// Agent's wallet client (see x402 client examples)
const api = withPaymentInterceptor(
  axios.create({ baseURL: "http://localhost:4021" }),
  walletClient
);

// Agent pays $0.01 USDC via x402, then Spraay executes
// a batch send to 3 recipients on Base
const result = await api.post("/batch-payment", {
  chain: "base",
  token: "USDC",
  recipients: [
    "0xAlice...",
    "0xBob...",
    "0xCharlie...",
  ],
  amounts: ["10.00", "25.00", "15.00"],
});

console.log(result.data);
// { txHash: "0x...", recipients: 3, totalAmount: "50.00" }
```

## Running on Mainnet

Update your `.env` to use Base mainnet and the CDP facilitator:

```env
NETWORK=eip155:8453
FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
```

See the [CDP facilitator docs](https://docs.cdp.coinbase.com/x402/quickstart-for-sellers) for authentication setup.

## Architecture

```
Agent (x402 client)
  │
  │  1. POST /batch-payment
  │  2. Receives 402 + payment requirements
  │  3. Signs USDC authorization
  │  4. Retries with X-PAYMENT header
  │
  ▼
x402 Express Middleware
  │
  │  Verifies payment via facilitator
  │
  ▼
Spraay Gateway (gateway.spraay.app)
  │
  │  Executes multi-chain DeFi operation
  │
  ▼
Base / Ethereum / Solana / Bitcoin / ...
```

## Links

- [Spraay Gateway](https://gateway.spraay.app) — Live API
- [Spraay Docs](https://docs.spraay.app) — Full endpoint reference
- [MCP Server](https://smithery.ai/server/@plagtech/spraay-x402-mcp) — 60+ tools for Claude/AI agents
- [Bazaar Listing](https://x402.org) — x402 ecosystem
- [GitHub](https://github.com/plagtech) — All Spraay repos
