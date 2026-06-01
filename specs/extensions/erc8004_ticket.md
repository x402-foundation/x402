# x402 × ERC-8004 — On-chain ticket design

Date: 2026-05-29  
Status: Phase 1 done; Phases 2–5 pending — **execution handoff:** [`erc8004_ticket_execution.md`](./erc8004_ticket_execution.md)  
Diagram: `python/x402/extensions/erc8004/x402-erc8004-ticket-flow.html`

## Problem

`ReputationRegistry.giveFeedback` is permissionless: replay, no payment proof, no composable job binding. Team agreed on an on-chain **ticket** minted atomically with x402 settlement.

## Locked decisions

| Topic | Decision |
|-------|----------|
| HTTP | 1-step x402 — same URL: 402 → sign → retry `X-PAYMENT` |
| Payment proof | `TicketMinter.settleAndMintTicket` — mint only if settle succeeds in **same tx** |
| Lifecycle | **MINTED** (settle + bind) → **CONSUMED** (feedback). **No finalize tx.** |
| Mint args (stored) | `payer, agentId, requestHash, interactionHash, endpoint` |
| Registry | `giveFeedbackWithTicket` only; legacy `giveFeedback` reverts |
| Dedup | One feedback per **ticketId** (consume-once) + per `(agentId, payer, feedbackHash)` |
| Attribution | Client submits feedback; `msg.sender == payer` (or sponsored intent) |
| Feedback gas | **Path A:** client-paid. **Path B:** facilitator-sponsored via EIP-712 `FeedbackIntent` |
| IPFS | Not required; optional `feedbackURI` |
| Ticket storage | Incrementing `ticketId` mapping, not NFT. **No `settlementTxHash` on ticket.** |

## Ticket recovery (no `ticketId` in HTTP headers)

The ticket struct does **not** store the mint tx hash. Recovery uses standard x402 + events:

1. **Preferred:** `PAYMENT-RESPONSE.extensions.erc8004.ticketId` (if agent returns it).
2. **Fallback:** `PAYMENT-RESPONSE.transaction` (standard x402) → `eth_getTransactionReceipt` → parse `TicketMinted` → `ticketId`.

If mint reverted, there is no ticket and no recovery path.

## Hashes

All use deterministic JSON (`sort_keys`, compact UTF-8) then `keccak256` — see `python/x402/extensions/erc8004/artifact.py`.

| Hash | Pre-image |
|------|-----------|
| `requestHash` | `keccak256(canonical_json(requestDigests))` |
| `interactionHash` | `keccak256(canonical_json({version, settlement*, request, response}))` — **settlement omits txHash** |
| `ticketId` | Auto-increment from minter (not hashed) |
| Agent receipt | `personal_sign(keccak256("x402-erc8004-receipt" ‖ chainId ‖ ticketId ‖ interactionHash))` — optional HTTP header |
| `feedbackHash` | `keccak256(canonical_json(fullArtifact))` at feedback time |

Off-chain artifacts may still include the settlement tx hash from `PAYMENT-RESPONSE`; it is not stored on the ticket.

## Contracts

### `TicketMinter`

```solidity
struct Ticket {
    address payer;
    uint256 agentId;
    bytes32 requestHash;
    bytes32 interactionHash;
    string endpoint;
    TicketStatus status;
}

function settleAndMintTicket(
    address payer,
    uint256 agentId,
    bytes32 requestHash,
    bytes32 interactionHash,
    string calldata endpoint,
    SettlePayment calldata payment  // token, payTo, amount — same tx, not stored on ticket
) external returns (uint256 ticketId);

function consumeTicket(uint256 ticketId, address payer) external; // registry only
function tickets(uint256 ticketId) external view returns (Ticket memory);
```

### `ReputationRegistryV3`

```solidity
function giveFeedbackWithTicket(uint256 ticketId, ...) external;
function giveFeedbackWithTicketFor(FeedbackSubmission calldata submission, ..., bytes signature) external;
function disputeFeedback(uint256 agentId, address client, uint64 feedbackIndex) external;
function giveFeedback(...) external; // reverts
```

## Implementation phases

| Phase | Scope | Status |
|-------|--------|--------|
| **1** | Solidity: `TicketMinter`, `ReputationRegistryV3`, Foundry tests | **Done** (see `erc8004_ticket_execution.md`) |
| **2** | Facilitator extension: settle → minter; deploy scripts (Anvil) | Pending approval |
| **3** | Agent server: mint gate middleware | Pending approval |
| **4** | Client: ticket bind, feedback + sponsored intent | Pending approval |
| **5** | Anvil e2e example | Pending approval |

## Repo layout (Phase 1+)

```
contracts/evm/src/erc8004/
  interfaces/ITicketMinter.sol
  interfaces/IIdentityRegistry.sol
  TicketMinter.sol
  ReputationRegistryV3.sol
contracts/evm/test/erc8004/
  mocks/MockIdentityRegistry.sol
  TicketMinter.t.sol
  ReputationRegistryV3.t.sol
python/x402/extensions/erc8004/
  ticket_hashes.py      # Phase 4
  facilitator.py        # Phase 2
```

## Upstream

Implement in this repo first; propose upgrade to [erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts) separately.

## Testing (Phase 1)

```bash
cd contracts/evm
FOUNDRY_PROFILE=erc8004 forge test --match-path "test/erc8004/*"
```

The `erc8004` profile enables `via_ir` for `ReputationRegistryV3` (stack depth with string params).
