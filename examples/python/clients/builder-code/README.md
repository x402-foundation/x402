# Builder Code Extension Client Example

Example client for the [builder-code server](../../servers/builder-code/). Makes a paid request and verifies that ERC-8021 builder-code attribution was appended to the settlement transaction calldata.

```python
from x402 import x402Client
from x402.extensions.builder_code import (
    BuilderCodeClientExtension,
    parse_builder_code_suffix_from_calldata,
)
from x402.http.clients import x402HttpxClient

client = x402Client()
register_exact_evm_client(client, EthAccountSigner(account))
client.register_extension(BuilderCodeClientExtension("bc_my_client"))

async with x402HttpxClient(client) as http:
    response = await http.get("http://localhost:4021/weather")
```

## Prerequisites

- Python 3.10+
- uv (install via [docs.astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/))
- Running [builder-code server](../../servers/builder-code/) and [builder-code facilitator](../../facilitator/builder-code/)
- EVM private key funded on Base Sepolia

## Setup

1. Install dependencies:

```bash
uv sync
```

2. Copy `.env-local` to `.env` and set required variables:

```bash
cp .env-local .env
```

Required:

- `EVM_PRIVATE_KEY` — Ethereum private key for EVM payments

Optional:

- `CLIENT_BUILDER_CODE` — Client service builder code (``s``)
- `EVM_RPC_URL` — JSON-RPC endpoint for onchain verification (defaults to Base Sepolia)
- `RESOURCE_SERVER_URL` — Resource server base URL (defaults to `http://localhost:4021`)
- `ENDPOINT_PATH` — Paid endpoint path (defaults to `/weather`)

3. Start the builder-code facilitator and server (in separate terminals):

```bash
# Terminal 1: facilitator
cd ../../facilitator/builder-code
cp .env-local .env
uv sync && uv run python main.py

# Terminal 2: server
cd ../../servers/builder-code
cp .env-local .env
uv sync && uv run python main.py
```

4. Run the client:

```bash
uv run python main.py
```

On success, the client prints the settlement transaction hash and the builder codes parsed from onchain calldata (for example `a` for the service app code, `s` for the client service code, and `w` for the facilitator wallet code).

## Expected Output

```
Making request to: http://localhost:4021/weather

Response body: {"report": {"weather": "sunny", "temperature": 70}}

Payment response: {
  "success": true,
  "transaction": "0x...",
  ...
}

Builder-code attribution verified onchain: BuilderCodeExtensionData(a='bc_weather_svc', w='bc_example_facilitator', s=['bc_my_client'])
Explorer: https://sepolia.basescan.org/tx/0x...
```
