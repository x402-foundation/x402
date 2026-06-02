# ERC-8004 Feedback Extension — Examples

Two flavors of the extension live side by side:

- **Ticket flow** (`run_ticket_demo.py`) — settlement and ticket mint share one
  on-chain transaction via `TicketMinter`. Feedback is ticket-gated through
  `ReputationRegistryV3.giveFeedbackWithTicket`. **This is the path Phase 2–4
  added; it's the supported flow going forward.** See [Ticket demo](#ticket-demo-anvil-end-to-end) below.

- **Gateway-less baseline** (`main.py`, `run_on_*.py`) — original flow that
  posts feedback via the canonical ERC-8004 `ReputationRegistry.giveFeedback`
  on a chain where the registries are already deployed (e.g. mainnet, fork).
  Note: that on-chain function is disabled in `ReputationRegistryV3`
  (`LegacyGiveFeedbackDisabled`); the baseline demo only works against the
  legacy canonical `ReputationRegistry` deployment.

## Ticket demo (Anvil, end-to-end)

[`run_ticket_demo.py`](./run_ticket_demo.py) is a one-command demo that:

1. spins up a local Anvil,
2. deploys `MockERC20` + `MockERC3009Token` (USDC-style) +
   `MockIdentityRegistry` + `TicketMinter` + `ReputationRegistryV3` from the
   Foundry build artifacts,
3. wires the minter (facilitator allowlist + registry reference) and registers
   one agent,
4. mints both tokens to the payer,
5. exercises **two settlement modes**, each with both feedback paths:

   **Scenario 1 — plain ERC-20 (`settleAndMintTicket` / `transferFrom`):**

   - Ticket #1 — payer approves the minter, facilitator calls
     `TicketMinter.settleAndMintTicket` (one tx: `transferFrom` + ticket mint),
     payer submits `giveFeedbackWithTicket` (Path A, direct).
   - Ticket #2 — same settle + mint, payer signs an EIP-712 `FeedbackIntent`,
     a relayer EOA broadcasts `giveFeedbackWithTicketFor(...)` (Path B,
     sponsored — payer pays no gas for the feedback step).

   **Scenario 2 — USDC-style EIP-3009 (`settleAndMintTicketEIP3009` /
   `transferWithAuthorization`):**

   - Ticket #3 — payer signs an EIP-3009 `TransferWithAuthorization`
     (no on-chain approval needed); facilitator calls
     `TicketMinter.settleAndMintTicketEIP3009` (one tx: token-level
     `transferWithAuthorization` + ticket mint); payer submits
     `giveFeedbackWithTicket` (Path A).
   - Ticket #4 — same EIP-3009 settle + mint, sponsored feedback (Path B).

### Run

```bash
# One-time: build contracts + install SDK
cd contracts/evm && FOUNDRY_PROFILE=erc8004 forge build
cd ../../python/x402 && uv pip install -e .

# Run the demo
uv run python ../../examples/python/clients/erc8004/run_ticket_demo.py
```

On success you'll see all four tickets transition `MINTED → CONSUMED` and the
registry's `getLastIndex(agentId, payer)` increment to 4:

```
DONE — both scenarios, both feedback paths green.
  Scenario 1 (ERC-20 transferFrom):
    ticket #1: MINTED -> CONSUMED  (Path A direct)
    ticket #2: MINTED -> CONSUMED  (Path B sponsored)
  Scenario 2 (USDC EIP-3009):
    ticket #3: MINTED -> CONSUMED  (Path A direct)
    ticket #4: MINTED -> CONSUMED  (Path B sponsored)
  ReputationRegistryV3.getLastIndex(agentId=7, payer) = 4
```

No external services required — no Pinata, no real chain. The demo focuses on
the on-chain ticket lifecycle; the off-chain artifact pipeline (IPFS upload,
canonical hashing) is covered by the gateway-less demo below.

## Gateway-less baseline (legacy)

The original example that submits feedback via `ReputationRegistry.giveFeedback`
on a chain with the canonical ERC-8004 contracts already deployed. The binding
between the payment and the feedback lives in an off-chain canonical artifact
(uploaded to IPFS) and is committed on-chain via `feedbackHash` / `feedbackURI`.

