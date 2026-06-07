# ERC-8004 Feedback Extension — Examples

The v2 ticket flow uses a single `X402AgentReputation` wrapper: settlement and
ticket mint share one on-chain transaction. Feedback is ticket-gated via
`giveFeedbackWithTicket`.

## Demos

### On-chain only (`run_ticket_demo.py`)

Direct contract calls — no HTTP. Four tickets (USDC × 2, DAI × 2), Path A + B.

```bash
cd contracts/evm && FOUNDRY_PROFILE=erc8004 forge build
cd ../../python/x402 && uv pip install -e .
uv run python ../../examples/python/clients/erc8004/run_ticket_demo.py
```

### x402 HTTP flow (facilitator + agent server + client)

Three standalone processes over the same mainnet fork:

1. **Bootstrap** (terminal 1) — starts Anvil, deploys contracts, writes `.env`
2. **Facilitator** (terminal 2) — `examples/python/facilitator/erc8004`
3. **Agent server** (terminal 3) — `examples/python/servers/erc8004`
4. **Client** (terminal 4) — `run_x402_client.py`

```bash
# Once: build contracts
cd contracts/evm && FOUNDRY_PROFILE=erc8004 forge build

# Terminal 1 — leave running
cd examples/python/clients/erc8004
uv sync
uv run python bootstrap_fork.py --write-env

# Terminal 2
cd examples/python/facilitator/erc8004
uv sync && uv run python main.py

# Terminal 3
cd examples/python/servers/erc8004
uv sync && uv run python main.py

# Terminal 4
cd examples/python/clients/erc8004
uv run python run_x402_client.py
```

On success:

- **USDC** ticket minted via x402 HTTP (EIP-3009) → Path A feedback + attestation
- **DAI** ticket minted via `settleAndMintTicket` (transferFrom) → Path B sponsored feedback
- USDC response includes verified `X-X402-Interaction-Attestation`
- Both tickets `consumed=true`, `getLastIndex == 2`

The agent server exposes `GET /agent/dai` (Permit2) for when the SDK gains
TicketWitness Permit2 signing. Until then, the client mints the DAI ticket with
the same transferFrom path as `run_ticket_demo.py` (see README note in
`run_x402_client.py`).

## Other files

- [`server_example.py`](./server_example.py) — extension registration snippet
- [`utils.py`](./utils.py) — shared fork helpers (registration, whale funding, Permit2)

## Production prerequisites

- Agent registered on ERC-8004 `IdentityRegistry`
- Deployed `X402AgentReputation` with facilitator allowlisted
- `ERC8004Config.wrapper_address` set for ticket-gated feedback
