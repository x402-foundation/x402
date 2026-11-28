# Scheme: `pause-commit`

## Summary

`pause-commit` is a payment scheme for x402 that adds two capabilities missing from existing schemes: **pre-payment address risk scoring** and **payer-controlled cancellation**.

The scheme uses off-chain EIP-712 signatures for payment authorization (zero gas for the client) and on-chain atomic settlement via the PAUSECommit smart contract. Between authorization and settlement, the client can revoke the payment if the server fails to deliver.

## Problem

Existing x402 schemes (`exact`, `upto`) transfer funds before or during resource delivery. The client has no recourse if:

- The `payTo` address has been compromised or is associated with known scams
- The server fails to deliver the requested resource after payment
- The `payTo` address changes between requests (V2 dynamic routing)

The 402Bridge incident (October 2025) demonstrated that compromised `payTo` addresses can drain users without any pre-payment check.

## How It Works

The scheme operates in two phases:

**Phase 1 — Intent**: Client scores the `payTo` address against 11 Bayesian risk signals via the PAUSE Risk Engine. If the address passes (score >= 40), the client signs an EIP-712 PaymentIntent off-chain. No gas cost. Funds remain in the client's wallet.

**Phase 2 — Commit**: The server (or facilitator) calls `PAUSECommit.commit()` on-chain to settle the payment atomically. Only the recipient (`to` address) can call commit. If the server never commits, the client can call `revoke()` to permanently cancel the intent.

## Use Cases

- High-value API calls where the client needs cancellation ability
- First-time interactions with unknown service providers
- Agent-to-agent payments where neither party has prior trust
- Regulated environments requiring pre-payment risk assessment

## Comparison with Other Schemes

| Property | exact | pause-commit |
|----------|-------|--------------|
| Payment timing | Before delivery | After delivery |
| Cancellable | No | Yes, before commit |
| Pre-payment risk scoring | No | 11 Bayesian signals |
| Client gas cost | ~21k (EIP-3009) | Zero (off-chain EIP-712) |
| Server gas cost | N/A | ~85k (settlement) |
| Best for | Micropayments | High-value + safety |
| Caller restriction | Facilitator | Only recipient can commit |

## Risk Assessment

Before signing a PaymentIntent, the client screens the `payTo` address using the PAUSE Risk Engine. The engine evaluates 11 independent Bayesian signals:

| Signal | Weight | Detection |
|--------|--------|-----------|
| Mixer Exposure | 0.45 | Tornado Cash interaction |
| Draining Pattern | 0.30 | Wallet drainer behavior |
| Exchange Cluster | 0.25 | Exchange wallet proximity |
| Sweep Pattern | 0.25 | Funds consolidation |
| TX Burst Anomaly | 0.20 | Bot-like transaction spikes |
| Scam Graph | 0.20 | Community-reported scam connections |
| Dusting Attack | 0.15 | Micro-transaction tracking |
| ENS Authenticity | 0.15 | Domain ownership verification |
| Rival Consensus | 0.15 | External scoring cross-reference |
| Wallet Age | 0.10 | Account age and activity |
| Balance Volatility | 0.10 | Abnormal balance patterns |

Signals are combined using log-odds scoring with correlation discounting to produce a score from 0-100. Addresses scoring below 40 are blocked before any signature is created.

## Security Properties

1. **Non-custodial**: Funds remain in the client's wallet until atomic settlement
2. **Recipient-only commit**: Only the `to` address can call `commit()` — prevents front-running
3. **Sender-only revoke**: Only the `from` address can call `revoke()` — prevents griefing
4. **Expiry enforcement**: Intents expire automatically after the `expiry` timestamp
5. **Replay protection**: Each intent uses a unique nonce; committed and revoked intents cannot be reused
6. **Chain binding**: The `chainId` field prevents cross-chain replay attacks

## Infrastructure

| Component | URL | Status |
|-----------|-----|--------|
| Smart Contract (Ethereum) | [`0x604152D82Fd031cCD8D27F26C5792AC2CD328bF4`](https://etherscan.io/address/0x604152D82Fd031cCD8D27F26C5792AC2CD328bF4) | Deployed, verified |
| Risk Engine API | `https://api.pausescan.com/api/v1/analyze` | Live |
| Facilitator | `https://facilitator.pausesecure.com` | Live |
| npm (risk) | [`@pausesecure/x402-risk`](https://www.npmjs.com/package/@pausesecure/x402-risk) | Published |
| npm (commit) | [`@pausesecure/x402-commit`](https://www.npmjs.com/package/@pausesecure/x402-commit) | Published |

## Network-Specific Implementations

- [`scheme_pause_commit_evm.md`](./scheme_pause_commit_evm.md) — EVM implementation details
