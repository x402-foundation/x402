"""Payment-Identifier Extension Server Example.

Demonstrates how to implement a resource server that supports the payment-identifier
extension for idempotent payment processing.

This server:
1. Advertises payment-identifier extension support in PaymentRequired responses
2. Caches responses keyed by payment ID after settlement
3. Returns cached responses for duplicate payment IDs without re-processing

Required environment variables:
- EVM_ADDRESS: The EVM address to receive payments
"""

import base64
import json
import os
import time
from dataclasses import dataclass
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, Request, Response
from pydantic import BaseModel

from x402.extensions.payment_identifier import (
    PAYMENT_IDENTIFIER,
    declare_payment_identifier_extension,
    extract_payment_identifier,
)
from x402.http import FacilitatorConfig, HTTPFacilitatorClient, PaymentOption
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.http.types import RouteConfig
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.schemas import Network, PaymentPayload, SettleContext
from x402.server import x402ResourceServer

load_dotenv()

# Config
EVM_ADDRESS = os.getenv("EVM_ADDRESS")
EVM_NETWORK: Network = "eip155:84532"  # Base Sepolia
FACILITATOR_URL = os.getenv("FACILITATOR_URL", "https://x402.org/facilitator")

if not EVM_ADDRESS:
    raise ValueError("Missing required EVM_ADDRESS environment variable")


# Response schemas
class WeatherReport(BaseModel):
    weather: str
    temperature: int
    cached: bool


class WeatherResponse(BaseModel):
    report: WeatherReport


# Simple in-memory cache for idempotency
# In production, use Redis or another distributed cache
@dataclass
class CachedResponse:
    timestamp: float
    response: dict[str, Any]


idempotency_cache: dict[str, CachedResponse] = {}
CACHE_TTL_SECONDS = 60 * 60  # 1 hour


def cleanup_expired_entries() -> None:
    """Clean up expired entries from the cache."""
    now = time.time()
    expired_keys = [
        key
        for key, value in idempotency_cache.items()
        if now - value.timestamp > CACHE_TTL_SECONDS
    ]
    for key in expired_keys:
        del idempotency_cache[key]


# App
app = FastAPI()

# x402 Setup
facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL))
server = x402ResourceServer(facilitator)
server.register(EVM_NETWORK, ExactEvmServerScheme())


# Hook after settlement to cache the response
async def after_settle(ctx: SettleContext) -> None:
    """Cache the response after successful payment settlement."""
    payment_id = extract_payment_identifier(ctx.payment_payload)
    if payment_id:
        print(f"[Idempotency] Caching response for payment ID: {payment_id}")
        idempotency_cache[payment_id] = CachedResponse(
            timestamp=time.time(),
            response={
                "report": {
                    "weather": "sunny",
                    "temperature": 70,
                    "cached": False,
                }
            },
        )


server.on_after_settle(after_settle)


# Route configuration with payment-identifier extension advertised
routes = {
    "GET /weather": RouteConfig(
        accepts=[
            PaymentOption(
                scheme="exact",
                price="$0.001",
                network=EVM_NETWORK,
                pay_to=EVM_ADDRESS,
            ),
        ],
        description="Weather data with idempotency support",
        mime_type="application/json",
        # Advertise payment-identifier extension support (required=False means optional)
        extensions={
            PAYMENT_IDENTIFIER: declare_payment_identifier_extension(required=False),
        },
    ),
}


# Custom middleware to check idempotency cache before payment processing
@app.middleware("http")
async def idempotency_middleware(request: Request, call_next: Any) -> Response:
    """Check idempotency cache before payment processing."""
    # Clean up expired entries periodically
    cleanup_expired_entries()

    # Only check for payment header on protected routes
    payment_header = request.headers.get("X-Payment")
    if payment_header and request.url.path == "/weather":
        try:
            # Decode payment header to extract payment ID
            payment_data = json.loads(base64.b64decode(payment_header).decode("utf-8"))
            payment_payload = PaymentPayload.model_validate(payment_data)
            payment_id = extract_payment_identifier(payment_payload)

            if payment_id:
                print(f"[Idempotency] Checking payment ID: {payment_id}")
                cached = idempotency_cache.get(payment_id)

                if cached:
                    age = time.time() - cached.timestamp
                    if age < CACHE_TTL_SECONDS:
                        print(
                            f"[Idempotency] Cache HIT - returning cached response (age: {int(age)}s)"
                        )
                        # Return cached response with cached flag set to true
                        cached_response = {
                            "report": {
                                **cached.response["report"],
                                "cached": True,
                            }
                        }
                        return Response(
                            content=json.dumps(cached_response),
                            media_type="application/json",
                            status_code=200,
                        )
                    else:
                        print("[Idempotency] Cache EXPIRED - proceeding with payment")
                        del idempotency_cache[payment_id]
                else:
                    print("[Idempotency] Cache MISS - proceeding with payment")
        except Exception:
            # Invalid payment header format, continue to normal flow
            pass

    return await call_next(request)


# Add payment middleware after idempotency middleware
app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)


# Routes
@app.get("/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/weather")
async def get_weather() -> WeatherResponse:
    """Return weather data. Response may be cached based on payment ID."""
    return WeatherResponse(
        report=WeatherReport(
            weather="sunny",
            temperature=70,
            cached=False,
        )
    )


if __name__ == "__main__":
    import uvicorn

    print("\nPayment-Identifier Example Server")
    print("   Listening at http://localhost:4022")
    print("\nIdempotency Configuration:")
    print("   - Cache TTL: 1 hour")
    print("   - Payment ID: optional (required: false)")
    print("\nHow it works:")
    print("   1. Client sends payment with a unique payment ID")
    print("   2. Server caches the response keyed by payment ID")
    print("   3. If same payment ID is seen within 1 hour, cached response is returned")
    print("   4. No duplicate payment processing occurs\n")

    uvicorn.run(app, host="0.0.0.0", port=4022)
