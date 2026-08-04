# ERC-8004 x402 Facilitator

FastAPI facilitator that verifies and settles x402 payments, routing settlement
through `X402AgentReputation.settleAndMintTicket*` when the client echoes
`extensions.erc8004.agentId`.

Part of the three-process ERC-8004 x402 ticket demo. Run **after** bootstrap.

## Prerequisites

- `bootstrap_fork.py` running in another terminal (Anvil mainnet fork)
- Foundry contracts built: `FOUNDRY_PROFILE=erc8004 forge build` in `contracts/evm`

## Setup

```bash
cd examples/python/clients/erc8004
uv sync
uv run python bootstrap_fork.py --write-env   # terminal 1 — leave running

cd ../../facilitator/erc8004
uv sync
cp .env-local .env   # or use .env written by bootstrap
uv run python main.py   # terminal 2 — port 4022
```

## Environment

| Variable | Description |
|----------|-------------|
| `EVM_PRIVATE_KEY` | Facilitator signer (deployer / anvil acct #0 after bootstrap) |
| `EVM_RPC_URL` | Anvil RPC (default `http://127.0.0.1:8545`) |
| `NETWORK` | CAIP-2 network (default `eip155:1`) |
| `WRAPPER_ADDRESS` | Deployed `X402AgentReputation` |
| `PORT` | HTTP port (default `4022`) |

## Endpoints

- `POST /verify` — verify payment
- `POST /settle` — settle on-chain (mints ticket when erc8004 extension active)
- `GET /supported` — supported kinds and extensions
- `GET /health` — health check
