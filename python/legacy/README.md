# x402 Python

> **Deprecated (v1)**  
> The code in `python/legacy` implements x402 **v1**. It is **deprecated** and will only receive **security patches**. Please migrate to **v2** on PyPI: use the `x402` package at version **> 2.0.0** (imports and APIs change). See the [Migration guide: v1 to v2](https://docs.x402.org/guides/migration-v1-to-v2).
> Legacy examples are available at git tag `archive/legacy-v1-examples`.

Python package for the x402 payments protocol.

## Installation

```bash
pip install x402
```

## Overview

The x402 package provides the core building blocks for implementing the x402 Payment Protocol in Python. It's designed to be used by:

- FastAPI middleware for accepting payments
- Flask middleware for accepting payments
- httpx client for paying resources
- requests client for paying resources

## FastAPI Integration

The simplest way to add x402 payment protection to your FastAPI application:

```py
from fastapi import FastAPI
from x402.fastapi.middleware import require_payment

app = FastAPI()
app.middleware("http")(
    require_payment(price="0.01", pay_to_address="0x209693Bc6afc0C5328bA36FaF03C514EF312287C")
)

@app.get("/")
async def root():
    return {"message": "Hello World"}
```

To protect specific routes:

```py
app.middleware("http")(
    require_payment(price="0.01",
    pay_to_address="0x209693Bc6afc0C5328bA36FaF03C514EF312287C"),
    path="/foo"  # <-- this can also be a list ex: ["/foo", "/bar"]
)
```

## Flask Integration

The simplest way to add x402 payment protection to your Flask application:

```py
from flask import Flask
from x402.flask.middleware import PaymentMiddleware

app = Flask(__name__)

# Initialize payment middleware
payment_middleware = PaymentMiddleware(app)

# Add payment protection for all routes
payment_middleware.add(
    price="$0.01",
    pay_to_address="0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
)

@app.route("/")
def root():
    return {"message": "Hello World"}
```

To protect specific routes:

```py
# Protect specific endpoint
payment_middleware.add(
    path="/foo",
    price="$0.001",
    pay_to_address="0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
)
```

## Client Integration

### Simple Usage

#### Httpx Client
```py
from eth_account import Account
from x402.clients.httpx import x402HttpxClient

# Initialize account
account = Account.from_key("your_private_key")

# Create client and make request
async with x402HttpxClient(account=account, base_url="https://api.example.com") as client:
    response = await client.get("/protected-endpoint")
    print(await response.aread())
```

#### Requests Session Client
```py
from eth_account import Account
from x402.clients.requests import x402_requests

# Initialize account
account = Account.from_key("your_private_key")

# Create session and make request
session = x402_requests(account)
response = session.get("https://api.example.com/protected-endpoint")
print(response.content)
```

### Advanced Usage

#### Httpx Extensible Example
```py
import httpx
from eth_account import Account
from x402.clients.httpx import x402_payment_hooks

# Initialize account
account = Account.from_key("your_private_key")

# Create httpx client with x402 payment hooks
async with httpx.AsyncClient(base_url="https://api.example.com") as client:
    # Add payment hooks directly to client
    client.event_hooks = x402_payment_hooks(account)

    # Make request - payment handling is automatic
    response = await client.get("/protected-endpoint")
    print(await response.aread())
```

#### Requests Session Extensible Example
```py
import requests
from eth_account import Account
from x402.clients.requests import x402_http_adapter

# Initialize account
account = Account.from_key("your_private_key")

# Create session and mount the x402 adapter
session = requests.Session()
adapter = x402_http_adapter(account)

# Mount the adapter for both HTTP and HTTPS
session.mount("http://", adapter)
session.mount("https://", adapter)

# Make request - payment handling is automatic
response = session.get("https://api.example.com/protected-endpoint")
print(response.content)
```

## Manual Server Integration

If you're not using the FastAPI middleware, you can implement the x402 protocol manually. Here's what you'll need to handle:

1. Return 402 error responses with the appropriate response body
2. Use the facilitator to validate payments
3. Use the facilitator to settle payments
4. Return the appropriate response header to the caller

Here's an example of manual integration:

```py
import base64
import json
from typing import Annotated
from fastapi import FastAPI, Request, Response, JSONResponse
from x402.types import PaymentRequiredResponse, PaymentRequirements, PaymentPayload
from x402.encoding import safe_base64_decode
from x402.facilitator import FacilitatorClient

payment_requirements = PaymentRequirements(...)
facilitator = FacilitatorClient(facilitator_url)

@app.get("/foo")
async def foo(request: Request, response: Response):
    payment_required = PaymentRequiredResponse(
        x402_version=1,
        accepts=[payment_requirements],
        error="",
    )
    payment_header = request.headers.get("X-PAYMENT", "")

    if payment_header == "":
        payment_required.error = "X-PAYMENT header not set"
        return JSONResponse(
            content=payment_required.model_dump(by_alias=True),
            status_code=402,
        )

    payment = PaymentPayload(**json.loads(safe_base64_decode(payment_header)))

    verify_response = await facilitator.verify(payment, payment_requirements)
    if not verify_response.is_valid:
        payment_required.error = "Invalid payment"
        return JSONResponse(
            content=payment_required.model_dump(by_alias=True),
            status_code=402,
        )

    settle_response = await facilitator.settle(payment, payment_requirements)
    if settle_response.success:
        response.headers["X-PAYMENT-RESPONSE"] = base64.b64encode(
            settle_response.model_dump_json().encode("utf-8")
        ).decode("utf-8")
        return {"message": "Payment successful"}
    else:
        payment_required.error = "Settle failed: " + settle_response.error
        return JSONResponse(
            content=payment_required.model_dump(by_alias=True),
            status_code=402,
        )
```

For more examples and advanced usage patterns, check out our [examples directory](https://github.com/x402-foundation/x402/tree/main/examples/python/legacy/).
