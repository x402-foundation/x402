# @x402/mnemopay

MnemoPay middleware for x402 — turns "pay and forget" into "pay and learn."

Standard x402 handles payments mechanically: see a 402, pay, get the resource. The agent never learns. It pays the same price to unreliable endpoints, never discovers cheaper alternatives, and has no memory of what worked.

This package layers **economic memory** on top of x402. After each payment, the AI agent remembers the cost, the endpoint, and whether it succeeded. Before each request, it recalls past experiences — surfacing cheaper alternatives, flagging unreliable endpoints, and building a reputation score that reflects real payment outcomes.

## Installation

```bash
pnpm install @x402/mnemopay @mnemopay/sdk
```

## Quick Start

```typescript
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { MnemoPayLite } from "@mnemopay/sdk";
import { withMnemoPay } from "@x402/mnemopay";
import { privateKeyToAccount } from "viem/accounts";

// 1. Set up x402 payment as usual
const account = privateKeyToAccount("0xYourPrivateKey");
const client = new x402Client().register("eip155:8453", new ExactEvmScheme(account));
const payFetch = wrapFetchWithPayment(fetch, client);

// 2. Add MnemoPay memory layer
const agent = new MnemoPayLite("my-agent", 0.05);
const smartFetch = withMnemoPay(payFetch, { agent });

// 3. Use it — the agent now remembers every payment
const response = await smartFetch("https://api.example.com/paid-endpoint");
// Agent stored: "x402 payment to https://api.example.com/paid-endpoint: success, cost: $0.02"

// Next time, it recalls that memory before paying
const response2 = await smartFetch("https://api.example.com/paid-endpoint");
// Agent recalled: 1 memory, success rate: 100%, avg cost: $0.02
```

## How It Works

The middleware wraps any fetch function (ideally one already wrapped with `@x402/fetch`) and adds four memory operations around each request:

| Phase | What happens | MnemoPay API |
|-------|-------------|--------------|
| **Before request** | Recall past payment experiences with this endpoint | `agent.recall()` |
| **After 402 payment** | Record the charge amount and endpoint | `agent.charge()` |
| **On success** | Settle the transaction, reinforcing the positive memory | `agent.settle()` |
| **On failure** | Refund the transaction, docking reputation | `agent.refund()` |

Over time, the agent builds a knowledge base of:
- Which endpoints are cheap vs. expensive
- Which endpoints are reliable vs. flaky
- How costs change over time
- Which alternatives exist for the same resource

## API

### `withMnemoPay(fetchFn, config)`

The primary wrapper. Layers memory on top of an existing fetch function.

```typescript
const smartFetch = withMnemoPay(payFetch, {
  agent: mnemoPayAgent,    // Required: MnemoPay agent instance
  recallLimit: 5,          // Optional: max memories to recall per request (default: 5)
  reliabilityThreshold: 0.3, // Optional: warn below this success rate (default: 0.3)
  debug: false,            // Optional: log memory events to console (default: false)
});
```

### `withMnemoPayAgent(fetchFn, agent)`

Convenience wrapper with default configuration.

```typescript
const smartFetch = withMnemoPayAgent(payFetch, agent);
```

### `recallEndpointInsight(agent, endpoint, limit?)`

Manually query the agent's memory about a specific endpoint.

```typescript
import { recallEndpointInsight } from "@x402/mnemopay";

const insight = await recallEndpointInsight(agent, "https://api.example.com/paid");
if (insight) {
  console.log(`Success rate: ${insight.successRate}`);
  console.log(`Average cost: $${insight.averageCost}`);
  console.log(`Interactions: ${insight.interactionCount}`);
}
```

### `rememberPaymentOutcome(agent, result, debug?)`

Manually record a payment outcome (useful for custom payment flows).

```typescript
import { rememberPaymentOutcome } from "@x402/mnemopay";

await rememberPaymentOutcome(agent, {
  success: true,
  transactionId: "tx-123",
  endpoint: "https://api.example.com/paid",
  cost: 0.05,
});
```

## Custom MnemoPay Agent

You don't need the full `@mnemopay/sdk`. Any object implementing the `MnemoPayAgent` interface works:

```typescript
import type { MnemoPayAgent } from "@x402/mnemopay";

const myAgent: MnemoPayAgent = {
  async remember(content, options) { /* store in your DB */ },
  async recall(query, limit) { /* search your DB */ return []; },
  async charge(amount, description) { /* record payment */ return "tx-id"; },
  async settle(txId) { /* mark as settled */ },
  async refund(txId) { /* mark as refunded */ },
  balance() { return { wallet: 100, reputation: 0.9 }; },
};

const smartFetch = withMnemoPay(payFetch, { agent: myAgent });
```

## Debug Mode

Enable debug logging to see the agent's memory operations:

```typescript
const smartFetch = withMnemoPay(payFetch, {
  agent,
  debug: true,
});

// Console output:
// [mnemopay] recalled 3 memories for https://api.example.com/paid, success rate: 67%, avg cost: $0.04
// [mnemopay] WARNING: https://api.example.com/flaky has low reliability (20%). Consider alternatives.
// [mnemopay] settled tx tx-123 for https://api.example.com/paid
```

## Why This Matters for AI Agents

AI agents making API calls through x402 today are stateless — they pay whatever is asked, every time, with no memory of past outcomes. This is like a human who forgets the price of groceries every time they walk into a store.

With MnemoPay integration, x402 agents develop **economic intelligence**:

- **Cost awareness**: "This endpoint usually costs $0.02, but today it's asking for $0.10 — something changed"
- **Reliability tracking**: "This endpoint fails 40% of the time — I should prefer the alternative"
- **Reputation building**: Agents that consistently make good payment decisions build higher reputation scores, which other agents and services can use as a trust signal

## License

Apache-2.0