### How the gateway-less baseline works

1. Client pays for the resource via the normal x402 flow → gets a settlement `txHash`.
2. (Optional) Server signs an `InteractionReceipt` over `{settlement, request, response}`
   digests and returns it in the `X-X402-Interaction-Receipt` header.
3. Client builds a canonical artifact `{settlement, interaction, feedback}`, hashes it
   into `feedbackHash`, and uploads it to IPFS → `feedbackURI` (`ipfs://<CID>`).
4. Client calls `ReputationRegistry.giveFeedback(...)` directly (plain type-2 tx);
   `msg.sender` is the payer, so attribution is correct without any gateway.
5. Anyone can verify off-chain: fetch `feedbackURI`, check the hash, confirm the
   ERC-20 `Transfer` in `txHash`, check `ownerOf(agentId)`, and (if present) the
   agent receipt → a `TrustTier`.

## Run the full end-to-end demo (real IPFS + on-chain on Anvil)

[`main.py`](./main.py) is a complete, runnable demo: it starts a local Anvil,
performs a real settlement transfer, signs a real agent receipt, uploads the
artifact to **real IPFS via Pinata**, and submits `giveFeedback` **on-chain**.

### Requirements

- **Foundry** (`anvil` on your `PATH`) — https://book.getfoundry.sh/getting-started/installation
- **uv** — https://docs.astral.sh/uv/
- A **Pinata JWT** with file-upload scope, placed in the repo-root `.env`:

  ```dotenv
  # x402/.env
  PINATA_JWT=eyJhbGciOi...
  ```

  (Get one at https://app.pinata.cloud → API Keys.)

### Run

One-time setup — install the SDK into the project venv (editable):

```bash
cd python/x402
uv pip install -e .
```

Then run the demo:

```bash
uv run python ../../examples/python/clients/erc8004/main.py
```

On success you'll see the real IPFS CID and the decoded on-chain feedback
transaction, ending in `verify_feedback -> FULL`:

```
CID:          bafkrei...
feedbackURI:  ipfs://bafkrei...
===== on-chain feedback transaction (Anvil) =====
  txHash:        0x...
  status:        1 (block 5)
  from (client): 0xf39Fd6...
  to (registry): 0x...
  giveFeedback.feedbackURI:  ipfs://bafkrei...
  giveFeedback.feedbackHash: 0x...
verify_feedback -> FULL
SUCCESS — feedback posted on-chain, artifact at ipfs://bafkrei...
```

Open the printed `https://<CID>.ipfs.inbrowser.link/` link to inspect the
uploaded artifact (real settlement `txHash` + real agent signature).

The same flow also runs as an integration test:
[`python/x402/tests/integration/test_erc8004_pinata_e2e.py`](../../../../python/x402/tests/integration/test_erc8004_pinata_e2e.py)

```bash
cd python/x402
uv run pytest tests/integration/test_erc8004_pinata_e2e.py -v -s -m integration
```

> The demo deploys three tiny mock contracts on the local Anvil (an ERC-20-style
> token, an `IdentityRegistry`, and a calldata-logging `ReputationRegistry`) so
> no Solidity compiler is needed. Against a real chain you'd point
> `ERC8004Config` at the deployed ERC-8004 registries instead.

## Using the API in your own code

- **Client** — the runnable demo above ([`main.py`](./main.py)) shows the full
  client flow: build + publish the artifact, then submit feedback. In your app
  the `requirements` / `payment_payload` / settlement `txHash` come from the
  normal x402 payment round-trip instead of a local mock.
- **Server** — declare `agentId` and sign the interaction receipt at the HTTP
  layer: [`server_example.py`](./server_example.py)

```bash
pip install x402[evm]   # or: uv add x402[evm]
```

## Production prerequisites

- An agent registered on the ERC-8004 `IdentityRegistry` (you control
  `ownerOf(agentId)`).
- The `ReputationRegistry` / `IdentityRegistry` addresses for your chain, set in
  `ERC8004Config`.
- A funded client EOA (pays gas for `giveFeedback`).
- A `PINATA_JWT` (or any `ArtifactUploader`; prefer content-addressed IPFS/Arweave).
