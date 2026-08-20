"""Payment-Identifier Extension Server Example.

Demonstrates how to implement a resource server that supports the payment-identifier
extension for idempotent payment processing.

This server:
1. Advertises payment-identifier extension support in PaymentRequired responses
2. Caches responses keyed by payment ID plus an HTTP request fingerprint
3. Returns cached responses only when the fingerprint matches
4. Returns HTTP 409 without granting access when the same payment ID is reused
   with a different method, path, query, body, or accepted terms
5. Holds an expiring in-flight reservation so concurrent requests cannot
   overwrite the first fingerprint or start a second settlement

Required environment variables:
- EVM_ADDRESS: The EVM address to receive payments
"""

import base64
import binascii
import json
import os
import time
from dataclasses import dataclass
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, Request, Response
from pydantic import BaseModel, ValidationError
from request_binding import (
    CONFLICT_MESSAGE,
    IN_FLIGHT_MESSAGE,
    RESERVATION_TTL_SECONDS,
    Reservation,
    bind_payment_id,
    cleanup_expired_reservations,
    consume_reservation,
    request_fingerprint,
)
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
    fingerprint: str
    response: dict[str, Any]


idempotency_cache: dict[str, CachedResponse] = {}
pending_reservations: dict[str, Reservation] = {}
CACHE_TTL_SECONDS = 60 * 60  # 1 hour


def cleanup_expired_entries() -> None:
    """Clean up expired cache and in-flight reservation entries."""
    now = time.time()
    expired_keys = [
        key
        for key, value in idempotency_cache.items()
        if now - value.timestamp > CACHE_TTL_SECONDS
    ]
    for key in expired_keys:
        del idempotency_cache[key]
    cleanup_expired_reservations(
        pending_reservations,
        now=now,
        ttl_seconds=RESERVATION_TTL_SECONDS,
    )


# App
app = FastAPI()

# x402 Setup
facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL))
server = x402ResourceServer(facilitator)
server.register(EVM_NETWORK, ExactEvmServerScheme())


# Hook after settlement to cache the response with the request fingerprint
async def after_settle(ctx: SettleContext) -> None:
    """Cache the response after successful payment settlement."""
    payment_id = extract_payment_identifier(ctx.payment_payload)
    if not payment_id:
        return
    fingerprint = consume_reservation(
        pending_reservations,
        payment_id=payment_id,
        now=time.time(),
        ttl_seconds=RESERVATION_TTL_SECONDS,
    )
    if not fingerprint:
        return
    print(f"[Idempotency] Caching response for payment ID: {payment_id}")
    idempotency_cache[payment_id] = CachedResponse(
        timestamp=time.time(),
        fingerprint=fingerprint,
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


# Payment middleware is inner. The later HTTP middleware is outermost so it can
# 409 or serve a cache hit before payment verification.
app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)


@app.middleware("http")
async def idempotency_middleware(request: Request, call_next: Any) -> Response:
    """Bind payment IDs to the HTTP request before payment processing."""
    cleanup_expired_entries()

    payment_header = request.headers.get("PAYMENT-SIGNATURE") or request.headers.get(
        "X-Payment"
    )
    if payment_header:
        try:
            payment_data = json.loads(base64.b64decode(payment_header).decode("utf-8"))
            payment_payload = PaymentPayload.model_validate(payment_data)
            payment_id = extract_payment_identifier(payment_payload)

            if payment_id:
                print(f"[Idempotency] Checking payment ID: {payment_id}")
                fingerprint = request_fingerprint(
                    method=request.method,
                    url=str(request.url),
                    body=await request.body(),
                    payload=payment_data,
                )
                decision = bind_payment_id(
                    idempotency_cache,
                    pending_reservations,
                    payment_id=payment_id,
                    fingerprint=fingerprint,
                    now=time.time(),
                    cache_ttl_seconds=CACHE_TTL_SECONDS,
                    reservation_ttl_seconds=RESERVATION_TTL_SECONDS,
                )

                if decision.kind == "conflict":
                    print("[Idempotency] CONFLICT - same ID, different request")
                    return Response(
                        content=json.dumps(
                            {
                                "error": CONFLICT_MESSAGE,
                                "paymentId": payment_id,
                            }
                        ),
                        media_type="application/json",
                        status_code=409,
                    )

                if decision.kind == "in_flight":
                    print("[Idempotency] IN FLIGHT - same ID, request already reserved")
                    return Response(
                        content=json.dumps(
                            {
                                "error": IN_FLIGHT_MESSAGE,
                                "paymentId": payment_id,
                            }
                        ),
                        media_type="application/json",
                        status_code=409,
                    )

                if decision.kind == "hit":
                    cached = idempotency_cache[payment_id]
                    age = time.time() - cached.timestamp
                    print(
                        f"[Idempotency] Cache HIT - returning cached response (age: {int(age)}s)"
                    )
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

                print("[Idempotency] Cache MISS - reserved, proceeding with payment")
        except (
            binascii.Error,
            UnicodeDecodeError,
            json.JSONDecodeError,
            ValidationError,
        ):
            # Invalid payment header format continues through normal payment handling.
            return await call_next(request)

    return await call_next(request)


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
    print("   - In-flight reservation TTL: 30 seconds")
    print("   - Payment ID: optional (required: false)")
    print("\nHow it works:")
    print("   1. Client sends payment with a unique payment ID")
    print("   2. Server caches the response bound to that ID and the HTTP request")
    print("   3. Same ID and same request fingerprint returns the cached response")
    print("   4. Same ID with a different method, path, query, or body returns 409")
    print("   5. A live in-flight reservation is never overwritten")
    print("   6. No duplicate payment processing occurs on a cache hit\n")

    uvicorn.run(app, host="0.0.0.0", port=4022)
