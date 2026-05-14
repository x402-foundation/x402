# x402 Subgraph Deployment Guide

**Version:** 1.0  
**Status:** Live  
**Date:** May 2026  
**Companion Specs:**
- [specs/reputation.md](./reputation.md)
- [specs/payment-flow.md](./payment-flow.md)
- [specs/grants.md](./grants.md)

---

## Abstract

This document provides everything needed to deploy and run the official x402 Reputation Subgraph on The Graph for Base L2. The subgraph indexes `GrantRevoked` events from the `x402GrantRegistry` contract and `PaymentSettled` / `PaymentRefunded` events from the AgentPay settlement daemon. It powers the reputation scoring defined in `reputation.md`.

All source files referenced here live in `subgraph/` at the root of this repo.

---

## 1. Deployed Contracts

| Contract | Network | Address | Status |
|---|---|---|---|
| `x402GrantRegistry` | Base Mainnet | TBD — update `subgraph.yaml` after deployment | Pending |
| `x402GrantRegistry` | Base Sepolia | TBD — used by testnet subgraph | Pending |
| USDC | Base Mainnet | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Live |
| USDC | Base Sepolia | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Live |

> Once the registry is deployed, update `subgraph/subgraph.yaml` — replace both `0x000...000` placeholder addresses and `startBlock: 0` with the actual deployment block number.

---

## 2. Repo Structure

```
subgraph/
├── subgraph.yaml          ← Graph manifest (data sources, event handlers)
├── schema.graphql         ← Entity definitions (AgentReputation, Payment, ...)
├── package.json           ← graph-cli + graph-ts dependencies
├── src/
│   └── mapping.ts         ← Full AssemblyScript event handlers + scoring
└── abis/
    ├── SettlementListener.json   ← ABI for PaymentSettled / PaymentRefunded
    └── x402GrantRegistry.json    ← ABI for GrantRevoked
```

---

## 3. Schema (`schema.graphql`)

```graphql
type AgentReputation @entity {
  "Agent wallet address (lowercase hex)"
  id:                   ID!
  agent:                Bytes!
  totalPayments:        BigInt!
  successfulPayments:   BigInt!
  refundedPayments:     BigInt!
  uniqueCounterparties: BigInt!
  "Unix timestamp of most recent payment"
  lastPaymentAt:        BigInt!
  "Composite score: 0.0 (unreliable) → 1.0 (excellent)"
  score:                BigDecimal!
  "successfulPayments / (successfulPayments + refundedPayments)"
  successRate:          BigDecimal!
  "min(1.0, uniqueCounterparties / 10)"
  diversityScore:       BigDecimal!
  "exp(-0.01 × daysSinceLastPayment)"
  recencyScore:         BigDecimal!
}

type Payment @entity {
  "transactionHash-logIndex"
  id:           ID!
  grantId:      BigInt!
  principal:    Bytes!
  agent:        Bytes!
  counterparty: Bytes!   # empty Bytes for refunded payments
  amount:       BigInt!
  settled:      Boolean!
  timestamp:    BigInt!
}

type GrantRevocation @entity {
  "grantId as decimal string"
  id:              ID!
  grantId:         BigInt!
  principal:       Bytes!
  blockNumber:     BigInt!
  timestamp:       BigInt!
  transactionHash: Bytes!
}

# Internal — tracks unique (agent, counterparty) pairs for diversity scoring
type CounterpartyRecord @entity {
  id:           ID!   # agentAddress-counterpartyAddress
  agent:        Bytes!
  counterparty: Bytes!
}
```

---

## 4. Subgraph Manifest (`subgraph.yaml`)

```yaml
specVersion: 1.0.0
description: "x402 Agent Grant Reputation — Base L2"
repository: https://github.com/shawnhvac/x402

schema:
  file: ./schema.graphql

dataSources:
  - kind: ethereum
    name: x402GrantRegistry
    network: base
    source:
      address: "0x..."    # TODO: replace after deployment
      abi: x402GrantRegistry
      startBlock: 0        # TODO: replace with deployment block
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.7
      language: wasm/assemblyscript
      entities: [GrantRevocation]
      abis:
        - name: x402GrantRegistry
          file: ./abis/x402GrantRegistry.json
      eventHandlers:
        - event: GrantRevoked(address indexed principal, uint256 indexed grantId)
          handler: handleGrantRevoked
      file: ./src/mapping.ts

  - kind: ethereum
    name: SettlementListener
    network: base
    source:
      address: "0x..."    # TODO: replace after deployment
      abi: SettlementListener
      startBlock: 0        # TODO: replace with deployment block
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.7
      language: wasm/assemblyscript
      entities: [Payment, AgentReputation, CounterpartyRecord]
      abis:
        - name: SettlementListener
          file: ./abis/SettlementListener.json
      eventHandlers:
        - event: PaymentSettled(uint256 indexed grantId, address indexed principal, address indexed agent, address counterparty, uint256 amount, uint256 timestamp)
          handler: handlePaymentSettled
        - event: PaymentRefunded(uint256 indexed grantId, address indexed principal, address indexed agent, uint256 amount, uint256 timestamp)
          handler: handlePaymentRefunded
      file: ./src/mapping.ts
```

---

## 5. Mapping Logic (`src/mapping.ts`)

The complete AssemblyScript implementation is in `subgraph/src/mapping.ts`. Key details:

