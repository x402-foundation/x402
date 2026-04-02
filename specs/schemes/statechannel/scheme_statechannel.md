# Scheme: `statechannel`

## Summary

`statechannel` is a scheme for **off-chain micropayments** backed by on-chain state channels. A payer and counterparty maintain a bidirectional channel funded with ERC-20 tokens (or native ETH) and exchange cryptographically signed balance updates as payment. On-chain transactions are required only for lifecycle events (open, deposit, dispute, close), not for individual payments.

The scheme supports two route modes, declared in the `extensions` object:

| Route | Mode value | Description |
|-------|------------|-------------|
| Hub-routed | `hub` | Payer opens one channel with a hub. Hub routes payments to any registered payee. |
| Direct | `direct` | Payer opens a channel directly with the payee. No intermediary. |

Both modes preserve standard x402 `402` challenge-and-retry semantics. Payees return `402 Payment Required` with statechannel offers; clients construct payment proofs and retry. The only difference from `exact` is that the payment proof is a signed off-chain state update (or hub-issued ticket) instead of a token transfer authorization.

## Use Cases

- **High-frequency AI tool/API calls** — An agent paying $0.001 per API call across dozens of services through a single hub channel, with zero gas cost per call.
- **Metered streaming** — Pay-per-second audio/video, pay-per-token LLM generation, or pay-per-reading IoT sensor data via interval-based ticks.
- **Multi-payee routing** — One funded channel to a hub enables payment to any payee, eliminating per-payee channel overhead.
- **Low-latency "pay and retry"** — Payment completes in a single HTTP round-trip with no on-chain confirmation wait.

## How It Differs from `exact`

| Property | `exact` | `statechannel` |
|----------|---------|----------------|
| On-chain transactions per payment | 1 | 0 (amortized over channel lifetime) |
| Payments before on-chain settlement | 1 | Unlimited (bounded by channel balance) |
| Latency per payment | Block confirmation time | Single HTTP round-trip |
| Minimum viable payment | Gas-bound (~$0.01+) | Arbitrary (1 wei+) |
| Client state | Stateless | Stateful (channel nonce, balance) |
| Trust model | Trustless (on-chain transfer) | Trust-minimizing (off-chain with on-chain dispute) |

## Trust Model

### Hub Route (`hub`)

- **Payer risk:** Bounded by the signed debit amount plus `maxFee`. The payer never authorizes more than they explicitly sign.
- **Payee risk:** Bounded by hub signature validity and ticket expiry. Payee trusts that the hub will settle according to ticket terms.
- **Hub risk:** Protected by valid channel state updates proving the payer's debit authorization. Hub cannot move funds without a co-signed state.

### Direct Route (`direct`)

- **Payer risk:** Same as hub-routed — bounded by signed debit.
- **Payee risk:** Payee has on-chain dispute rights. Can submit the highest-nonce signed state to the channel contract for settlement.

## Core Security Requirements

Implementations MUST enforce:

1. **Nonce monotonicity** — `stateNonce` MUST strictly increase for each accepted update per channel.
2. **Balance conservation** — `balA + balB` MUST equal the channel's on-chain `totalBalance`.
3. **Signature binding** — Every state update MUST be verified via EIP-712 typed data recovery, binding the signer to the channel, nonce, and balance split.
4. **Expiry enforcement** — Quotes, tickets, and state updates with elapsed expiry MUST be rejected.
5. **Bounded debit** — Each payment MUST debit no more than `amount + disclosed fees` from the payer's balance.
6. **Replay protection** — `channelId` (scoped to chain + contract + participants + salt) plus `stateNonce` plus EIP-712 `chainId` prevent cross-channel and cross-chain replay. `paymentId`/`invoiceId` identifiers MUST be idempotent when present.
7. **Challenge-period dispute** — Unilateral close MUST include a challenge window during which the counterparty can submit a higher-nonce state.

## Extension Metadata

The `statechannel` scheme uses the standard x402 v2 `extensions` object under the key `"statechannel"` to convey route-specific configuration.

### Common Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `route` | `"hub"` \| `"direct"` | Yes | Route mode for this offer |

### Hub Route Fields (`route: "hub"`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hubEndpoint` | string (URL) | Yes | Hub metadata discovery URL (e.g., `https://pay.eth/.well-known/x402`). Clients fetch this to discover hub capabilities, then derive API routes (`/v1/tickets/quote`, `/v1/tickets/issue`, etc.) from the same origin. |
| `mode` | string | No | Settlement policy hint. Default: `"proxy_hold"` |
| `feeModel` | object | No | `{ "base": "<uint>", "bps": <int> }` — hub fee formula |
| `quoteExpiry` | number | No | Unix timestamp when quote expires |

### Direct Route Fields (`route: "direct"`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payeeAddress` | EVM address | Yes | Payee's on-chain address (channel counterparty) |
| `challengePeriodSec` | number | No | Challenge window duration for dispute |

Servers SHOULD offer at least one fallback scheme (e.g., `exact`) alongside statechannel offers during rollout. Servers MAY include multiple statechannel offers with different route modes in the same `accepts[]` array.

## Critical Validation Requirements

While implementation details vary by network, verifiers MUST enforce security constraints that prevent fund theft and replay:

### EVM

- **Signer recovery:** The recovered signer from the EIP-712 digest MUST match the expected payer (`participantA` for hub route, channel counterparty for direct).
- **Nonce ordering:** `stateNonce` MUST be strictly greater than the last accepted nonce for the same channel.
- **Balance conservation:** `balA + balB` MUST equal the channel's on-chain `totalBalance`.
- **Debit correctness:** The balance delta (`previous.balA - current.balA`) MUST be greater than or equal to `accepted.amount`.
- **Expiry validity:** States with `stateExpiry > 0 && now > stateExpiry` MUST be rejected.
- **Ticket binding (hub route):** `channelProof.stateHash` MUST equal the hash of the submitted channel state. If `ticket.stateHash` is present, it MUST match `channelProof.stateHash`. `ticket.sig` MUST recover to the hub's advertised address.

Network-specific rules are in: `scheme_statechannel_evm.md` (EVM).

## Appendix

- Core protocol types: [`x402-specification-v2.md`](../../x402-specification-v2.md)
- EVM payload, verification, and settlement: [`scheme_statechannel_evm.md`](./scheme_statechannel_evm.md)
- Reference implementation: [github.com/Keychain-Inc/x402s](https://github.com/Keychain-Inc/x402s)
- Full SCP specification: [X402S_SPEC_V2.md](https://github.com/Keychain-Inc/x402s/blob/main/docs/X402S_SPEC_V2.md)
