# ERC-8004 Feedback Extension — Examples

The ticket flow is the supported path: settlement and ticket mint share one
on-chain transaction via `TicketMinter`. Feedback is ticket-gated through
`ReputationRegistryV3.giveFeedbackWithTicket`.

## Ticket demo (mainnet fork, end-to-end)

[`run_ticket_demo.py`](./run_ticket_demo.py) is a one-command demo that:

1. forks Ethereum **mainnet** (real USDC + DAI, no mocks) into a local Anvil
   subprocess — the fork is ephemeral, nothing touches the real chain,
2. impersonates known whales to fund a fresh payer EOA with **real USDC and
   real DAI**,
3. registers a fresh agent on the **canonical mainnet ERC-8004
   `IdentityRegistry`** (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`); the
   resulting `agentId` is whatever the live registry assigns,
4. deploys `TicketMinter` + `ReputationRegistryV3` onto the fork
   (`ReputationRegistryV3` references the canonical IdentityRegistry directly),
5. wires the minter (facilitator allowlist + registry reference),
6. exercises each token's natural settlement mode, both with both feedback paths:

   **Scenario 1 — USDC via EIP-3009 (`settleAndMintTicketEIP3009`):**

   - Ticket #1 — payer signs an EIP-3009 `TransferWithAuthorization` (no
     on-chain approval needed); facilitator calls
     `TicketMinter.settleAndMintTicketEIP3009` (one tx: real-USDC
     `transferWithAuthorization` + ticket mint); payer submits
     `giveFeedbackWithTicket` (Path A, direct).
   - Ticket #2 — same EIP-3009 settle + mint, sponsored feedback: payer signs
     an EIP-712 `FeedbackIntent`, a relayer EOA broadcasts
     `giveFeedbackWithTicketFor(...)` (Path B — payer pays no gas for the
     feedback step).

   **Scenario 2 — DAI via `transferFrom` (`settleAndMintTicket`):**
   DAI doesn't expose `transferWithAuthorization`, so the payer approves the
   minter and the facilitator pulls the DAI via `transferFrom`.

   - Ticket #3 — `transferFrom` + ticket mint in one tx, then Path A direct
     feedback.
   - Ticket #4 — same settle + mint, Path B sponsored feedback.

### Run

```bash
# One-time: build contracts + install SDK
cd contracts/evm && FOUNDRY_PROFILE=erc8004 forge build
cd ../../python/x402 && uv pip install -e .

# Run the demo. RPC_URL defaults to a public mainnet RPC (auto-fallback
# across a couple of free ones); override with a private RPC if you hit
# rate limits.
uv run python ../../examples/python/clients/erc8004/run_ticket_demo.py
# or
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/<your-key> \
  uv run python ../../examples/python/clients/erc8004/run_ticket_demo.py
```

On success you'll see all four tickets transition `MINTED → CONSUMED`, the
agent receive 2 USDC + 2 DAI from the real on-chain token contracts, and the
registry's `getLastIndex(agentId, payer)` increment to 4:

```
DONE — both scenarios, both feedback paths green.
  Scenario 1 (USDC EIP-3009):
    ticket #1: MINTED -> CONSUMED  (Path A direct)
    ticket #2: MINTED -> CONSUMED  (Path B sponsored)
  Scenario 2 (DAI transferFrom):
    ticket #3: MINTED -> CONSUMED  (Path A direct)
    ticket #4: MINTED -> CONSUMED  (Path B sponsored)
  agent received: USDC 2000000 (2.0 USDC), DAI 2000000000000000000 (2.0 DAI)
  ReputationRegistryV3.getLastIndex(agentId=<live-assigned-id>, payer) = 4
```

(The `agentId` is whatever the live canonical IdentityRegistry assigns at
register-time — e.g. ~34,000+ on current mainnet — so it'll differ from run
to run.)

No external services required. The demo focuses on the on-chain ticket
lifecycle.

## Server-side example

[`server_example.py`](./server_example.py) shows how a resource server
declares its `agentId` in the 402 response and signs an `InteractionReceipt`
at the HTTP layer.

```bash
pip install x402[evm]   # or: uv add x402[evm]
```

## Production prerequisites

- An agent registered on the ERC-8004 `IdentityRegistry` (you control
  `ownerOf(agentId)`).
- A deployed `ReputationRegistryV3` + `TicketMinter` and their addresses set
  in `ERC8004Config`.
- A funded client EOA (pays gas for the feedback tx — unless using the
  sponsored Path B).