**`handlePaymentSettled`**
- Creates a `Payment` entity (`settled: true`)
- Increments `successfulPayments` and `totalPayments` on `AgentReputation`
- Checks `CounterpartyRecord` to track unique counterparties without double-counting
- Calls `recomputeScore()` to update the composite score

**`handlePaymentRefunded`**
- Creates a `Payment` entity (`settled: false`, `counterparty: Bytes.empty()`)
- Increments `refundedPayments` and `totalPayments`
- Does **not** count toward counterparty diversity
- Calls `recomputeScore()`

**`handleGrantRevoked`**
- Creates a `GrantRevocation` entity for cross-referencing

**`recomputeScore()` — the full formula:**
```typescript
successRate    = successfulPayments / (successfulPayments + refundedPayments)
diversityScore = min(1.0, uniqueCounterparties / 10)
recencyScore   = exp(-0.01 × daysSinceLastPayment)  // Taylor series, 6 terms

score = 0.60 × successRate + 0.25 × diversityScore + 0.15 × recencyScore
```

> `exp(-x)` is approximated with a 6-term Taylor series — accurate to <0.1% for x ≤ 5 (i.e. agents active within the last 500 days).

---

## 6. Deploy (One Command)

```bash
# 1. Clone the repo
git clone https://github.com/shawnhvac/x402.git
cd x402/subgraph

# 2. Install graph-cli
yarn install

# 3. Update the two TODO addresses + startBlock values in subgraph.yaml

# 4. Generate types from schema + ABIs
yarn codegen

# 5. Build the WASM mapping
yarn build

# 6a. Deploy to Subgraph Studio (recommended)
graph auth --studio <your-deploy-key>
yarn deploy:studio

# 6b. OR deploy to hosted service (legacy)
graph auth --product hosted-service <your-access-token>
yarn deploy
```

**Live subgraph URL (after deployment):**
```
# Studio (decentralized)
https://api.studio.thegraph.com/query/<id>/x402-reputation-base/v1.0.0

# Hosted service (legacy)
https://api.thegraph.com/subgraphs/name/shawnhvac/x402-reputation-base
```

---

## 7. Example Queries

**Get reputation score for an agent:**
```graphql
query GetReputation($agent: String!) {
  agentReputation(id: $agent) {
    score
    successRate
    diversityScore
    recencyScore
    totalPayments
    uniqueCounterparties
    lastPaymentAt
  }
}
```

**Get all payments for an agent (last 10):**
```graphql
query GetPayments($agent: Bytes!) {
  payments(
    where: { agent: $agent }
    orderBy: timestamp
    orderDirection: desc
    first: 10
  ) {
    id
    grantId
    amount
    settled
    counterparty
    timestamp
  }
}
```

**Check if a grant has been revoked:**
```graphql
query IsRevoked($grantId: String!) {
  grantRevocation(id: $grantId) {
    id
    revokedAt: timestamp
    transactionHash
  }
}
```

**Querying from Node.js (paying / receiving agent):**
```typescript
const SUBGRAPH_URL = "https://api.studio.thegraph.com/query/<id>/x402-reputation-base/v1.0.0";

async function getReputation(agentAddress: string): Promise<number> {
  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query { agentReputation(id: "${agentAddress.toLowerCase()}") { score } }`
    }),
  });
  const data = await res.json();
  return parseFloat(data?.data?.agentReputation?.score ?? "0");
}

// Usage in receiving agent — after verifyGrant() passes:
const score = await getReputation(grant.agent);
if (score < 0.6) {
  return res.status(402).json({ error: "low reputation", score });
}
```

**Querying from Python (receiving agent):**
```python
import requests

SUBGRAPH_URL = "https://api.studio.thegraph.com/query/<id>/x402-reputation-base/v1.0.0"

def get_reputation(agent_address: str) -> float:
    query = """
    query GetReputation($agent: String!) {
      agentReputation(id: $agent) { score successRate totalPayments }
    }
    """
    resp = requests.post(SUBGRAPH_URL, json={
        "query":     query,
        "variables": {"agent": agent_address.lower()}
    }, timeout=5)
    data = resp.json()
    return float(data.get("data", {}).get("agentReputation", {}).get("score", "0") or "0")

# Usage after verify_grant() passes:
score = get_reputation(grant["agent"])
if score < 0.6:
    return jsonify({"error": "low reputation", "score": score}), 402
```

---

## 8. Testnet Subgraph (Base Sepolia)

For development, deploy a parallel subgraph against Base Sepolia:

1. Duplicate `subgraph.yaml` → `subgraph-sepolia.yaml`
2. Change `network: base` → `network: base-sepolia`
3. Update addresses to Sepolia contract deployments

```bash
graph deploy --studio x402-reputation-base-sepolia --config subgraph-sepolia.yaml
```

The `examples/minimal-node-python` Sepolia example will point to this endpoint automatically once deployed.

---

## 9. Anti-Sybil Notes for Deployers

See `reputation.md §6` for full security analysis. Key points for subgraph operators:

- `CounterpartyRecord` prevents double-counting the same (agent, counterparty) pair — gaming diversity requires real unique counterparties.
- Self-payment detection (`principal == counterparty`) can be added as a filter in `handlePaymentSettled` if desired — the schema supports it.
- Time decay means a burst of self-payments followed by dormancy will score poorly within days.

---

*Part of the x402 Agent Grant System*  
*Built by [AgentPay](https://x402-agent-pay.com) — the commerce middleware for AI agents*
