"""Bind a payment identifier to the HTTP request and settled credential.

Fingerprint covers HTTP method, canonical path+query, raw body SHA-256,
accepted terms (scheme, network, asset, amount, payTo, maxTimeoutSeconds,
recursively canonical extra), and SHA-256 of the scheme-specific credential
(`payload.payload`). Same payment ID with a different fingerprint is a
conflict: HTTP 409, grant_access False.

A payload-only hash and a request-only hash are both insufficient: a stolen
payment ID plus a fabricated credential must not replay a cached paid response.

Reserve only for protected paid routes. Unpaid paths, including /health and
unmatched routes, must not create reservations.

In-flight work is an expiring reservation (fingerprint + timestamp + token +
state). Reservation lifetime and capacity are server policy: TTL is always
RESERVATION_TTL_SECONDS (300s). Client accepted.maxTimeoutSeconds is
fingerprinted, never used as map TTL. The pending map is bounded to
MAX_PENDING_RESERVATIONS after expired cleanup.

Consume, release, mark-unknown, and any other mutation require the exact
supplied token. Missing token is never fingerprint-only ownership.

Query encoding is RFC 3986: unreserved characters stay literal, spaces are
%20, pairs are stably sorted by decoded key.

This example is GET-only, single-process, and does not capture POST bodies.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from collections.abc import Mapping, MutableMapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, quote, urlsplit

HIT = "hit"
CONFLICT = "conflict"
IN_FLIGHT = "in_flight"
CAPACITY = "capacity"
MISS = "miss"
EXPIRED = "expired"

PENDING = "pending"
SETTLING = "settling"
UNKNOWN = "unknown"

CONFLICT_MESSAGE = "payment identifier already used with different request"
IN_FLIGHT_MESSAGE = "payment identifier is already being processed for this request"
CAPACITY_MESSAGE = "payment identifier reservation map is at capacity"

CONFLICT_STATUS_CODE = 409
RETRYABLE_STATUS_CODE = 503
RETRY_AFTER_SECONDS = 1

# Server-owned in-flight TTL. Client maxTimeoutSeconds does not choose map TTL.
RESERVATION_TTL_SECONDS = 300.0
FALLBACK_RESERVATION_TTL_SECONDS = RESERVATION_TTL_SECONDS
MAX_PENDING_RESERVATIONS = 1024

# RFC 3986 unreserved: ALPHA / DIGIT / "-" / "." / "_" / "~"
_RFC3986_UNRESERVED = "-._~"


def canonical_json(value: Any) -> str:
    """Canonical JSON with recursively sorted object keys."""
    return json.dumps(value, separators=(",", ":"), sort_keys=True, ensure_ascii=False)


def rfc3986_encode(value: str) -> str:
    """Percent-encode one query component per RFC 3986.

    Unreserved characters stay literal. Space becomes ``%20``. ``~`` is not
    encoded.
    """
    return quote(value, safe=_RFC3986_UNRESERVED, encoding="utf-8")


def canonical_request_url(url: str) -> str:
    """Canonical path and query using RFC 3986 encoding.

    Pairs are decoded, stably sorted by decoded key (duplicate-key order
    preserved), and re-encoded. Spaces become ``%20``.
    """
    parts = urlsplit(url)
    pairs = list(parse_qsl(parts.query, keep_blank_values=True, encoding="utf-8"))
    pairs.sort(key=lambda item: item[0])
    query = "&".join(
        f"{rfc3986_encode(key)}={rfc3986_encode(value)}" for key, value in pairs
    )
    path = parts.path or "/"
    return f"{path}?{query}" if query else path


def request_path(url: str) -> str:
    """Path only, no query and no URL-dot-dot collapse."""
    return urlsplit(url).path or "/"


def is_protected_route(method: str, url: str, routes: Mapping[str, Any]) -> bool:
    """True when method+path is an exact paid route table key (e.g. 'GET /weather')."""
    key = f"{(method or '').upper()} {request_path(url)}"
    return key in routes


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


def canonical_max_timeout_seconds(accepted: Any) -> str:
    terms = _as_mapping(accepted)
    raw = terms.get("maxTimeoutSeconds", terms.get("max_timeout_seconds"))
    if raw is None:
        return ""
    return str(raw)


def canonical_accepted_extra(accepted: Any) -> str:
    extra = _as_mapping(accepted).get("extra")
    if extra is None:
        return "{}"
    return canonical_json(extra)


def payment_terms(payload: Any) -> dict[str, str]:
    accepted = _as_mapping(_as_mapping(payload).get("accepted"))
    pay_to = accepted.get("payTo", accepted.get("pay_to", ""))
    return {
        "scheme": str(accepted.get("scheme") or ""),
        "network": str(accepted.get("network") or ""),
        "asset": str(accepted.get("asset") or ""),
        "amount": str(accepted.get("amount") or ""),
        "payTo": str(pay_to or ""),
        "maxTimeoutSeconds": canonical_max_timeout_seconds(accepted),
        "extra": canonical_accepted_extra(accepted),
    }


def credential_sha256(payload: Any) -> str:
    """SHA-256 of canonical JSON for payload.payload (signature / authorization)."""
    credential = _as_mapping(payload).get("payload")
    if credential is None:
        canonical = ""
    else:
        canonical = canonical_json(credential)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def reservation_ttl_seconds(*_args: Any, **_kwargs: Any) -> float:
    """Server-owned reservation TTL. Ignores client maxTimeoutSeconds."""
    return RESERVATION_TTL_SECONDS


def request_fingerprint(
    *,
    method: str,
    url: str,
    body: bytes | bytearray | memoryview | str | None,
    payload: Any,
) -> str:
    material = {
        "bodySha256": body_sha256(body),
        "credentialSha256": credential_sha256(payload),
        "method": (method or "").upper(),
        "url": canonical_request_url(url),
        **payment_terms(payload),
    }
    canonical = json.dumps(
        material, separators=(",", ":"), sort_keys=True, ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class CacheDecision:
    kind: str
    status_code: int | None
    grant_access: bool


@dataclass
class Reservation:
    fingerprint: str
    timestamp: float
    token: str = ""
    ttl_seconds: float = RESERVATION_TTL_SECONDS
    state: str = PENDING


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
        return CacheDecision(CONFLICT, CONFLICT_STATUS_CODE, False)
    return CacheDecision(HIT, 200, True)


def _reservation_parts(
    value: Any,
) -> tuple[float, str | None, str, float, str]:
    if isinstance(value, Mapping):
        ttl = value.get("ttl_seconds", value.get("ttlSeconds", RESERVATION_TTL_SECONDS))
        return (
            float(value["timestamp"]),
            value.get("fingerprint"),
            str(value.get("token") or ""),
            float(ttl if ttl is not None else RESERVATION_TTL_SECONDS),
            str(value.get("state") or PENDING),
        )
    ttl = getattr(
        value,
        "ttl_seconds",
        getattr(value, "ttlSeconds", RESERVATION_TTL_SECONDS),
    )
    return (
        float(value.timestamp),
        getattr(value, "fingerprint", None),
        str(getattr(value, "token", "") or ""),
        float(ttl if ttl is not None else RESERVATION_TTL_SECONDS),
        str(getattr(value, "state", PENDING) or PENDING),
    )


def _live_limit(stored_ttl: float, ttl_seconds: float) -> float:
    return stored_ttl if stored_ttl > 0 else ttl_seconds


def _is_live(
    timestamp: float, stored_ttl: float, now: float, ttl_seconds: float
) -> bool:
    return now - timestamp < _live_limit(stored_ttl, ttl_seconds)


def _owns_reservation(
    reserved_fp: str | None,
    reserved_token: str,
    *,
    fingerprint: str,
    token: str | None,
) -> bool:
    if not token or not reserved_token:
        return False
    if not reserved_fp or reserved_fp != fingerprint:
        return False
    return reserved_token == token


def cleanup_expired_reservations(
    reservations: MutableMapping[str, Any],
    *,
    now: float,
    ttl_seconds: float = RESERVATION_TTL_SECONDS,
) -> int:
    """Drop expired reservations in one pass over the current map."""
    expired = []
    for key, value in reservations.items():
        timestamp, _fp, _token, stored_ttl, _state = _reservation_parts(value)
        if not _is_live(timestamp, stored_ttl, now, ttl_seconds):
            expired.append(key)
    for key in expired:
        del reservations[key]
    return len(expired)


def try_reserve(
    reservations: MutableMapping[str, Any],
    *,
    payment_id: str,
    fingerprint: str,
    now: float,
    ttl_seconds: float = RESERVATION_TTL_SECONDS,
    token: str | None = None,
    max_pending: int = MAX_PENDING_RESERVATIONS,
) -> CacheDecision:
    """Create a reservation or refuse without granting access.

    A live reservation is never overwritten. Same fingerprint is retryable
    in-flight; a different fingerprint is request conflict. After expired
    cleanup, a full map fails closed with capacity and does not enter
    verify/settle.
    """
    cleanup_expired_reservations(reservations, now=now, ttl_seconds=ttl_seconds)
    existing = reservations.get(payment_id)
    if existing is not None:
        timestamp, reserved_fp, _reserved_token, stored_ttl, _state = (
            _reservation_parts(existing)
        )
        if _is_live(timestamp, stored_ttl, now, ttl_seconds):
            if reserved_fp and reserved_fp == fingerprint:
                return CacheDecision(IN_FLIGHT, RETRYABLE_STATUS_CODE, False)
            return CacheDecision(CONFLICT, CONFLICT_STATUS_CODE, False)
        del reservations[payment_id]
    if len(reservations) >= max_pending:
        return CacheDecision(CAPACITY, RETRYABLE_STATUS_CODE, False)
    reservations[payment_id] = Reservation(
        fingerprint=fingerprint,
        timestamp=now,
        token=token or secrets.token_hex(16),
        ttl_seconds=ttl_seconds,
        state=PENDING,
    )
    return CacheDecision(MISS, None, False)


def consume_reservation(
    reservations: MutableMapping[str, Any],
    *,
    payment_id: str,
    fingerprint: str,
    now: float,
    ttl_seconds: float = RESERVATION_TTL_SECONDS,
    token: str | None = None,
) -> str | None:
    """Pop the matching current reservation and return its fingerprint.

    Outcome-unknown tombstones are retained. Missing token is never ownership.
    """
    existing = reservations.get(payment_id)
    if existing is None:
        return None
    _timestamp, reserved_fp, reserved_token, _stored_ttl, state = _reservation_parts(
        existing
    )
    if not _owns_reservation(
        reserved_fp, reserved_token, fingerprint=fingerprint, token=token
    ):
        return None
    if state == UNKNOWN:
        return None
    if not reserved_fp:
        return None
    # An exact current token may finish after its phase deadline if cleanup has
    # not replaced it. A replacement has a different token and fails ownership.
    del reservations[payment_id]
    return str(reserved_fp)


def release_reservation(
    reservations: MutableMapping[str, Any],
    *,
    payment_id: str,
    fingerprint: str,
    now: float,
    ttl_seconds: float = RESERVATION_TTL_SECONDS,
    token: str | None = None,
) -> bool:
    """Drop a matching pending or settling reservation. Unknown tombstones stay."""
    existing = reservations.get(payment_id)
    if existing is None:
        return False
    timestamp, reserved_fp, reserved_token, stored_ttl, state = _reservation_parts(
        existing
    )
    if not _owns_reservation(
        reserved_fp, reserved_token, fingerprint=fingerprint, token=token
    ):
        return False
    if state == UNKNOWN:
        return False
    if not _is_live(timestamp, stored_ttl, now, ttl_seconds):
        return False
    del reservations[payment_id]
    return True


def release_if_pending(
    reservations: MutableMapping[str, Any],
    *,
    payment_id: str,
    fingerprint: str,
    now: float,
    ttl_seconds: float = RESERVATION_TTL_SECONDS,
    token: str | None = None,
) -> bool:
    """Release only a pending pre-settlement reservation owned by this token."""
    existing = reservations.get(payment_id)
    if existing is None:
        return False
    _timestamp, _fp, _tok, _ttl, state = _reservation_parts(existing)
    if state != PENDING:
        return False
    return release_reservation(
        reservations,
        payment_id=payment_id,
        fingerprint=fingerprint,
        now=now,
        ttl_seconds=ttl_seconds,
        token=token,
    )


def mark_settlement_started(
    reservations: MutableMapping[str, Any],
    *,
    payment_id: str,
    fingerprint: str,
    now: float,
    ttl_seconds: float = RESERVATION_TTL_SECONDS,
    token: str | None = None,
) -> bool:
    """Mark a matching exact-token reservation as having entered settlement."""
    del ttl_seconds  # Retained for call-site symmetry; exact token owns transition.
    existing = reservations.get(payment_id)
    if existing is None:
        return False
    _timestamp, reserved_fp, reserved_token, _stored_ttl, state = _reservation_parts(
        existing
    )
    if not _owns_reservation(
        reserved_fp, reserved_token, fingerprint=fingerprint, token=token
    ):
        return False
    if state == UNKNOWN:
        return False
    if isinstance(existing, Reservation):
        existing.state = SETTLING
        existing.timestamp = now
        return True
    if isinstance(existing, MutableMapping):
        existing["state"] = SETTLING
        existing["timestamp"] = now
        return True
    return False


def mark_outcome_unknown(
    reservations: MutableMapping[str, Any],
    *,
    payment_id: str,
    fingerprint: str,
    now: float,
    ttl_seconds: float = RESERVATION_TTL_SECONDS,
    token: str | None = None,
) -> bool:
    """Retain a tokenized outcome-unknown tombstone until the server TTL expires."""
    del ttl_seconds  # Retained for call-site symmetry; exact token owns transition.
    existing = reservations.get(payment_id)
    if existing is None:
        return False
    _timestamp, reserved_fp, reserved_token, _stored_ttl, state = _reservation_parts(
        existing
    )
    if not _owns_reservation(
        reserved_fp, reserved_token, fingerprint=fingerprint, token=token
    ):
        return False
    if state == UNKNOWN:
        return False
    if isinstance(existing, Reservation):
        existing.state = UNKNOWN
        existing.timestamp = now
        return True
    if isinstance(existing, MutableMapping):
        existing["state"] = UNKNOWN
        existing["timestamp"] = now
        return True
    return False


def reservation_token_from_transport(transport_context: Any) -> str | None:
    """Read the middleware token from a FastAPI SDK transport context.

    FastAPIAdapter stores the Starlette request on ``adapter._request``.
    Missing adapter or token is not fingerprint-only ownership.
    """
    request = getattr(transport_context, "request", None)
    adapter = getattr(request, "adapter", None) if request is not None else None
    raw = getattr(adapter, "_request", None)
    if raw is None:
        return None
    state = getattr(raw, "state", None)
    token = (
        getattr(state, "x402_reservation_token", None) if state is not None else None
    )
    return str(token) if token else None


def bind_payment_id(
    cache: MutableMapping[str, Any],
    reservations: MutableMapping[str, Any],
    *,
    payment_id: str,
    fingerprint: str,
    now: float,
    cache_ttl_seconds: float,
    reservation_ttl_seconds: float = RESERVATION_TTL_SECONDS,
    max_pending: int = MAX_PENDING_RESERVATIONS,
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
        max_pending=max_pending,
    )
