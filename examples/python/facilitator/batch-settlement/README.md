# x402 Batch-Settlement Facilitator Example

A minimal FastAPI facilitator that verifies and settles **batch-settlement**
EVM payments on Base Sepolia. Pair it with the batch-settlement server and
client examples in this repo.

## Setup

```bash
uv sync
```

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `EVM_PRIVATE_KEY` | yes | Facilitator EVM key (pays gas, submits txs). |
| `EVM_RPC_URL` | no | Defaults to `https://sepolia.base.org`. |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | no | Receiver-authorizer key. Defaults to `EVM_PRIVATE_KEY`. |
| `PORT` | no | Listen port (default `4022`). |

## Run

```bash
uv run uvicorn main:app --port 4022
```

## Endpoints

- `POST /verify`
- `POST /settle`
- `GET  /supported`
- `GET  /health`
