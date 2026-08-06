# x402 Batch-Settlement FastAPI Server Example

A FastAPI server that exposes a single usage-based-priced `/weather` endpoint
protected by the **batch-settlement** EVM scheme on Base Sepolia.

Clients first open an on-chain payment channel via a USDC deposit. Subsequent
requests are billed off-chain by signed vouchers, which the server's async
`BatchSettlementChannelManager` periodically claims/settles on-chain in
batches. Idle channels are cooperatively refunded after 3 minutes.

This FastAPI example uses `HTTPFacilitatorClient` with `create_channel_manager`.
For Flask or other sync servers, use `HTTPFacilitatorClientSync` with
`create_channel_manager_sync` (`BatchSettlementChannelManagerSync`).

## Setup

```bash
uv sync
```

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `EVM_ADDRESS` | yes | Receiver/payee address (checksum hex). |
| `FACILITATOR_URL` | yes | URL of a batch-settlement-aware facilitator. |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | no | Local receiver-authorizer key. Defaults to the facilitator. |
| `STORAGE_DIR` | no | Directory to persist channel state across restarts. |
| `DEFERRED_WITHDRAW_DELAY_SECONDS` | no | Channel withdraw delay (default 86400). |
| `PORT` | no | Listen port (default 4021). |

## Run

```bash
uv run python main.py
```

## Endpoints

- `GET /weather` — protected; usage-based-priced at a random 1–100% of `$0.01`.
- `GET /health` — unprotected.
