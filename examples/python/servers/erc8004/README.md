# ERC-8004 Agent Resource Server

FastAPI agent server with x402 payment middleware, ERC-8004 extension, and
post-settle `X-X402-Interaction-Attestation` headers.

Serves two paid endpoints:

| Route | Token | Settlement |
|-------|-------|------------|
| `GET /agent/usdc` | USDC | EIP-3009 (`exact`) |
| `GET /agent/dai` | DAI | Permit2 (`assetTransferMethod: permit2`) — standard x402 signature; the wrapper settles via `x402ExactPermit2Proxy` then mints |

## Prerequisites

- `bootstrap_fork.py` running (terminal 1)
- Facilitator running on port 4022 (terminal 2)

## Setup

```bash
cd examples/python/servers/erc8004
uv sync
cp .env-local .env   # or use .env written by bootstrap
uv run python main.py   # terminal 3 — port 4021
```

## Environment

| Variable | Description |
|----------|-------------|
| `AGENT_OWNER_PRIVATE_KEY` | Agent owner (signs interaction attestations) |
| `FACILITATOR_URL` | Local facilitator (default `http://127.0.0.1:4022`) |
| `WRAPPER_ADDRESS` | `X402AgentReputation` contract |
| `IDENTITY_REGISTRY` | ERC-8004 IdentityRegistry |
| `AGENT_ID` | Registered agent id |
| `AGENT_ADDRESS` | `pay_to` address (agent owner) |
| `USDC_ADDRESS` / `DAI_ADDRESS` | Mainnet token addresses on the fork |
| `AMOUNT_USDC` / `AMOUNT_DAI` | Payment amounts in atomic units |
| `PORT` | HTTP port (default `4021`) |

## Client

After this server is up, run the client:

```bash
cd examples/python/clients/erc8004
uv run python run_x402_client.py
```
