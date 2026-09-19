"""Payment-Identifier Extension Server Example.

Demonstrates how to implement a resource server that supports the payment-identifier
extension for idempotent payment processing.

This server:
1. Advertises payment-identifier extension support in PaymentRequired responses
2. Caches responses keyed by payment ID plus an HTTP request and credential fingerprint
3. Returns cached responses only when the fingerprint matches
4. Returns HTTP 409 without granting access when the same payment ID is reused
   with a different method, path, query, body, accepted terms, extra, timeout, or credential
5. Holds an expiring in-flight reservation so concurrent requests cannot
   overwrite the first fingerprint or start a second settlement
6. Reserves only the protected paid route (GET /weather), never /health or
   unmatched paths
7. Releases a pending reservation on pre-settlement rejection. Thrown settle
   errors keep a tokenized tombstone until the server-owned TTL expires.

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
from x402.extensions.payment_identifier import (
    PAYMENT_IDENTIFIER,
    declare_payment_identifier_extension,
    extract_payment_identifier,
)
from x402.http import FacilitatorConfig, HTTPFacilitatorClient, PaymentOption
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.http.types import RouteConfig
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.schemas import AbortResult, Network, PaymentPayload, SettleContext
from x402.server import x402ResourceServer

from request_binding import (
    CAPACITY_MESSAGE,
    CONFLICT_MESSAGE,
    IN_FLIGHT_MESSAGE,
    RESERVATION_TTL_SECONDS,
    RETRY_AFTER_SECONDS,
    RETRYABLE_STATUS_CODE,
    Reservation,
    bind_payment_id,
    cleanup_expired_reservations,
    consume_reservation,
    is_protected_route,
    mark_outcome_unknown,
    mark_settlement_started,
    release_if_pending,
    request_fingerprint,
    reservation_token_from_transport,
    reservation_ttl_seconds,
)

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
        ttl_seconds=reservation_ttl_seconds(),
    )


# App
app = FastAPI()

# x402 Setup
facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL))
server = x402ResourceServer(facilitator)
server.register(EVM_NETWORK, ExactEvmServerScheme())


def _hook_http_identity(ctx: Any) -> tuple[str, str]:
    transport = getattr(ctx, "transport_context", None)
    request = getattr(transport, "request", None)
    adapter = getattr(request, "adapter", None) if request is not None else None
    method = getattr(request, "method", "") or ""
    url = getattr(request, "path", "") or ""
    if adapter is not None:
        method = adapter.get_method() or method
        url = adapter.get_url() or url
    return method, url


def _hook_reservation_token(ctx: Any) -> str | None:
    return reservation_token_from_transport(getattr(ctx, "transport_context", None))


def _hook_fingerprint(ctx: Any) -> str:
    method, url = _hook_http_identity(ctx)
    return request_fingerprint(
        method=method,
        url=url,
        body=b"",
        payload=ctx.payment_payload,
    )


def _hook_payment_id(ctx: Any) -> str | None:
    return extract_payment_identifier(ctx.payment_payload)


# Hook after settlement to cache the response with the request fingerprint
async def after_settle(ctx: SettleContext) -> None:
    """Cache only when this request's matching reservation is consumed."""
    payment_id = _hook_payment_id(ctx)
    if not payment_id:
        return
    fingerprint = consume_reservation(
        pending_reservations,
        payment_id=payment_id,
        fingerprint=_hook_fingerprint(ctx),
        now=time.time(),
        ttl_seconds=reservation_ttl_seconds(),
        token=_hook_reservation_token(ctx),
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


async def before_settle(ctx: Any) -> AbortResult | None:
    """Track the transition into settlement for this tokenized reservation."""
    payment_id = _hook_payment_id(ctx)
    if not payment_id:
        return
    started = mark_settlement_started(
        pending_reservations,
        payment_id=payment_id,
        fingerprint=_hook_fingerprint(ctx),
        now=time.time(),
        ttl_seconds=reservation_ttl_seconds(),
        token=_hook_reservation_token(ctx),
    )
    if not started:
        return AbortResult(reason="payment_identifier_reservation_lost")
    return None


async def retain_unknown_on_settle_failure(ctx: Any) -> None:
    """Retain a tombstone: Python settle-failure conflates result and throw."""
    payment_id = _hook_payment_id(ctx)
    if not payment_id:
        return
    mark_outcome_unknown(
        pending_reservations,
        payment_id=payment_id,
        fingerprint=_hook_fingerprint(ctx),
        now=time.time(),
        ttl_seconds=reservation_ttl_seconds(),
        token=_hook_reservation_token(ctx),
    )


async def release_pending_reservation(ctx: Any) -> None:
    """Drop only this request's pending reservation on pre-settlement failure."""
    payment_id = _hook_payment_id(ctx)
    if not payment_id:
        return
    release_if_pending(
        pending_reservations,
        payment_id=payment_id,
        fingerprint=_hook_fingerprint(ctx),
        now=time.time(),
        ttl_seconds=reservation_ttl_seconds(),
        token=_hook_reservation_token(ctx),
    )


server.on_before_settle(before_settle)
server.on_after_settle(after_settle)
server.on_verify_failure(release_pending_reservation)
server.on_settle_failure(retain_unknown_on_settle_failure)
server.on_verified_payment_canceled(release_pending_reservation)


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

    def storage_unavailable() -> Response:
        return Response(
            content=json.dumps(
                {
                    "error": "payment identifier storage unavailable",
                    "retryable": True,
                }
            ),
            media_type="application/json",
            status_code=RETRYABLE_STATUS_CODE,
            headers={"Retry-After": str(RETRY_AFTER_SECONDS)},
        )

    payment_header = request.headers.get("PAYMENT-SIGNATURE") or request.headers.get(
        "X-Payment"
    )
    reserved_token: str | None = None
    reserved_payment_id: str | None = None
    reserved_fingerprint: str | None = None
    if not payment_header:
        return await call_next(request)

    try:
        payment_data = json.loads(base64.b64decode(payment_header).decode("utf-8"))
        payment_payload = PaymentPayload.model_validate(payment_data)
    except (
        binascii.Error,
        UnicodeDecodeError,
        json.JSONDecodeError,
        ValidationError,
    ):
        # Only malformed header decoding may continue normal payment handling.
        return await call_next(request)

    payment_id = extract_payment_identifier(payment_payload)
    if not payment_id:
        return await call_next(request)
    if not is_protected_route(request.method, str(request.url), routes):
        return await call_next(request)

    try:
        cleanup_expired_entries()
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
            reservation_ttl_seconds=reservation_ttl_seconds(),
        )

        if decision.kind == "hit":
            cached = idempotency_cache[payment_id]
        else:
            cached = None
        if decision.kind == "miss":
            reserved = pending_reservations[payment_id]
            if not reserved.token:
                raise RuntimeError("reservation missing token after bind")
        else:
            reserved = None
    except Exception:  # noqa: BLE001 - storage boundary must fail closed
        return storage_unavailable()

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
        print("[Idempotency] IN FLIGHT - retryable, request already reserved")
        return Response(
            content=json.dumps(
                {
                    "error": IN_FLIGHT_MESSAGE,
                    "paymentId": payment_id,
                    "retryable": True,
                }
            ),
            media_type="application/json",
            status_code=RETRYABLE_STATUS_CODE,
            headers={"Retry-After": str(RETRY_AFTER_SECONDS)},
        )

    if decision.kind == "capacity":
        print("[Idempotency] CAPACITY - retryable, reservation map is full")
        return Response(
            content=json.dumps(
                {
                    "error": CAPACITY_MESSAGE,
                    "paymentId": payment_id,
                    "retryable": True,
                }
            ),
            media_type="application/json",
            status_code=RETRYABLE_STATUS_CODE,
            headers={"Retry-After": str(RETRY_AFTER_SECONDS)},
        )

    if decision.kind == "hit" and cached is not None:
        age = time.time() - cached.timestamp
        print(f"[Idempotency] Cache HIT - returning cached response (age: {int(age)}s)")
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

    if reserved is None:
        return storage_unavailable()
    request.state.x402_reservation_token = reserved.token
    reserved_token = reserved.token
    reserved_payment_id = payment_id
    reserved_fingerprint = fingerprint
    print("[Idempotency] Cache MISS - reserved, proceeding with payment")

    response = await call_next(request)
    if reserved_payment_id and reserved_token and reserved_fingerprint:
        release_if_pending(
            pending_reservations,
            payment_id=reserved_payment_id,
            fingerprint=reserved_fingerprint,
            now=time.time(),
            ttl_seconds=reservation_ttl_seconds(),
            token=reserved_token,
        )
    return response


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
    print(
        "   - In-flight reservation TTL: "
        f"{int(RESERVATION_TTL_SECONDS)}s server-owned (not client maxTimeoutSeconds)"
    )
    print("   - Pending map bound: 1024 entries, fail closed at capacity")
    print("   - Payment ID: optional (required: false)")
    print("   - Scope: GET-only, single-process in-memory example")
    print("\nHow it works:")
    print("   1. Client sends payment with a unique payment ID")
    print(
        "   2. Server caches the response bound to that ID, HTTP request, and credential"
    )
    print(
        "   3. Same ID and same request+credential fingerprint returns the cached response"
    )
    print(
        "   4. Same ID with a different method, path, query, body, extra, timeout, or credential returns 409"
    )
    print(
        "   5. In-flight and capacity responses are HTTP 503 retryable, not 409 conflict"
    )
    print("   6. Reservations are created only for GET /weather")
    print(
        "   7. Pre-settlement rejection releases the matching reservation; thrown settle errors keep a tokenized tombstone until TTL"
    )
    print("   8. A settle failure is not immediately safe to retry")
    print(
        "   9. Replay the exact encoded payment header; do not create a new signature"
    )
    print("  10. No duplicate payment processing occurs on a cache hit\n")

    uvicorn.run(app, host="0.0.0.0", port=4022)
