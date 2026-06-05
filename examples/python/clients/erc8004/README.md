# ERC-8004 Feedback Extension — Examples

The v2 ticket flow uses a single `X402AgentReputation` wrapper: settlement and ticket mint share one on-chain transaction. Feedback is ticket-gated via `giveFeedbackWithTicket`.

## Ticket demo (mainnet fork, end-to-end)

[`run_ticket_demo.py`](./run_ticket_demo.py):

1. Forks Ethereum mainnet into local Anvil (real USDC + DAI)
2. Registers a fresh agent on the canonical IdentityRegistry
3. Deploys `X402AgentReputation` onto the fork
4. Runs 4 tickets (USDC EIP-3009 × 2, DAI transferFrom × 2) through Path A and Path B feedback

```bash
cd contracts/evm && FOUNDRY_PROFILE=erc8004 forge build
cd ../../python/x402 && uv pip install -e .
uv run python ../../examples/python/clients/erc8004/run_ticket_demo.py
```

On success all four tickets show `consumed=true` and `getLastIndex` returns 4.

## Server example

[`server_example.py`](./server_example.py) shows extension registration and attestation signing at the HTTP layer.

## Production prerequisites

- Agent registered on ERC-8004 `IdentityRegistry`
- Deployed `X402AgentReputation` with facilitator allowlisted
- `ERC8004Config.wrapper_address` set for ticket-gated feedback
