# x402 Batch-Settlement httpx Client Example

An async httpx client that pays for a batch-settlement-protected resource
multiple times in a row. The first request opens an on-chain channel via a
USDC deposit; subsequent requests are served by off-chain vouchers signed
against that same channel. Optionally, the client issues a cooperative refund
at the end to claw back any unused channel balance.

## Setup

```bash
uv sync --reinstall-package x402
```

## Deposit policy

The client deposits `extra.minDeposit` when the server announced a valid hint, otherwise `amount × DEPOSIT_MULTIPLIER` (default `5`, minimum `3`).

`x402Client` spend controls still cap each request's `amount` (default `$1` on USDC). That same atomic cap is the escrow ceiling:

`maxDeposit = maxAmountPerPayment × depositMultiplier`

So the default `$1` cap and multiplier `5` lock at most `$5`. `spend_controls=False` (or any uncapped asset) leaves the deposit uncapped too.

Use `deposit_strategy` only for app-specific decisions:

- **`None`** — use the SDK default (`deposit_amount` in context).
- **`False`** — skip this deposit attempt.
- **Base-unit string or `int`** — custom amount; must be **≥ `minimum_deposit_amount`**, and still respects `max_deposit` when a spend cap is set.

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `RESOURCE_SERVER_URL` | yes | Base URL of the resource server (e.g. `http://localhost:4021`). |
| `EVM_PRIVATE_KEY` | yes | Client (payer) private key. |
| `ENDPOINT_PATH` | no | Path of the protected resource (default `/weather`). |
| `EVM_VOUCHER_SIGNER_PRIVATE_KEY` | no | Dedicated voucher-signing key (`payerAuthorizer`). Defaults to `EVM_PRIVATE_KEY`. |
| `EVM_RPC_URL` | no | EVM JSON-RPC endpoint. Defaults to `https://sepolia.base.org`. |
| `CHANNEL_SALT` | no | 32-byte hex salt for channel ID derivation. Defaults to all-zeros. |
| `DEPOSIT_MULTIPLIER` | no | Deposit target is `amount ×` this multiplier when `extra.minDeposit` is absent; lock ceiling is `spendCap ×` this multiplier (integer **≥ 3**; default `5`). |
| `STORAGE_DIR` | no | Directory for persistent file-backed channel storage. Defaults to in-memory. |
| `NUMBER_OF_REQUESTS` | no | Number of paid requests to issue (default `3`). |
| `REFUND_AFTER_REQUESTS` | no | Set to `true` to issue a cooperative refund at the end. |
| `REFUND_AMOUNT` | no | Base-unit token amount for a partial refund. Omit for a full refund. |

## Run

```bash
uv run python main.py
```
