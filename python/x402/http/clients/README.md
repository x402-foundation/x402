# x402 HTTP Clients

HTTP client wrappers with automatic 402 payment handling.

## httpx (Async)

```bash
uv add x402[httpx]
```

### Transport Wrapper

```python
from x402 import x402Client
from x402.http.clients import x402_httpx_transport
from x402.mechanisms.evm.exact import ExactEvmScheme
import httpx

client = x402Client()
client.register("eip155:*", ExactEvmScheme(signer=signer))

async with httpx.AsyncClient(
    transport=x402_httpx_transport(client)
) as http:
    response = await http.get("https://api.example.com/paid")
```

### Convenience Wrapper

```python
from x402.http.clients import wrapHttpxWithPayment

async with wrapHttpxWithPayment(client) as http:
    response = await http.get("https://api.example.com/paid")
```

### From Config

```python
from x402 import x402ClientConfig, SchemeRegistration
from x402.http.clients import wrapHttpxWithPaymentFromConfig

config = x402ClientConfig(
    schemes=[
        SchemeRegistration(
            network="eip155:*",
            client=ExactEvmScheme(signer=signer),
        ),
    ],
)

async with wrapHttpxWithPaymentFromConfig(config) as http:
    response = await http.get("https://api.example.com/paid")
```

### Client Class

```python
from x402.http.clients import x402HttpxClient

async with x402HttpxClient(client) as http:
    response = await http.get("https://api.example.com/paid")
```

## requests (Sync)

```bash
uv add x402[requests]
```

### Session Wrapper

```python
from x402 import x402ClientSync
from x402.http.clients import wrapRequestsWithPayment
from x402.mechanisms.evm.exact import ExactEvmScheme
import requests

client = x402ClientSync()
client.register("eip155:*", ExactEvmScheme(signer=signer))

session = wrapRequestsWithPayment(requests.Session(), client)
response = session.get("https://api.example.com/paid")
```

### HTTP Adapter

```python
from x402.http.clients import x402_http_adapter
import requests

session = requests.Session()
adapter = x402_http_adapter(client)
session.mount("https://", adapter)
session.mount("http://", adapter)

response = session.get("https://api.example.com/paid")
```

### Convenience Function

```python
from x402.http.clients import x402_requests

session = x402_requests(client)
response = session.get("https://api.example.com/paid")
```

### From Config

```python
from x402.http.clients import wrapRequestsWithPaymentFromConfig

session = wrapRequestsWithPaymentFromConfig(requests.Session(), config)
```

## Sync/Async Matching

| HTTP Client | x402 Client |
|-------------|-------------|
| httpx (async) | `x402Client` (async) |
| requests (sync) | `x402ClientSync` (sync) |

Using mismatched variants raises `TypeError`.

## Exports

### httpx

| Export | Description |
|--------|-------------|
| `x402_httpx_transport()` | Create async transport |
| `wrapHttpxWithPayment()` | Wrap existing client |
| `wrapHttpxWithPaymentFromConfig()` | Create from config |
| `x402HttpxClient` | Convenience client class |

### requests

| Export | Description |
|--------|-------------|
| `x402_http_adapter()` | Create HTTP adapter |
| `wrapRequestsWithPayment()` | Wrap session |
| `wrapRequestsWithPaymentFromConfig()` | Create from config |
| `x402_requests()` | Create new session with payment |

