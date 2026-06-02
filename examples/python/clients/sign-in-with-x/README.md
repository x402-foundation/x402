# Sign-In-With-X (SIWX) Client Example

httpx client demonstrating both SIWX flows supported by x402:
- Auth-only access for routes that require a wallet signature but no payment
- Paid-once access where SIWX proves a wallet has already paid

```python
from eth_account import Account

from x402 import x402Client
from x402.extensions.sign_in_with_x import (
    CreateSIWxClientExtensionOptions,
    create_siwx_client_extension,
)
from x402.http import x402HTTPClient
from x402.http.clients import x402HttpxClient
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client
from x402.mechanisms.svm.signers import KeypairSigner

client = x402Client()
account = Account.from_key(evm_private_key)
register_exact_evm_client(client, EthAccountSigner(account))

# SIWX works with both EVM (eip191) and Solana (ed25519) signers
client.register_extension(
    create_siwx_client_extension(CreateSIWxClientExtensionOptions(signers=[account]))
)

http_client = x402HTTPClient(client)

async with x402HttpxClient(client) as http:
    # Auth-only route: 402 challenge -> sign -> retry, no payment
    profile = await http.get("http://localhost:4021/profile")

    # Paid route: first request pays for access
    weather1 = await http.get("http://localhost:4021/weather")

    # Paid route: second request uses SIWX to prove prior payment
    weather2 = await http.get("http://localhost:4021/weather")
```

## How It Works

1. **Auth-only route** — Client receives a SIWX challenge, signs it, and retries without payment
2. **Paid route, first request** — Client pays for resource access
3. **Server remembers** — Payment is recorded against wallet address
4. **Paid route, later request** — Client signs SIWX message proving wallet ownership instead of paying again

The `x402HttpxClient` handles the full 402 → sign/pay → retry cycle automatically. The SIWX client extension intercepts auth-only and repeat-access challenges and attaches the `sign-in-with-x` header on retry.

## Prerequisites

- Python 3.10+
- [uv](https://docs.astral.sh/uv/) package manager
- At least one private key (EVM or SVM) for payments and SIWX authentication
- Running SIWX server (see [server example](../../servers/sign-in-with-x/))

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and provide at least one private key:

- `EVM_PRIVATE_KEY` — (Optional) Ethereum private key for EVM payments and SIWX authentication
- `SVM_PRIVATE_KEY` — (Optional) Solana private key (base58) for SVM payments and SIWX authentication
- `RESOURCE_SERVER_URL` — (Optional) Server URL (defaults to `http://localhost:4021`)

**Note:** At least one private key (EVM or SVM) is required. The `/profile` auth-only example and the paid `/weather` and `/joke` routes all work with either signer type.

2. Install dependencies:

```bash
uv sync
```

3. Start the SIWX server:

```bash
cd ../../servers/sign-in-with-x
uv sync
uv run python main.py
```

4. Run the client:

```bash
cd ../../clients/sign-in-with-x
uv run python main.py
```

## Expected Output

```
Client EVM address: 0x...
Client SVM address: ...
Server: http://localhost:4021

--- /profile (auth-only, no payment) ---
   ✓ Authenticated via SIWX (no payment required)
   Response: {'address': '0x...', 'data': 'Your profile data'}

--- /weather ---
1. First request...
   ✓ Paid via payment settlement
   Payment response:
   {
     "success": true,
     "transaction": "0x...",
     "network": "eip155:84532",
     ...
   }
   Response: {'weather': 'sunny', 'temperature': 72}
2. Second request...
   ✓ Authenticated via SIWX (previously paid)
   Response: {'weather': 'sunny', 'temperature': 72}

--- /joke ---
1. First request...
   ✓ Paid via payment settlement
   ...
2. Second request...
   ✓ Authenticated via SIWX (previously paid)
   ...

Done. /profile used auth-only SIWX. /weather and /joke used payment + SIWX.
```

## Code Overview

The example registers payment schemes and the SIWX client extension, then exercises three routes:

```python
signers = []
client = x402Client()

if EVM_PRIVATE_KEY:
    account = Account.from_key(EVM_PRIVATE_KEY)
    register_exact_evm_client(client, EthAccountSigner(account))
    signers.append(account)

if SVM_PRIVATE_KEY:
    svm_signer = KeypairSigner.from_base58(SVM_PRIVATE_KEY)
    register_exact_svm_client(client, svm_signer)
    signers.append(svm_signer)

client.register_extension(
    create_siwx_client_extension(CreateSIWxClientExtensionOptions(signers=signers))
)

async with x402HttpxClient(client) as http:
    await demonstrate_auth_only(http)
    await demonstrate_resource(http, http_client, "/weather")
    await demonstrate_resource(http, http_client, "/joke")
```

Payment settlement details are extracted from response headers via `x402HTTPClient.get_payment_settle_response()`. On the second request to a paid route, no payment header is present — the client authenticated with SIWX instead.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `EVM_PRIVATE_KEY` | Your EVM private key (with or without `0x` prefix) |
| `SVM_PRIVATE_KEY` | Your Solana private key (base58 encoded) |
| `RESOURCE_SERVER_URL` | Base URL of the SIWX server (default: `http://localhost:4021`) |

**Note:** At least one of `EVM_PRIVATE_KEY` or `SVM_PRIVATE_KEY` must be provided.

## Learn More

- [x402 Python SDK](../../../../python/x402/)
- [SIWX extension](../../../../python/x402/extensions/sign_in_with_x/)
- [TypeScript client example](../../../typescript/clients/sign-in-with-x/)
