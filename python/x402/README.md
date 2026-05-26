# x402 Python SDK

Core implementation of the x402 payment protocol. Provides transport-agnostic client, server, and facilitator components with both async and sync variants.

## Installation

Install the core package with your preferred framework/client:

```bash
# HTTP clients (pick one)
uv add x402[httpx]      # httpx client
uv add x402[requests]   # requests client

# Server frameworks (pick one)
uv add x402[fastapi]    # FastAPI middleware
uv add x402[flask]      # Flask middleware

# Blockchain mechanisms (pick one or more)
uv add x402[evm]        # EVM/Ethereum
uv add x402[svm]        # Solana
uv add x402[tvm]        # TON/TVM

# Multiple extras
uv add x402[fastapi,httpx,evm]

# Everything
uv add x402[all]
```

## Quick Start

### Client (Async)

```python
from x402 import x402Client
from x402.mechanisms.evm.exact import ExactEvmScheme

client = x402Client()
client.register("eip155:*", ExactEvmScheme(signer=my_signer))

# Create payment from 402 response
payload = await client.create_payment_payload(payment_required)
```

### Client (Sync)

```python
from x402 import x402ClientSync
from x402.mechanisms.evm.exact import ExactEvmScheme

client = x402ClientSync()
client.register("eip155:*", ExactEvmScheme(signer=my_signer))

payload = client.create_payment_payload(payment_required)
```

### TVM Client (Async)

```python
import os

from x402 import x402Client
from x402.mechanisms.tvm import (
    TVM_PROVIDER_TONAPI,
    TVM_TESTNET,
    WalletV5R1Config,
    WalletV5R1MnemonicSigner,
)
from x402.mechanisms.tvm.exact import ExactTvmScheme

tvm_config = WalletV5R1Config.from_private_key(
    TVM_TESTNET,
    os.environ["TVM_PRIVATE_KEY"],
)
tvm_config.api_key = os.environ.get("TONCENTER_API_KEY")
# Optional: use TonAPI instead of Toncenter.
# tvm_config.provider = TVM_PROVIDER_TONAPI
# tvm_config.api_key = os.environ.get("TONAPI_API_KEY")
# tvm_config.provider_base_url = os.environ.get("TONAPI_BASE_URL")

client = x402Client()
client.register(TVM_TESTNET, ExactTvmScheme(WalletV5R1MnemonicSigner(tvm_config)))
```

### Server (Async)

```python
from x402 import x402ResourceServer, ResourceConfig
from x402.http import HTTPFacilitatorClient
from x402.mechanisms.evm.exact import ExactEvmServerScheme

facilitator = HTTPFacilitatorClient(url="https://x402.org/facilitator")
server = x402ResourceServer(facilitator)
server.register("eip155:*", ExactEvmServerScheme())
server.initialize()

# Build requirements
config = ResourceConfig(
    scheme="exact",
    network="eip155:8453",
    pay_to="0x...",
    price="$0.01",
)
requirements = server.build_payment_requirements(config)

# Verify payment
result = await server.verify_payment(payload, requirements[0])
```

### Server (Sync)

```python
from x402 import x402ResourceServerSync, ResourceConfig
from x402.http import HTTPFacilitatorClientSync
from x402.mechanisms.evm.exact import ExactEvmServerScheme

facilitator = HTTPFacilitatorClientSync(url="https://x402.org/facilitator")
server = x402ResourceServerSync(facilitator)
server.register("eip155:*", ExactEvmServerScheme())
server.initialize()

result = server.verify_payment(payload, requirements[0])
```

### Facilitator (Async)

```python
from x402 import x402Facilitator
from x402.mechanisms.evm.exact import ExactEvmFacilitatorScheme

facilitator = x402Facilitator()
facilitator.register(
    ["eip155:8453", "eip155:84532"],
    ExactEvmFacilitatorScheme(wallet=wallet),
)

result = await facilitator.verify(payload, requirements)
if result.is_valid:
    settle_result = await facilitator.settle(payload, requirements)
```

### Facilitator (Sync)

```python
from x402 import x402FacilitatorSync
from x402.mechanisms.evm.exact import ExactEvmFacilitatorScheme

facilitator = x402FacilitatorSync()
facilitator.register(
    ["eip155:8453", "eip155:84532"],
    ExactEvmFacilitatorScheme(wallet=wallet),
)

result = facilitator.verify(payload, requirements)
```

## Async vs Sync

Each component has both async and sync variants:

