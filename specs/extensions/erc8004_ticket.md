# x402 × ERC-8004 — On-chain ticket design

Date: 2026-05-29  
Status: Phase 1 in progress  
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
| Dedup | Per `(agentId, payer)`: one per `settlementTxHash`, one per `feedbackHash` |
| Attribution | Client submits feedback; `msg.sender == payer` (or sponsored intent) |
| Feedback gas | **Path A:** client-paid. **Path B:** facilitator-sponsored via EIP-712 `FeedbackIntent` |
| IPFS | Not required; optional `feedbackURI` |
| Ticket storage | Mapping + `ticketIdByTxHash`, not NFT |

## Hashes

All use deterministic JSON (`sort_keys`, compact UTF-8) then `keccak256` — see `python/x402/extensions/erc8004/artifact.py`.

| Hash | Pre-image |
|------|-----------|
| `requestHash` | `keccak256(canonical_json(requestDigests))` |
| `interactionHash` | `keccak256(canonical_json({version, settlement*, request, response}))` — **settlement omits txHash** |
| `settlementTxHash` | Mint tx hash (chain-assigned) |
| Agent receipt | `personal_sign(keccak256("x402-erc8004-receipt" ‖ chainId ‖ settlementTxHash ‖ interactionHash))` — optional HTTP header |
| `feedbackHash` | `keccak256(canonical_json(fullArtifact))` at feedback time |

## Contracts

### `TicketMinter`

```solidity
function settleAndMintTicket(
    address payer,
    uint256 agentId,
    bytes32 requestHash,
    bytes32 interactionHash,
    string calldata endpoint,
    SettlePayment calldata payment  // token, payTo, amount — same tx, not stored on ticket
) external returns (uint256 ticketId);

function consumeTicket(uint256 ticketId, address payer) external; // registry only
function ticketIdByTxHash(bytes32 txHash) external view returns (uint256);
function tickets(uint256 ticketId) external view returns (Ticket memory);
```

### `ReputationRegistryV3`

```solidity
function giveFeedbackWithTicket(uint256 ticketId, ...) external;
function giveFeedbackWithTicketFor(address payer, uint256 ticketId, ..., bytes signature) external;
function disputeFeedback(uint256 agentId, address client, uint64 feedbackIndex) external;
function giveFeedback(...) external; // reverts
```

## Implementation phases

| Phase | Scope | Status |
|-------|--------|--------|
| **1** | Solidity: `TicketMinter`, `ReputationRegistryV3`, Foundry tests | In progress |
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
