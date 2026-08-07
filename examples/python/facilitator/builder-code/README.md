# Builder Code Facilitator Example

FastAPI-based facilitator that verifies and settles payments and appends ERC-8021 wallet attribution (`w`) at settlement via `BuilderCodeFacilitatorExtension`.

## Prerequisites

- Python 3.10+ (install via [pyenv](https://github.com/pyenv/pyenv) or [uv](https://docs.astral.sh/uv/))
- uv package manager (install via [uv installation](https://docs.astral.sh/uv/getting-started/installation/))
- Dedicated EVM facilitator private key with Base Sepolia ETH for transaction fees

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and fill required environment variables:

- `EVM_PRIVATE_KEY` — Base Sepolia facilitator private key
- `FACILITATOR_BUILDER_CODE` — Facilitator wallet builder code (e.g. `bc_example_facilitator`)
- `PORT` — Server port (optional, defaults to 4022)
- `EVM_RPC_URL` — Custom EVM RPC URL (optional, defaults to Base Sepolia)

**Security note:** The facilitator key is the signer used to settle payments onchain. Keep it separate from your seller `payTo` wallet and buyer test wallets, and make sure it is funded only for facilitator gas/fees.

2. Install dependencies:

```bash
uv sync
```

3. Run the server:

```bash
uv run python main.py
```

Or with uvicorn directly:

```bash
uv run uvicorn main:app --port 4022
```

## API Endpoints

### GET /supported

Returns payment schemes and networks this facilitator supports.

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:84532"
    }
  ],
  "extensions": [],
  "signers": {
    "eip155": ["0x..."]
  }
}
```

### POST /verify

Verifies a payment payload against requirements before settlement.

Request:

```json
{
  "paymentPayload": { "...": "..." },
  "paymentRequirements": { "...": "..." }
}
```

Response (success):

```json
{
  "isValid": true,
  "payer": "0x..."
}
```

### POST /settle

Settles a verified payment by broadcasting the transaction onchain. When configured, the facilitator appends its wallet builder code (`w`) to the settlement calldata via ERC-8021 Schema 2.

Request body is identical to `/verify`.

Response (success):

```json
{
  "success": true,
  "transaction": "0x...",
  "network": "eip155:84532",
  "payer": "0x..."
}
```

## Extending the Example

### Adding Networks

Register additional schemes for other networks:

```python
from x402.mechanisms.evm.exact import register_exact_evm_facilitator

register_exact_evm_facilitator(
    facilitator,
    evm_signer,
    networks="eip155:84532",
)
```

### Lifecycle Hooks

Add custom logic before/after verify and settle operations:

```python
from x402 import x402Facilitator
from x402.schemas import AbortResult

facilitator = (
    x402Facilitator()
    .on_before_verify(lambda ctx: print(f"Verifying: {ctx.payment_payload}"))
    .on_after_verify(lambda ctx: print(f"Verified: {ctx.result}"))
    .on_verify_failure(lambda ctx: print(f"Verify failed: {ctx.error}"))
    .on_before_settle(lambda ctx: (
        AbortResult(reason="Custom rejection") if should_reject(ctx) else None
    ))
    .on_after_settle(lambda ctx: print(f"Settled: {ctx.result}"))
    .on_settle_failure(lambda ctx: print(f"Settle failed: {ctx.error}"))
    .register_extension(
        BuilderCodeFacilitatorExtension(builder_code="bc_my_facilitator")
    )
)
```

## Network Identifiers

Networks use [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) format:

- `eip155:84532` — Base Sepolia
- `eip155:8453` — Base Mainnet

## Testing with the Server and Client

Use this facilitator with the [builder-code server](../../servers/builder-code/) and [builder-code client](../../clients/builder-code/) examples. Set `FACILITATOR_URL=http://localhost:4022` in the server `.env` so settlement includes wallet attribution.
