# x402 Python v2 Client Examples

This directory contains examples demonstrating how to use the x402 v2 SDK with different Python HTTP clients.

## Available Examples

| Directory | HTTP Client | Pattern |
|-----------|-------------|---------|
| [httpx/](./httpx/) | httpx | Async |
| [requests/](./requests/) | requests | Sync |

## Quick Start

1. Choose an HTTP client (httpx for async, requests for sync)
2. Navigate to the example directory
3. Follow the setup instructions in the README

### httpx (Async)

```bash
cd httpx
cp .env-local .env
# Edit .env with your EVM_PRIVATE_KEY and/or SVM_PRIVATE_KEY
uv sync
uv run python main.py
```

### requests (Sync)

```bash
cd requests
cp .env-local .env
# Edit .env with your EVM_PRIVATE_KEY and/or SVM_PRIVATE_KEY
uv sync
uv run python main.py
```

## Features Demonstrated

- **Automatic 402 handling** - Payment handling is transparent to your code
- **EVM payments** - Uses `EthAccountSigner` with `register_exact_evm_client`
- **Payment response extraction** - Shows how to decode settlement confirmations
- **Environment validation** - Checks for required configuration

## Architecture

Both examples follow the same pattern:

```python
from x402 import x402Client
from x402.mechanisms.evm.exact.register import register_exact_evm_client
from x402.mechanisms.evm.signers import EthAccountSigner

# 1. Create account
account = Account.from_key(private_key)

# 2. Create x402 client
client = x402Client()

# 3. Register EVM payment scheme
register_exact_evm_client(client, EthAccountSigner(account))

# 4. Use with your preferred HTTP client
# ... httpx or requests ...
```

## Learn More

- [x402 Python SDK](../../../python/x402/)
- [Legacy examples](../legacy/clients/) - Examples using the legacy API
- [x402 Protocol](https://x402.org)
