# x402 httpx Client Example

This example demonstrates how to use the x402 v2 SDK with httpx (async) to make requests to 402-protected endpoints with support for both EVM (Ethereum) and SVM (Solana) payments.

## Setup

1. Copy `.env-local` to `.env` and add your private keys:

```bash
cp .env-local .env
```

2. Install dependencies:

```bash
uv sync
```

## Usage

Run the example:

```bash
uv run python main.py
```

## How it Works

The example demonstrates the complete x402 payment flow:

1. **Create x402 client** - Set up the payment client
2. **Register payment schemes** - Enable EVM and/or SVM payments:
   - `register_exact_evm_client` for Ethereum-based payments
   - `register_exact_svm_client` for Solana-based payments
3. **Make request** - The `x402HttpxClient` automatically handles 402 responses:
   - Intercepts 402 Payment Required responses
   - Creates and signs payment payload
   - Retries request with payment header
   - Returns successful response
4. **Extract payment response** - Decode the settlement confirmation from response headers

## Code Overview

```python
from x402 import x402Client
from x402.http import x402HTTPClient
from x402.http.clients import x402HttpxClient
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client
from x402.mechanisms.svm import KeypairSigner
from x402.mechanisms.svm.exact.register import register_exact_svm_client

# Setup
client = x402Client()

# Register EVM (Ethereum) payments
account = Account.from_key(evm_private_key)
register_exact_evm_client(client, EthAccountSigner(account))

# Register SVM (Solana) payments
svm_signer = KeypairSigner.from_base58(svm_private_key)
register_exact_svm_client(client, svm_signer)

# Make request - payment handling is automatic
async with x402HttpxClient(client) as http:
    response = await http.get(url)

    # Extract payment settlement info
    http_client = x402HTTPClient(client)
    settle_response = http_client.get_payment_settle_response(
        lambda name: response.headers.get(name)
    )
    print(f"Transaction: {settle_response.transaction}")
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `EVM_PRIVATE_KEY` | Your EVM private key (with or without 0x prefix) |
| `SVM_PRIVATE_KEY` | Your Solana private key (base58 encoded) |
| `RESOURCE_SERVER_URL` | Base URL of the x402-protected server |
| `ENDPOINT_PATH` | Path to the protected endpoint |

**Note:** At least one of `EVM_PRIVATE_KEY` or `SVM_PRIVATE_KEY` must be provided.

## Learn More

- [x402 Python SDK](../../../../python/x402/)
- [x402 Protocol](https://x402.org)
