# Advanced Python Client Examples

This directory contains advanced x402 client examples demonstrating hooks, custom selectors, builder patterns, and spend controls across EVM, SVM, and TVM networks.

## Prerequisites

- Python 3.11+
- At least one configured signer:
  - EVM private key with testnet funds (e.g., Base Sepolia)
  - SVM private key with Solana Devnet funds
  - TVM private key with TON testnet funds and testnet USDT
- A running x402 resource server (e.g., the FastAPI example server)

To fund your TVM payer wallet, request testnet TON from [@testgiver_ton_bot](https://t.me/testgiver_ton_bot) for fees. Then open the [testnet USDT transfer link](https://app.tonkeeper.com/transfer/kQDNUDJC0iQvJoZp0ml-YteL1NtTXKphU03CTI5v4VtBhGYs?amount=49000000&bin=te6cckEBAQEAFgAAKClXdJkAAAAAAAAAAAAAAAAAmJaAhDUekg) or scan the QR code below to obtain testnet USDT:
<img width="228" height="228" alt="QR code for the testnet USDT transfer link" src="https://github.com/user-attachments/assets/da09ad03-388d-4960-88bf-afbacf4a7c65" />

## Setup

1. **Install dependencies:**

   ```bash
   cd examples/python/clients/advanced
   uv sync --reinstall-package x402
   ```

2. **Configure environment:**

   ```bash
   cp .env-local .env
   # Edit .env and add one or more signer credentials
   ```

3. **Start a test server** (in another terminal):

   ```bash
   cd examples/python/servers/fastapi
   uv sync --reinstall-package x402 && uv run uvicorn main:app --port 4021
   ```

## Running Examples

Use the CLI to run specific examples:

```bash
# Run a specific example
uv run python all_networks.py
uv run python index.py hooks
uv run python index.py preferred_network
uv run python index.py builder_pattern
uv run python index.py spend_controls

# Run all examples
uv run python index.py all

# List available examples
uv run python index.py --list
```

Or run individual files directly:

```bash
uv run python all_networks.py
uv run python hooks.py
uv run python preferred_network.py
uv run python builder_pattern.py
uv run python spend_controls.py
```

## Examples Overview

### 0. All Networks (`all_networks.py`)

Demonstrates how to add all supported networks with optional chain configuration, including TVM.

### 1. Hooks (`hooks.py`)

Demonstrates payment lifecycle hooks for logging, validation, and error recovery:

- `on_before_payment_creation` - Called before payment creation, can abort
- `on_after_payment_creation` - Called after successful payment
- `on_payment_creation_failure` - Called on failure, can recover

**Use cases:**
- Logging payment events for debugging
- Custom validation before allowing payments
- Metrics and analytics collection
- Error recovery with fallback payloads

### 2. Preferred Network (`preferred_network.py`)

Shows how to implement a custom payment requirements selector:

- Define network preference order (e.g., prefer L2 over L1)
- Automatic fallback to supported alternatives
- Useful for cost optimization or user preferences

**Use cases:**
- Prefer cheaper networks (Base > Ethereum)
- User-configurable network preferences
- Wallet UI with network selection

### 3. Builder Pattern (`builder_pattern.py`)

Demonstrates network-specific scheme registration:

- Different signers for different networks
- Wildcard patterns (`eip155:*`) with specific overrides (`eip155:1`)
- Separate keys for mainnet vs testnet

**Use cases:**
- Production vs development key separation
- Multi-network wallet support
- Network-specific signer configurations

### 4. Spend Controls (`spend_controls.py`)

By default the client caps recognized pegged assets at `$1` and rejects everything else. Use `spend_controls` to raise the cap or opt into non-default tokens.

```python
client = x402Client.from_config(
    x402ClientConfig(
        schemes=[SchemeRegistration(network="eip155:*", client=ExactEvmScheme(signer))],
        spend_controls={
            "max_amount_per_payment": "$1",  # default USD cap on recognized pegged assets
            "allowed_assets": [
                # opt-in non-default with atomic cap
                {"network": "eip155:*", "asset": "0xCustomToken", "max_amount_per_payment": "2000000"},
                # opt-in non-default uncapped
                {"network": "eip155:*", "asset": "0xOtherToken"},
                # override USD cap for a default asset by ticker (or on-chain id)
                {"network": "eip155:*", "asset": "USDC", "max_amount_per_payment": "1000000"},
            ],
        },
    )
)
```

| Control | Purpose |
| --- | --- |
| `max_amount_per_payment` | USD ceiling on recognized pegged assets (default `$1`). Set `False` to remove. |
| `allowed_assets` | Opt-in for non-default tokens. List of `{ network, asset }` with optional atomic `max_amount_per_payment`, or `True` to allow any asset. |
| `spend_controls: False` | Disable all spend controls. Use only for UI-confirmed flows (paywall). |

**Use cases:**

- Bound spend against a malicious 402 or unbounded custom token
- Allow a specific custom token without disabling the USD cap on stables
- Override the cap for one ticker (e.g. PYUSD) without raising it globally

## Project Structure

```
advanced/
├── .env-local              # Environment template
├── README.md               # This file
├── all_networks.py         # Register EVM, SVM, and TVM schemes
├── pyproject.toml          # Dependencies
├── index.py                # CLI entry point
├── hooks.py                # Lifecycle hooks example
├── preferred_network.py    # Custom selector example
├── builder_pattern.py      # Network registration example
└── spend_controls.py       # Spend controls example
```

## Best Practices

1. **Use hooks for observability** - Log payment events for debugging and metrics
2. **Configure network preferences** - Users may prefer specific networks
3. **Separate keys per environment** - Don't use production keys for testing
