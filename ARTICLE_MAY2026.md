# We Built the OAuth of Agent Payments — Here's Everything We Shipped

*AgentPay Team — May 15, 2026*

---

AI agents can now browse the web, write code, manage calendars, and run complex workflows — but they still can't reliably pay each other. When an agent needs to call another agent's API, buy data, or hire a tool, the payment layer falls apart: shared API keys, manual invoicing, human approval gates, or just... nothing.

We spent the last several weeks fixing that. Here's everything we shipped.

---

## The Problem: Agents Can Work. They Can't Pay.

The HTTP 402 status code — "Payment Required" — has existed since 1997. It was always intended to be the web's native payment signal. It was never implemented because there was no good way to settle payments automatically in a request.

AI agents change the equation. An agent can hold a wallet, sign transactions, and verify receipts — all without a human in the loop. x402 is the missing piece: a standard that makes HTTP 402 actually work, for agents paying agents.

---

## What We Built

### 1. The Agent Grant System

The core primitive: an **EIP-712 signed grant object** that a principal (human or orchestrator) creates and hands to an agent.

A grant looks like this:

```json
{
  "principal": "0xAlice",
  "agent": "0xMyAgent",
  "perRequestCap": "1000000",
  "totalBudget": "50000000",
  "validUntil": 1748000000,
  "allowedScopes": ["weather/*", "data/prices"],
  "nonce": "0xdeadbeef..."
}
```

The agent presents this grant on every HTTP request via an `X-402-Payment` header. The receiving agent verifies the EIP-712 signature **offline** — no RPC call needed in the happy path. The grant is short-lived (hours or days), budget-capped, and scope-restricted. It's IAM for agents.

