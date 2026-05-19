# AgentPay Substreams

Streaming-first settlement confirmation for x402 agent payments on Base L2.

## Why Substreams?

AgentPay's current RPC polling loop introduces **1-3 seconds of latency** per payment confirmation. At low agent counts this is acceptable. At scale — 99+ agents running concurrent payment cycles — it becomes a systemic bottleneck.

Substreams eliminates polling entirely. The facilitator subscribes to a live stream of on-chain events. When a USDC `TransferWithAuthorization` lands on Base L2, it arrives at the facilitator **within the same block** — typically < 500ms.

```
BEFORE (RPC polling):
  Agent pays → facilitator polls eth_getTransactionReceipt every 500ms
  → confirmed after 1-3 polls → service released → 1-3s total latency

AFTER (Substreams):
  Agent pays → block finalizes → Substreams pushes SettlementEvent
  → facilitator resolves pending Future → service released → < 500ms
```

## Architecture

```
Base L2 (USDC contract)
        │
        │ TransferWithAuthorization events
        ▼
┌─────────────────────────────────────────┐
│          Substreams Pipeline            │
│                                         │
│  map_usdc_transfers                     │
│    │ All USDC EIP-3009 transfers        │
│    ▼                                    │
│  map_confirmed_settlements              │ ◄── facilitator subscribes HERE
│    │ Filtered to AgentPay facilitator   │     asyncio Future resolved
│    │                                    │     service released < 500ms
│    ├──► store_agent_reputation          │
│    │      │ Running score per agent     │
│    │      │ KV store → subgraph sink    │
│    │      ▼                             │
│    └──► map_analytics_events            │
│               │ Clickhouse-ready rows   │
└───────────────┼─────────────────────────┘
                │
        ┌───────┴────────┐
        │                │
        ▼                ▼
  Subgraph Sink    Clickhouse Sink
  (reputation,     (analytics,
   history,         volume,
   GraphQL API)     earnings)
```

## Modules

| Module | Type | Purpose |
|--------|------|---------|
| `map_usdc_transfers` | map | Stream all EIP-3009 transfers from Base USDC |
| `map_confirmed_settlements` | map | Filter to AgentPay facilitator — hot path trigger |
| `store_agent_reputation` | store | Running reputation state per agent wallet |
| `map_analytics_events` | map | Clickhouse-ready rows for historical analytics |

## Addressing James's Questions Directly

**Q: What triggers service release after payment?**
→ After: `map_confirmed_settlements` pushes a `SettlementEvent`. The facilitator's pending `asyncio.Future` resolves immediately. No poll loop.

**Q: RPC polling vs subgraph vs hybrid?**
→ After: Substreams for hot-path confirmation (streaming). Subgraph for reputation + history (queryable indexed state). Clickhouse for analytics. Pure hybrid — each layer doing what it's best at.

**Q: Retries/idempotency?**
→ EIP-3009 nonce is indexed on-chain in every `SettlementEvent`. Agents can verify payment idempotency directly from the subgraph without trusting the facilitator server.

**Q: Cross-chain service discovery?**
→ `store_agent_reputation` feeds the existing subgraph, making agent reputation queryable via GraphQL from any chain. x402scan handles service discovery today; subgraph handles trust.

## Setup

### Prerequisites
```bash
# Install Rust + wasm32 target
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown

# Install substreams CLI
brew install streamingfast/tap/substreams

# Get API token
# https://app.streamingfast.io/keys
export SUBSTREAMS_API_TOKEN=your_token_here
```

### Build
```bash
cd agentpay-substreams
cargo build --target wasm32-unknown-unknown --release
substreams pack
```

### Run (development)
```bash
substreams run -e mainnet.base.streamingfast.io:443 \
  substreams.yaml map_confirmed_settlements \
  --start-block 20000000
```

### Deploy to facilitator
```bash
# Set env vars on facilitator server
export SUBSTREAMS_API_TOKEN=your_token
export SUBSTREAMS_SPKG=./agentpay_substreams-v0.1.0.spkg
export SUBSTREAMS_START_BLOCK=<x402GrantRegistry_deploy_block>

# Start streaming client alongside facilitator
python3 facilitator_substreams_client.py &
```

### Clickhouse sink (analytics layer)
```bash
# Uses streamingfast/substreams-sink-clickhouse
substreams-sink-clickhouse run \
  mainnet.base.streamingfast.io:443 \
  agentpay_substreams-v0.1.0.spkg \
  map_analytics_events \
  "clickhouse://localhost:9000/agentpay"
```

## Roadmap

- [x] Substreams manifest + module definitions
- [x] Proto schema (TransferEvent, SettlementEvent, AgentReputation, AnalyticsEvent)
- [x] Rust module stubs (map_usdc_transfers, map_confirmed_settlements, store_agent_reputation, map_analytics_events)
- [x] Facilitator Python client (asyncio Future-based, replaces poll loop)
- [x] Clickhouse sink config
- [ ] Compile + test against Base L2 testnet
- [ ] Wire `store_agent_reputation` → subgraph sink
- [ ] Deploy StreamingFast API token to facilitator server
- [ ] Benchmark: polling latency vs streaming latency at 99-agent load
- [ ] Multi-facilitator support (filter by facilitator_id field)

## Files

```
substreams/
├── agentpay-substreams/
│   ├── Cargo.toml
│   ├── build.rs
│   ├── substreams.yaml
│   ├── proto/
│   │   └── agentpay/v1/agentpay.proto
│   └── src/
│       ├── lib.rs
│       └── pb/mod.rs
├── facilitator_substreams_client.py
└── README.md
```
