# AgentPay × Substreams — Architecture Update for James

**From:** Shawn Lippert, AgentPay  
**Re:** Substreams integration status + architecture questions  
**Context:** Following up on our Discord thread re: The Graph × AgentPay collaboration

---

## What We Shipped

We just crossed a major milestone: the AgentPay Substreams package is **compiled, packed, and streaming live on Base mainnet** as of today.

Here's what's running:

**Package:** `agentpay-substreams-v0.1.0.spkg`  
**Network:** `base-mainnet` via `mainnet.eth.streamingfast.io:443`  
**Status:** ✅ Live — 8+ blocks processed, usage confirmed via StreamingFast dashboard

---

## Pipeline Architecture

```
Base L2 Blocks
      │
      ▼
[map_usdc_transfers]
  - Watches Base USDC contract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
  - Filters on TransferWithAuthorization topic (EIP-3009)
  - Topic: 0x98de503528...
  - Extracts: from, to, value, nonce, block_num, timestamp, tx_hash
      │
      ▼
[map_confirmed_settlements]
  - Filters to transfers TO AgentPay facilitator wallet
  - Emits SettlementEvent with payment_id derived from EIP-3009 nonce
  - This is the hot path: facilitator subscribes and releases service instantly
      │
      ├──▶ [store_agent_counters]  ← StoreAddInt64, accumulates across blocks
      │         total, success, refunded, diversity per agent
      │
      ├──▶ [store_agent_reputation] ← StoreSetProto<AgentReputation>
      │         Composite score: 60% success + 25% diversity + 15% recency
      │
      └──▶ [map_analytics_events]
                AnalyticsEvent rows → Clickhouse sink (James's pattern)
                Fields: agent, counterparty, amount_usdc, score_ppm, city, tx_hash
```

---

## Why This Matters for The Graph Integration

The core problem we were solving: our old facilitator used a polling loop — `eth_getLogs` every 2 seconds. At scale this means:

- **Latency:** 2–4 second confirmation lag on every payment
- **Cost:** ~$0.002/req × high frequency = real money
- **Fragility:** RPC provider outages = missed settlements

With Substreams streaming directly from Firehose:
- **Latency:** Sub-block (confirmed within the same block the tx lands)
- **Cost:** One persistent gRPC stream, no polling
- **Reliability:** StreamingFast's infrastructure, not a single RPC node

This is also why the Substreams → subgraph path is interesting — GraphQL queries from external agents/integrators hit the subgraph, not our facilitator, which keeps our server load flat regardless of query volume.

---

## Questions for You

**1. x402GrantRegistry**  
Do you have the contract address + `startBlock` for the grant registry on Base? We want to index it as a fifth module so grant-funded settlements are distinguishable from standard payments in the analytics stream.

**2. Clickhouse Sink**  
You mentioned the Uniswap pipeline uses `substreams-sink-clickhouse`. We've built the `AnalyticsEvent` proto to match that schema pattern. Is there a recommended sink version for Base mainnet, or are you running a custom fork?

**3. Subgraph Deployment**  
Once we have the grant registry address, the plan is:
- Deploy the subgraph to The Graph Network (decentralized)
- Expose a GraphQL endpoint so external agents can query `agentReputation(wallet: "0x...")`
- Wire that back into our facilitator's credit scoring

Is there a preferred path for getting an AgentPay subgraph onto the decentralized network, or should we start on the hosted service?

---

## What We Need from You

Just two things to unblock the next phase:

1. **x402GrantRegistry address + startBlock on Base**
2. **Your preferred Clickhouse sink version / config for Base mainnet**

Everything else is ready to go on our end. The `.spkg` is packed, the pipeline is streaming, and the facilitator client is wired up to consume the gRPC stream.

Happy to share the repo directly or hop into a PR review whenever works for you.

— Shawn / AgentPay Team  
x402-agent-pay.com | @shawnhvac
