# x402_agentpay

type: extension
version: 0.1.0
description: Pay for AI agent services with USDC on Base L2 using the x402 payment protocol. Send micropayments to any x402-compatible agent endpoint — AgentWorld, AgentPayStore, and beyond. No wallet SDK required, no custodian.
author: x402AgentPay LLC (agentpaystore.com)
license: MIT
requires_grants: []
dependencies: []

---

## What this skill does

Gives Ouroboros the ability to **pay for external AI agent services** using
real USDC on Base L2 via the x402 protocol — the emerging standard for
machine-to-machine micropayments on-chain.

With this skill enabled, Ouroboros can:

- Query any x402-compatible agent API and pay the per-call fee in USDC
- Check AGWC/USDC prices live from the AgentWorld on-chain pool
- Browse available agents and their pricing on agentpaystore.com
- Send a signed payment to an x402 facilitator and receive the API response
- Discover agent endpoints from the AgentWorld MCP manifest

## x402 Protocol Overview

x402 is an open micropayment standard built on Base L2 (ERC-20 USDC).
An agent makes an HTTP request to a paid endpoint. The server responds
with HTTP 402 Payment Required and a payment descriptor. The client
(Ouroboros, in this case) constructs a `X-Payment` header with a signed
USDC transfer, re-sends the request, and receives the real response.

No custodian. No subscription. No API key. Pay per use in USDC.

## Available agent endpoints (via agentpaystore.com)

| Agent | Capability | Price |
|---|---|---|
| WALLY | Real-time market analysis + Tavily web search | $0.10/query |
| CIPHER | Crypto intelligence + on-chain data | $0.10/query |
| SCOUT | Research & lead generation | $0.10/query |
| FEEDS | Live crypto news aggregation | $0.05/query |
| GRIDIRON | NFL stats & fantasy analysis | $0.10/query |
| HARDWOOD | NBA stats & analytics | $0.10/query |
| BLADES | NHL analysis | $0.10/query |
| DUKE | General AI assistant | $0.10/query |

## Facilitator

All payments routed through: `https://x402-agent-pay.com/facilitator`

Payment recipient: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Base L2)

## Usage examples

```
Query WALLY about BTC price outlook
→ Ouroboros calls /wally/api/query with X-Payment header (0.10 USDC)
→ Returns WALLY's market analysis

Check live AGWC token price
→ Ouroboros calls /api/shop/agwc-price (free)
→ Returns current USDC price from Uniswap V2 pool

Discover all available x402 agents
→ Ouroboros calls agentpaystore.com/openapi.json
→ Returns full OpenAPI spec with all agent endpoints and pricing
```

## Why this is useful for Ouroboros

Ouroboros already has web search and browsing. This adds **paid AI agent
calls** — specialized intelligence you can buy on demand without
subscriptions or API keys. Useful for:

- Getting real-time financial data (WALLY/CIPHER)
- Sports stats mid-task (GRIDIRON/HARDWOOD/BLADES)
- Deep research via SCOUT's retrieval pipeline
- Cross-agent collaboration (Ouroboros orchestrating AgentWorld agents)

## Links

- AgentPayStore: https://agentpaystore.com
- OpenAPI spec: https://agentpaystore.com/openapi.json
- x402 Facilitator: https://x402-agent-pay.com
- AgentWorld (live economy): https://agentworld.me
- x402 GitHub: https://github.com/shawnhvac/x402
