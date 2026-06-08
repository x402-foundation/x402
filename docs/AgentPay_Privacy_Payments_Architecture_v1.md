# AgentPay × Substreams — Privacy Payments Update

**From:** Shawn Lippert, AgentPay | June 8, 2026
**Re:** Privacy payment path added to the x402 rail — impact on settlement indexing
**Companion to:** [AgentPay_Substreams_Architecture_v2.md](https://github.com/shawnhvac/x402/blob/main/docs/AgentPay_Substreams_Architecture_v2.md)

---

## TL;DR

The x402 payment rail now supports **two settlement modes**:

1. **Standard** — public EIP-3009 `TransferWithAuthorization` (unchanged, already streaming).
2. **Private** — a shielded path where the payer→payee link is hidden on-chain, while settlement finality and payment validity stay verifiable.

The Substreams package now needs to recognize both, emit a consistent `SettlementEvent` for each, and tag which mode produced it — without ever leaking the private-path counterparties into the public subgraph.

---

## Why We Added a Privacy Path

Agent-to-agent commerce has a real problem: every payment on a public rail exposes **who pays whom, how much, and how often**. For autonomous agents competing in the same market, that's a live feed of your suppliers, your margins, and your demand.

The privacy path lets two agents settle in USDC on Base with:

- **Amount + finality still provable** (the facilitator can confirm a valid payment occurred),
- **Counterparty graph hidden** (the public chain does not reveal payer↔payee),
- **Same x402 semantics** — a 402 challenge is answered, the facilitator releases after finality.

Standard mode stays the default. Privacy is opt-in per payment via the x402 challenge response.

---

## Current Pipeline (Recap)

```
Base L2 Blocks (Firehose, --final-blocks-only)
      |
      v
[map_usdc_transfers]
  - USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
  - TransferWithAuthorization (EIP-3009)
      |
      v
[map_confirmed_settlements]   <- final blocks only
  - Filters to transfers TO facilitator wallet
  - Emits SettlementEvent (payment_id from EIP-3009 nonce)
      |
      +--> [store_agent_stats]  StoreAddInt64 deltas, keyed by agent wallet
```

---

## New Pipeline (With Privacy Mode)

```
Base L2 Blocks (Firehose, --final-blocks-only)
      |
      +-----------------------------+
      v                             v
[map_usdc_transfers]        [map_shielded_settlements]
  (standard EIP-3009)         - Detects deposits to the shielded
      |                         settlement contract
      v                       - Reads the public commitment / nullifier
[map_confirmed_settlements]   - NO payer->payee link on-chain
  - mode = "standard"         - mode = "private"
      |                             |
      +--------------+--------------+
                     v
            [map_settlements]   <- unified SettlementEvent
              - payment_id
              - amount_usdc
              - mode: standard | private
              - finalized: true
              - counterparties: present (standard) | omitted (private)
                     |
                     +--> [store_agent_stats]      (standard only — wallet-keyed)
                     +--> [store_settlement_totals] (both — aggregate, NO graph)
```

**Key design rule:** private-mode events feed **aggregate** stores only (volume, count, success/refund totals). They never write a payer↔payee edge. Reputation for shielded payments accrues to the **payee's** opt-in disclosure key, not by de-anonymizing the chain.

---

## What Each Module Emits

| Field | Standard | Private |
|---|---|---|
| `payment_id` | EIP-3009 nonce | commitment hash |
| `amount_usdc` | ✅ exact | ✅ exact (range-proof verified) |
| `payer` | ✅ wallet | ⛔ omitted |
| `payee` | ✅ wallet | ✅ only if payee opts in for reputation |
| `mode` | `"standard"` | `"private"` |
| `finalized` | ✅ | ✅ |

The subgraph schema gains a `mode` enum on `Settlement` and a separate `ShieldedSettlementTotal` aggregate entity. Nothing in the public GraphQL surface can reconstruct a private payer.

---

## How This Changes Reputation

We still want external agents to query:

```graphql
agentReputation(wallet: "0x...") {
  totalSettlements
  successRate
  uniqueCounterparties   # standard-mode only
  shieldedVolumeUsd      # private-mode, opt-in disclosure
}
```

- **Standard mode** → full graph reputation as before (`store_agent_stats`).
- **Private mode** → contributes to volume/success totals via a payee disclosure key, so an honest agent can *prove* reputation without exposing who paid them.

This keeps reputation meaningful while honoring the privacy guarantee.

---

## Three Things We Still Need from The Graph

*(Carried over from v2 — still the blockers, now with the privacy context.)*

### 1. x402GrantRegistry — address + startBlock on Base
Still needed so grant-funded settlements get their own module and tag. Works the same for both standard and private modes (grant flag lives on the registry, not the counterparty).

### 2. Reputation surface — subgraph vs. ClickHouse
Now with the added wrinkle of **two reputation channels** (public graph + shielded aggregate). Does a single subgraph with a `mode` enum + a disclosure-key resolver still feel right to you, or would you split the shielded aggregate into a separate store/sink?

### 3. Deployment path
Fresh start, no existing subgraph. Hosted service first, or straight to the decentralized network — and does the privacy aggregate change your recommendation?

---

## Status

- ✅ `agentpay-substreams-v0.1.0.spkg` — standard path live & streaming on Base mainnet
- 🔨 `map_shielded_settlements` + `map_settlements` (unifier) — in development
- 🔨 Subgraph schema with `mode` enum + `ShieldedSettlementTotal` — drafting
- ⛔ Blocked on: x402GrantRegistry address, subgraph pattern gut-check, deployment path

Happy to drop the module code, walk through the shielded-settlement detection, or coordinate a PR review — async works great on our side.

---

*Shawn Lippert | AgentPay Team | x402-agent-pay.com | @shawnhvac*
*github.com/shawnhvac/x402 | 95b Havasupai St, Grand Canyon, AZ 86023*
