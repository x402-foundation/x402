# ERC-8004 Feedback Extension — Examples

The v2 ticket flow uses a single `X402AgentReputation` wrapper: settlement and
ticket mint share one on-chain transaction. Feedback is ticket-gated via
`giveFeedbackWithTicket`.

## Demo

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
- **DAI** ticket minted via x402 HTTP (Permit2) → Path B sponsored feedback
- Both responses include a verified `X-X402-Interaction-Attestation`
- Both tickets `consumed=true`, `getLastIndex == 2`

Both endpoints are paid entirely over x402 HTTP. DAI settles with a **standard**
x402 Permit2 signature (spender = canonical `x402ExactPermit2Proxy`, witness =
`Witness(to, validAfter)`): `X402AgentReputation.settleAndMintTicketPermit2`
delegates to `x402ExactPermit2Proxy.settle()` and then mints the ticket atomically
in the same transaction. Both Permit2 and the canonical `x402ExactPermit2Proxy`
are already deployed on mainnet, so the fork inherits them — no deploy needed. The
payer approves Permit2 for DAI once before the run (USDC uses EIP-3009, no approval).

## Other files

- [`server_example.py`](./server_example.py) — extension registration snippet
- [`utils.py`](./utils.py) — shared fork helpers (registration, whale funding, Permit2)

## Production prerequisites

- Agent registered on ERC-8004 `IdentityRegistry`
- Deployed `X402AgentReputation` with facilitator allowlisted
- `ERC8004Config.wrapper_address` set for ticket-gated feedback
