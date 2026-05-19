# AgentPay × Substreams — Architecture Update for James

**From:** Shawn Lippert, AgentPay  
**Re:** Substreams integration status + questions  
**Context:** Following up on our Discord thread re: The Graph × AgentPay collaboration

---

## What We Shipped

The AgentPay Substreams package is **compiled, packed, and streaming live on Base mainnet** as of today.

**Package:** `agentpay-substreams-v0.1.0.spkg`  
**Network:** `base-mainnet` via `mainnet.eth.streamingfast.io:443`  
**Status:** ✅ Live — streaming confirmed on mainnet today, cursor-based, auto-reconnects on drop

---

## Current Pipeline (What's Running Now)

```
Base L2 Blocks (via Firehose, --final-blocks-only)
      │
      ▼
[map_usdc_transfers]
  - USDC contract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
  - Filters on TransferWithAuthorization (EIP-3009)
  - Full topic: 0x98de503528ee59b575ef0c0a2576a82112635b28b9da4cae03c8b0b0ec06b8e3
  - Extracts: from, to, value, nonce, block_num, timestamp, tx_hash
      │
      ▼
[map_confirmed_settlements]  ← final blocks only, all modules below inherit finality
  - Filters to transfers TO AgentPay facilitator wallet
  - Emits SettlementEvent (payment_id from EIP-3009 nonce)
  - Facilitator client acts on this stream — service release happens
    after finality is confirmed, not on first-seen
      │
      └──▶ [store_agent_stats]   StoreAddInt64 with deltas
                Single store, keyed by agent wallet
                Tracks: total, success, refunded, unique_counterparties
```

The reputation scoring and analytics sink are the **next phase** — not shipped yet. That's where we need your input (below).

---

## Why Substreams vs. Our Old Polling Loop

Old approach: `eth_getLogs` every 2 seconds.

- 2–4 second lag per payment, reorg handling was manual
- ~$0.002/req × high frequency = real ongoing cost
- Single RPC provider = single point of failure

With Firehose-backed Substreams, all modules run with `--final-blocks-only`:

- Reorg-safe by design — finality propagates through the entire module graph
- One persistent gRPC stream, no per-request cost
- Server load stays flat — integrators query the subgraph, not our facilitator

---

## Three Things We Need from You

**1. x402GrantRegistry — address + startBlock on Base**  
A registry contract tracking grant-funded x402 payments on Base. We want to add it as a module so grant-funded settlements are distinguishable from standard ones. Without the address we can't build it.

**2. Reputation → subgraph or Clickhouse — what's the right pattern?**  
We want external agents to be able to query `agentReputation(wallet: "0x...")`. We were leaning toward a subgraph for the GraphQL interface, with `store_agent_stats` deltas feeding into a subgraph handler. But we haven't deployed a subgraph before — is that the right shape for this use case, or would you structure it differently?

**3. Subgraph deployment path**  
Starting fresh, no existing subgraph. Hosted service first or straight to the decentralized network?

---

## What We're Ready to Share

The `.spkg` is packed and streaming. Happy to drop the repo link, walk through the module code, or coordinate a PR review whenever works.

— Shawn / AgentPay Team  
x402-agent-pay.com | @shawnhvac | github.com/shawnhvac/x402
