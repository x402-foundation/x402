"""Bind a payment identifier to the HTTP request, not the payment payload.

Fingerprint covers HTTP method, canonical path+query, raw body SHA-256, and
accepted terms (scheme, network, asset, amount, payTo). Same payment ID with a
different fingerprint is a conflict: HTTP 409, grant_access False.

In-flight work is an expiring reservation (fingerprint + timestamp), not a
bare fingerprint. A live reservation is never overwritten. Settled cache TTL
is one hour; reservation TTL is 30 seconds so failed verification cannot leak
or block the ID forever.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, MutableMapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit

HIT = "hit"
CONFLICT = "conflict"
IN_FLIGHT = "in_flight"
MISS = "miss"
EXPIRED = "expired"

CONFLICT_MESSAGE = "payment identifier already used with different request"
IN_FLIGHT_MESSAGE = "payment identifier is already being processed for this request"

# Distinct from the one-hour settled cache TTL used by the example server.
RESERVATION_TTL_SECONDS = 30.0


def canonical_request_url(url: str) -> str:
    parts = urlsplit(url)
    # Sort by key only. Python's sort is stable, matching URLSearchParams.sort():
    # distinct keys are ordered, duplicate-key relative order is preserved.
    pairs = sorted(
        parse_qsl(parts.query, keep_blank_values=True), key=lambda item: item[0]
    )
    query = urlencode(pairs)
    path = parts.path or "/"
    return f"{path}?{query}" if query else path


def body_sha256(body: bytes | bytearray | memoryview | str | None) -> str:
    if body is None:
        data = b""
    elif isinstance(body, str):
        data = body.encode("utf-8")
    else:
        data = bytes(body)
    return hashlib.sha256(data).hexdigest()


def _as_mapping(value: Any) -> Mapping[str, Any]:
    if value is None:
        return {}
    if isinstance(value, Mapping):
        return value
    if hasattr(value, "model_dump"):
        dumped = value.model_dump(by_alias=True)
        if isinstance(dumped, Mapping):
            return dumped
    return {}


def payment_terms(payload: Any) -> dict[str, str]:
    accepted = _as_mapping(_as_mapping(payload).get("accepted"))
    pay_to = accepted.get("payTo", accepted.get("pay_to", ""))
    return {
        "scheme": str(accepted.get("scheme") or ""),
        "network": str(accepted.get("network") or ""),
        "asset": str(accepted.get("asset") or ""),
        "amount": str(accepted.get("amount") or ""),
        "payTo": str(pay_to or ""),
    }


def request_fingerprint(
    *,
    method: str,
    url: str,
    body: bytes | bytearray | memoryview | str | None,
    payload: Any,
) -> str:
    material = {
        "bodySha256": body_sha256(body),
        "method": (method or "").upper(),
        "url": canonical_request_url(url),
        **payment_terms(payload),
    }
    canonical = json.dumps(material, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class CacheDecision:
    kind: str
    status_code: int | None
    grant_access: bool


@dataclass(frozen=True)
class Reservation:
    fingerprint: str
    timestamp: float


def lookup(
    cache: Mapping[str, Any],
    *,
    payment_id: str,
    fingerprint: str,
    now: float,
    ttl_seconds: float,
) -> CacheDecision:
    cached = cache.get(payment_id)
    if cached is None:
        return CacheDecision(MISS, None, False)
    if isinstance(cached, Mapping):
        timestamp = float(cached["timestamp"])
        cached_fp = cached.get("fingerprint")
    else:
        timestamp = float(cached.timestamp)
        cached_fp = getattr(cached, "fingerprint", None)
    if now - timestamp >= ttl_seconds:
        return CacheDecision(EXPIRED, None, False)
    if not cached_fp or cached_fp != fingerprint:
        return CacheDecision(CONFLICT, 409, False)
    return CacheDecision(HIT, 200, True)


def _reservation_parts(value: Any) -> tuple[float, str | None]:
    if isinstance(value, Mapping):
        return float(value["timestamp"]), value.get("fingerprint")
    return float(value.timestamp), getattr(value, "fingerprint", None)


def cleanup_expired_reservations(
    reservations: MutableMapping[str, Any],
    *,
    now: float,
    ttl_seconds: float,
) -> int:
    """Drop expired reservations in one pass over the current map."""
    expired = [
        key
        for key, value in reservations.items()
        if now - _reservation_parts(value)[0] >= ttl_seconds
    ]
    for key in expired:
        del reservations[key]
    return len(expired)


def try_reserve(
    reservations: MutableMapping[str, Any],
    *,
    payment_id: str,
    fingerprint: str,
    now: float,
    ttl_seconds: float,
) -> CacheDecision:
    """Create a reservation or refuse without granting access.

    A live reservation is never overwritten. Same fingerprint is in-flight
    conflict; a different fingerprint is request conflict. Expired entries
    are removed, then a new reservation is stored.
    """
    existing = reservations.get(payment_id)
    if existing is not None:
        timestamp, reserved_fp = _reservation_parts(existing)
        if now - timestamp < ttl_seconds:
            if reserved_fp and reserved_fp == fingerprint:
                return CacheDecision(IN_FLIGHT, 409, False)
            return CacheDecision(CONFLICT, 409, False)
        del reservations[payment_id]
    reservations[payment_id] = Reservation(fingerprint=fingerprint, timestamp=now)
    return CacheDecision(MISS, None, False)


def consume_reservation(
    reservations: MutableMapping[str, Any],
    *,
    payment_id: str,
    now: float,
    ttl_seconds: float,
) -> str | None:
    """Pop a live reservation and return its fingerprint.

    Missing or expired reservations return None and must not be cached.
    """
    existing = reservations.pop(payment_id, None)
    if existing is None:
        return None
    timestamp, fingerprint = _reservation_parts(existing)
    if now - timestamp >= ttl_seconds or not fingerprint:
        return None
    return str(fingerprint)


def bind_payment_id(
    cache: MutableMapping[str, Any],
    reservations: MutableMapping[str, Any],
    *,
    payment_id: str,
    fingerprint: str,
    now: float,
    cache_ttl_seconds: float,
    reservation_ttl_seconds: float,
) -> CacheDecision:
    """Settled cache first, then in-flight reservation. Never grants on reserve."""
    decision = lookup(
        cache,
        payment_id=payment_id,
        fingerprint=fingerprint,
        now=now,
        ttl_seconds=cache_ttl_seconds,
    )
    if decision.kind in (HIT, CONFLICT):
        return decision
    if decision.kind == EXPIRED:
        cache.pop(payment_id, None)
    return try_reserve(
        reservations,
        payment_id=payment_id,
        fingerprint=fingerprint,
        now=now,
        ttl_seconds=reservation_ttl_seconds,
    )
