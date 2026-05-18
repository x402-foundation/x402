# x402 Community & Implementations

**Version:** 1.0  
**Status:** Live  
**Date:** May 2026

Welcome to the x402 community. This document tracks real-world implementations of the x402 Agent Grant system, payment flow, and reputation layer. The entire stack is open — anyone can implement the spec without AgentPay.

---

## Current Implementations

| Project | Language(s) | What it implements | Network | Links |
|---|---|---|---|---|
| **Official Minimal Example** | Node.js + Python | Paying agent + Receiving agent (local + EIP-3009 settlement) | Local / Base Sepolia | [examples/minimal-node-python](./examples/minimal-node-python/) |
| **AgentPay** | TypeScript / Python | Full infrastructure — escrow daemon, grant registry, settlement listener, reputation scoring | Base L2 (mainnet) | [x402-agent-pay.com](https://x402-agent-pay.com) |
| **x402 Reputation Subgraph** | AssemblyScript | The Graph subgraph — indexes PaymentSettled, PaymentRefunded, GrantRevoked → scores agents 0.0–1.0 | Base L2 (pending deploy) | [subgraph/](./subgraph/) |
| *Your implementation here* | — | — | — | *[open a PR](#how-to-add-yours)* |

---

## Spec Status

All six spec documents are **Live** in [`specs/`](./specs/):

| Spec | What it covers |
|---|---|
| [grants.md](./specs/grants.md) | EIP-712 signed spend delegation — the core primitive |
| [test-vectors.md](./specs/test-vectors.md) | Real Hardhat signatures — verify your implementation is correct |
| [conformance.md](./specs/conformance.md) | `npm test` — one command to validate any verifier |
| [payment-flow.md](./specs/payment-flow.md) | End-to-end lifecycle with sequence diagram |
| [reputation.md](./specs/reputation.md) | Optional Sybil-resistant scoring via The Graph |
| [subgraph.md](./specs/subgraph.md) | Deploy the reputation subgraph in one command |

---

## How to Add Yours

1. **Fork the repo** and open a PR against `main`.
2. **Add a row** to the table above:
   - Project name + GitHub link
   - Language(s)
   - What it implements — e.g. "grant verifier only", "full paying agent", "receiving agent + subgraph query"
   - Network — Local / Sepolia / Mainnet
   - Link to your repo or live demo
3. **(Optional but recommended)** Run the conformance suite and note it passes:
   ```bash
   cd test && npm install && npm test
   ```
4. We'll review and merge within 24 hours.

---

## The Stack at a Glance

```
Grant signing (Node/Python/Go/any)
         │
         ▼
   HTTP request + X-402-Payment header
         │
         ▼
Receiving agent: verifyGrant() → replay check → EIP-3009 settlement
         │
         ▼
   X-402-Receipt (real Base L2 tx hash)
         │
         ▼
   The Graph subgraph indexes PaymentSettled
         │
         ▼
   Reputation score updated (0.0–1.0)
```

The minimal example covers every layer end to end:
- **Local mode** — clone + run in 60 seconds, no wallet needed
- **Base Sepolia** — real USDC, real tx hashes, one `.env` file
- **Base mainnet** — swap two env vars

---

## Get Involved

- **Questions / feedback** — open an [issue](../../issues)
- **Implementations** — submit a PR with a table update above
- **Subgraph** — the official hosted subgraph is being coordinated with James Mulqueeny (BuildersDAO) — see [specs/subgraph.md](./specs/subgraph.md)
- **Discussions** — tag `@shawnhvac` or `@x402agentpay` on X

---

## Conformance

Any implementation can verify correctness against the published test vectors:

```bash
git clone https://github.com/shawnhvac/x402.git
cd x402/test
npm install
npm test
```

Expected output:
```
x402 Grant Conformance Suite
  ✓ valid-grant                  (3ms)
  ✓ expired-grant
  ✓ wrong-agent
  ✓ near-expiry-revocation-check
  ✓ clock-skew-grace
  ✓ zero-per-request-cap

  6 passing
```

---

*The goal: x402 becomes the OAuth of agent payments — a real, battle-tested standard that any team can implement and interoperate with.*


## Partner Revenue Program

Integration partners earn from the AgentPay facilitator fee pool. Pass your `partner_id` on each request — earnings accumulate and auto-pay monthly to your Base L2 wallet.
See [PARTNER_REVENUE.md](./PARTNER_REVENUE.md) for the full model, tiers, and projections.

*Built by [AgentPay](https://x402-agent-pay.com) — the commerce middleware for AI agents.*
