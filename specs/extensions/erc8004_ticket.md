# x402 × ERC-8004 — On-chain ticket design

Date: 2026-05-29 (last updated 2026-06-02)
Status: **Phases 1–5 complete.** Branch `feat/erc8004-extension`; execution log: [`erc8004_ticket_execution.md`](./erc8004_ticket_execution.md)
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
| **1** | Solidity: `TicketMinter`, `ReputationRegistryV3`, Foundry tests | **Done** |
| **2** | Solidity EIP-3009 + Permit2 settle paths; Foundry deploy script; Python facilitator extension (`ERC8004TicketFacilitatorExtension`, `settle_via_ticket_minter`, `ticket_id_from_receipt`); `TICKET_MINTER_ABI` constants | **Done** |
| **3** | Resource-server extension: mint-required gate (`after_verify` rejects payloads without bind), `enrich_settlement_response` forwards `ticketId`; **Phase 3.4** — `ExactEvmScheme.settle` routes through `TicketMinter` when the facilitator extension is registered and the payload carries a bind | **Done** |
| **4** | Client SDK: `ticket_hashes.py` (`compute_request_hash`, `compute_ticket_bind`, `echo_ticket_bind_in_payment_payload`); `ERC8004ClientExtension.set_ticket_bind`; feedback methods (`submit_feedback_with_ticket`, `build_feedback_intent`, `submit_feedback_sponsored`, `ticket_id_from_receipt`); receipt digest migrated to `(chainId, ticketId, interactionHash)` | **Done** |
| **5** | Anvil e2e: `run_ticket_demo.py` forks mainnet, impersonates Circle / DAI-bridge whales for real USDC + DAI funding, registers a fresh agent on the **canonical IdentityRegistry** (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`), runs USDC-EIP-3009 + DAI-transferFrom scenarios × Path A direct + Path B sponsored = 4 tickets MINTED→CONSUMED | **Done** |

## Repo layout

```
contracts/evm/src/erc8004/
  interfaces/ITicketMinter.sol        # SettlePayment, EIP3009Settlement, Permit2Settlement
  interfaces/IIdentityRegistry.sol
  TicketMinter.sol                    # settleAndMintTicket{,EIP3009,Permit2}
  ReputationRegistryV3.sol            # giveFeedbackWithTicket{,For}
contracts/evm/test/erc8004/
  mocks/MockIdentityRegistry.sol
  TicketMinter.t.sol
  ReputationRegistryV3.t.sol
contracts/evm/script/
  DeployERC8004Ticket.s.sol           # Phase 2
python/x402/extensions/erc8004/
  facilitator.py        # ERC8004TicketFacilitatorExtension, settle_via_ticket_minter
  ticket_hashes.py      # compute_request_hash, compute_ticket_bind, echo into payload
  server.py             # create_erc8004_resource_server_extension (mint-required gate)
  client.py             # ERC8004ClientExtension.set_ticket_bind, submit_feedback_with_ticket,
                        # build_feedback_intent, submit_feedback_sponsored
  artifact.py           # receipt_digest(chainId, ticketId, interactionHash)
  constants.py          # TICKET_MINTER_ABI, get_ticket_minted_topic
python/x402/mechanisms/evm/exact/
  facilitator.py        # _maybe_route_to_ticket_minter — wires settle routing
examples/python/clients/erc8004/
  run_ticket_demo.py    # mainnet-fork e2e: real USDC + DAI via whale impersonation
```

## Upstream

Implement in this repo first; propose upgrade to [erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts) separately.

## Testing

```bash
# Solidity (14 tests)
cd contracts/evm
FOUNDRY_PROFILE=erc8004 forge test --match-path "test/erc8004/*"

# Python unit (63 tests in the extension; 1600+ across the repo)
cd python/x402
uv pip install -e .
uv run pytest tests/unit/extensions/erc8004/ -q

# End-to-end against a mainnet fork — real USDC + DAI + canonical IdentityRegistry
uv run python ../../examples/python/clients/erc8004/run_ticket_demo.py
# (override with RPC_URL=<your-mainnet-rpc>)
```

The `erc8004` profile enables `via_ir` for `ReputationRegistryV3` (stack depth with string params).