| Async (default) | Sync |
|-----------------|------|
| `x402Client` | `x402ClientSync` |
| `x402ResourceServer` | `x402ResourceServerSync` |
| `x402Facilitator` | `x402FacilitatorSync` |
| `HTTPFacilitatorClient` | `HTTPFacilitatorClientSync` |

Async variants support both sync and async hooks (auto-detected). Sync variants only support sync hooks and raise `TypeError` if async hooks are registered.

### Framework Pairing

| Framework | HTTP Client | Server | Facilitator Client |
|-----------|-------------|--------|-------------------|
| FastAPI | httpx | `x402ResourceServer` | `HTTPFacilitatorClient` |
| Flask | requests | `x402ResourceServerSync` | `HTTPFacilitatorClientSync` |

Mismatched variants raise `TypeError` at runtime.

## Client Configuration

Use `from_config()` for declarative setup:

```python
from x402 import x402Client, x402ClientConfig, SchemeRegistration
from x402 import prefer_network
from x402.mechanisms.evm.exact import ExactEvmScheme
from x402.mechanisms.svm.exact import ExactSvmScheme
from x402.mechanisms.tvm.exact import ExactTvmScheme

config = x402ClientConfig(
    schemes=[
        SchemeRegistration(network="eip155:*", client=ExactEvmScheme(signer)),
        SchemeRegistration(network="solana:*", client=ExactSvmScheme(signer)),
        SchemeRegistration(network="tvm:*", client=ExactTvmScheme(tvm_signer)),
    ],
    policies=[prefer_network("eip155:8453")],
)
client = x402Client.from_config(config)
```

## Policies

Filter or prioritize payment requirements:

```python
from x402 import prefer_network, prefer_scheme, max_amount

client.register_policy(prefer_network("eip155:8453"))
client.register_policy(prefer_scheme("exact"))
client.register_policy(max_amount(1_000_000))  # 1 USDC max
```

## Lifecycle Hooks

### Client Hooks

```python
from x402 import AbortResult, RecoveredPayloadResult

def before_payment(ctx):
    print(f"Creating payment for: {ctx.selected_requirements.network}")
    # Return AbortResult(reason="...") to cancel

def after_payment(ctx):
    print(f"Payment created: {ctx.payment_payload}")

def on_failure(ctx):
    print(f"Payment failed: {ctx.error}")
    # Return RecoveredPayloadResult(payload=...) to recover

client.on_before_payment_creation(before_payment)
client.on_after_payment_creation(after_payment)
client.on_payment_creation_failure(on_failure)
```

### Server Hooks

```python
server.on_before_verify(lambda ctx: print(f"Verifying: {ctx.payload}"))
server.on_after_verify(lambda ctx: print(f"Result: {ctx.result.is_valid}"))
server.on_verify_failure(lambda ctx: print(f"Failed: {ctx.error}"))

server.on_before_settle(lambda ctx: ...)
server.on_after_settle(lambda ctx: ...)
server.on_settle_failure(lambda ctx: ...)
```

### Facilitator Hooks

```python
facilitator.on_before_verify(...)
facilitator.on_after_verify(...)
facilitator.on_verify_failure(...)
facilitator.on_before_settle(...)
facilitator.on_after_settle(...)
facilitator.on_settle_failure(...)
```

## Network Pattern Matching

Register handlers for network families using wildcards:

```python
# All EVM networks
client.register("eip155:*", ExactEvmScheme(signer))

# Specific network (takes precedence)
client.register("eip155:8453", CustomScheme())
```

## HTTP Headers

### V2 Protocol (Current)

| Header | Description |
|--------|-------------|
| `PAYMENT-SIGNATURE` | Base64-encoded payment payload |
| `PAYMENT-REQUIRED` | Base64-encoded payment requirements |
| `PAYMENT-RESPONSE` | Base64-encoded settlement response |

### V1 Protocol (Legacy)

| Header | Description |
|--------|-------------|
| `X-PAYMENT` | Base64-encoded payment payload |
| `X-PAYMENT-RESPONSE` | Base64-encoded settlement response |

## Related Modules

- `x402.http` - HTTP clients, middleware, and facilitator client
- `x402.mechanisms.evm` - EVM/Ethereum implementation
- `x402.mechanisms.svm` - Solana implementation
- `x402.mechanisms.tvm` - TON/TVM implementation
- `x402.extensions` - Protocol extensions (Bazaar discovery)

## Examples

See [examples/python](https://github.com/x402-foundation/x402/tree/main/examples/python).
