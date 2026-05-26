# x402 Facilitator Example

FastAPI-based facilitator service that verifies and settles payments on-chain for the x402 protocol.

## Prerequisites

- Python 3.10+ (install via [pyenv](https://github.com/pyenv/pyenv) or [uv](https://docs.astral.sh/uv/))
- uv package manager (install via [uv installation](https://docs.astral.sh/uv/getting-started/installation/))
- Dedicated EVM facilitator private key with Base Sepolia ETH for transaction fees
- Dedicated SVM facilitator private key with Solana Devnet SOL for transaction fees

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and fill required environment variables:

- `EVM_PRIVATE_KEY` - Ethereum facilitator private key (hex with 0x prefix)
- `SVM_PRIVATE_KEY` - Solana facilitator private key (base58 encoded)
- `PORT` - Server port (optional, defaults to 4022)
- `EVM_RPC_URL` - Custom EVM RPC URL (optional, defaults to Base Sepolia)

**⚠️ Security Note:** The facilitator key is the signer used to settle payments on-chain. Keep it separate from your seller `payTo` wallet and buyer test wallets, and make sure it is funded only for facilitator gas/fees.

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
    },
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      "extra": {
        "feePayer": "..."
      }
    }
  ],
  "extensions": [],
  "signers": {
    "eip155": ["0x..."],
    "solana": ["..."]
  }
}
```

### POST /verify

Verifies a payment payload against requirements before settlement.

Request:

```json
{
  "paymentPayload": {
    "x402Version": 2,
    "resource": {
      "url": "http://localhost:4021/weather",
      "description": "Weather data",
      "mimeType": "application/json"
    },
    "accepted": {
      "scheme": "exact",
      "network": "eip155:84532",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "amount": "1000",
      "payTo": "0x...",
      "maxTimeoutSeconds": 300,
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    },
    "payload": {
      "signature": "0x...",
      "authorization": {}
    }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:84532",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "amount": "1000",
    "payTo": "0x...",
    "maxTimeoutSeconds": 300,
    "extra": {
      "name": "USDC",
      "version": "2"
    }
  }
}
```

Response (success):

```json
{
  "isValid": true,
  "payer": "0x..."
}
```

Response (failure):

```json
{
  "isValid": false,
  "invalidReason": "invalid_signature"
}
```

### POST /settle

Settles a verified payment by broadcasting the transaction on-chain.

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

Response (failure):

```json
{
  "success": false,
  "errorReason": "insufficient_balance",
  "transaction": "",
  "network": "eip155:84532"
}
```

## Extending the Example

### Adding Networks

Register additional schemes for other networks:

```python
from x402 import x402Facilitator
from x402.mechanisms.evm.exact import register_exact_evm_facilitator
from x402.mechanisms.svm.exact import register_exact_svm_facilitator

facilitator = x402Facilitator()

register_exact_evm_facilitator(
    facilitator,
    evm_signer,
    networks="eip155:84532",
)

register_exact_svm_facilitator(
    facilitator,
    svm_signer,
    networks="solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
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
        # Return AbortResult to cancel settlement
        AbortResult(reason="Custom rejection") if should_reject(ctx) else None
    ))
    .on_after_settle(lambda ctx: print(f"Settled: {ctx.result}"))
    .on_settle_failure(lambda ctx: print(f"Settle failed: {ctx.error}"))
)
```

### Custom EVM Signer

Create a custom signer for different providers:

```python
from x402.mechanisms.evm.signer import FacilitatorEvmSigner
from x402.mechanisms.evm.types import TransactionReceipt

class MyCustomSigner:
    """Implement FacilitatorEvmSigner protocol."""

    def get_addresses(self) -> list[str]:
        return ["0x..."]

    def read_contract(self, address, abi, function_name, *args):
        # Your implementation
        pass

    def verify_typed_data(self, address, domain, types, primary_type, message, signature):
        # Your implementation
        pass

    def write_contract(self, address, abi, function_name, *args):
        # Your implementation
        pass

    def send_transaction(self, to, data):
        # Your implementation
        pass

    def wait_for_transaction_receipt(self, tx_hash) -> TransactionReceipt:
        # Your implementation
        pass

    def get_balance(self, address, token_address) -> int:
        # Your implementation
        pass

    def get_chain_id(self) -> int:
        # Your implementation
        pass

    def get_code(self, address) -> bytes:
        # Your implementation
        pass
```

## Network Identifiers

Networks use [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) format:

- `eip155:84532` — Base Sepolia
- `eip155:8453` — Base Mainnet
- `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` — Solana Devnet
- `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` — Solana Mainnet