The full spec lives at [github.com/shawnhvac/x402/specs/grants.md](https://github.com/shawnhvac/x402/blob/main/specs/grants.md).

---

### 2. Event-Driven Settlement Daemon

Before this, settlement was "assume-settled-on-broadcast" — broadcast the transaction, hope it confirmed, move on. That's brittle.

We replaced it with a proper event-driven settlement listener running as a `systemd` daemon on Base L2:

- Broadcasts the EIP-3009 `transferWithAuthorization` tx
- Polls `eth_getTransactionReceipt` every 2 seconds across 4 RPC endpoints
- On confirmation (1 block): status = `settled`, service released
- On revert: status = `reverted`, refund triggered instantly
- On 60-second timeout: status = `timed_out`, refund triggered
- Full audit trail: `settlement_events` table + `confirmed_at`, `block_number`, `settlement_latency_ms` on every ledger entry

Hot path latency is now **2–6 seconds** to confirmation on Base L2. The daemon auto-restarts, picks up any pending transactions on crash recovery, and runs completely without human intervention.

---

### 3. Conformance Suite with Real Test Vectors

Any team implementing x402 grant verification needs to know their implementation is correct. We built a one-command conformance suite:

```bash
cd test && npm install && npm test
```

Six test vectors generated with real Hardhat signatures:
- `valid-grant` — baseline happy path
- `expired-grant` — `validUntil` in the past
- `wrong-agent` — signature valid but agent address mismatch
- `near-expiry-revocation-check` — grant in final 30% of lifetime
- `clock-skew-grace` — 5-minute tolerance window
- `zero-per-request-cap` — edge case: cap = 0

All six pass. The test vectors are serialized to `specs/test-vectors.json` so any language can verify against them without re-running the Hardhat suite.

---

### 4. End-to-End Examples (Local + Real Base Sepolia)

A minimal example: a **Node.js paying agent** and a **Python receiving agent**. Clone and run in 60 seconds with no wallet and no gas.

Then flip two environment variables and the same example runs against **real Base Sepolia** with live USDC via EIP-3009 `transferWithAuthorization`. Real transaction hash, real block confirmation, real receipt header.

The receiving agent in Python is about 80 lines. The Node.js paying agent is under 100. Both are built to be read and forked, not abstracted away.

---

### 5. Reputation Layer

Payment volume alone is gameable. An agent can pay itself a thousand times and look reliable. We designed an optional reputation layer that's harder to fake:

**Score = 0.60 × successRate + 0.25 × diversityScore + 0.15 × timeDecayFactor**

- **successRate** — settled payments / (settled + refunded), last 90 days
- **diversityScore** — unique counterparties / 10 (saturates at 10 real receivers)
- **timeDecayFactor** — exp(−0.01 × days since last payment)

The score is indexed by The Graph subgraph on Base L2 and queryable by any receiver. Receivers can check reputation *after* grant verification passes, gate high-value requests on a score threshold, and cache results for 60 seconds.

Gaming this requires real USDC movement across many real unique counterparties with successful settlements. It's economically expensive to fake — which is the point.

The spec is at [specs/reputation.md](https://github.com/shawnhvac/x402/blob/main/specs/reputation.md).

---

### 6. Production-Ready Subgraph Workspace

The subgraph that powers reputation scoring is fully written and waiting for contract deployment. The workspace at `subgraph/` contains:

- `subgraph.yaml` — manifest with both data sources (`x402GrantRegistry` + `SettlementListener`)
- `schema.graphql` — four entities: `AgentReputation`, `Payment`, `GrantRevocation`, `CounterpartyRecord`
- `src/mapping.ts` — 277 lines of complete AssemblyScript. Not stubs. Full event handlers, score computation, counterparty diversity tracking, and a Taylor-series `exp(−x)` approximation (AssemblyScript has no `Math.exp` for `BigDecimal`)
- ABIs for both contracts

Deploy in one flow:

```bash
cd x402/subgraph
yarn install && yarn codegen && yarn build
graph auth --studio <your-deploy-key>
yarn deploy:studio
```

Two TODOs remain in `subgraph.yaml`: the `x402GrantRegistry` contract address and its deployment block number. Once those are filled in, the subgraph goes live.

---

### 7. COMMUNITY.md — An Open Standard, Not a Product

We structured this as a real open standard from day one. The repo now has:

- **6 live spec documents** covering every layer of the stack
- **A conformance suite** anyone can run against their implementation
- **COMMUNITY.md** — an open table for tracking implementations, with clear instructions for adding yours via PR
- **A professional README** with badges, 60-second quickstart, and status table

The goal is that any team — using any language, any framework — can implement x402 grant verification and interoperate with AgentPay without touching our infrastructure. That's what makes it a standard rather than a product.

---

## What's Next

The one remaining piece: the hosted subgraph endpoint. We're coordinating with James Mulqueeny at BuildersDAO / The Graph to deploy the official subgraph on Base L2 mainnet. Once that's live, the "pending deploy" status flips to live and reputation scores become queryable from any receiver.

After that: community outreach, more language implementations (Rust, Go), and the first external PRs to COMMUNITY.md.

---

## Try It

```bash
git clone https://github.com/shawnhvac/x402.git
cd x402/examples/minimal-node-python

# Terminal 1
cd python-receiving-agent && pip install -r requirements.txt && python app.py

# Terminal 2
cd node-paying-agent && npm install && npm start
```

Full payment cycle — grant → verify → settle → receipt — in your terminal. No wallet. No gas. No setup.

Ready to go on-chain? See [BASE_SEPOLIA.md](https://github.com/shawnhvac/x402/blob/main/examples/minimal-node-python/BASE_SEPOLIA.md).

---

*AgentPay is the reference implementation of the x402 Agent Grant system — the commerce middleware for AI agents on Base L2.*

*[x402-agent-pay.com](https://x402-agent-pay.com) · [github.com/shawnhvac/x402](https://github.com/shawnhvac/x402) · [COMMUNITY.md](https://github.com/shawnhvac/x402/blob/main/COMMUNITY.md)*
