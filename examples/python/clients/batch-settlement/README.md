# x402 Batch-Settlement httpx Client Example

An async httpx client that pays for a batch-settlement-protected resource
multiple times in a row. The first request opens an on-chain channel via a
USDC deposit; subsequent requests are served by off-chain vouchers signed
against that same channel. Optionally, the client issues a cooperative refund
at the end to claw back any unused channel balance.

## Setup

```bash
uv sync
```

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `RESOURCE_SERVER_URL` | yes | Base URL of the resource server (e.g. `http://localhost:4021`). |
| `EVM_PRIVATE_KEY` | yes | Client (payer) private key. |
| `ENDPOINT_PATH` | no | Path of the protected resource (default `/weather`). |
| `EVM_VOUCHER_SIGNER_PRIVATE_KEY` | no | Dedicated voucher-signing key (`payerAuthorizer`). Defaults to `EVM_PRIVATE_KEY`. |
| `EVM_RPC_URL` | no | EVM JSON-RPC endpoint. Defaults to `https://sepolia.base.org`. |
| `CHANNEL_SALT` | no | 32-byte hex salt for channel ID derivation. Defaults to all-zeros. |
| `DEPOSIT_MULTIPLIER` | no | Deposit = multiplier × request price (default `5`). |
| `STORAGE_DIR` | no | Directory for persistent file-backed channel storage. Defaults to in-memory. |
| `NUMBER_OF_REQUESTS` | no | Number of paid requests to issue (default `3`). |
| `REFUND_AFTER_REQUESTS` | no | Set to `true` to issue a cooperative refund at the end. |
| `REFUND_AMOUNT` | no | Base-unit token amount for a partial refund. Omit for a full refund. |

## Run

```bash
uv run python main.py
```
