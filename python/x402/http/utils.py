"""HTTP utility functions for encoding/decoding x402 headers."""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterable, Iterable
from typing import IO, Any

from ..schemas import (
    PaymentPayload,
    PaymentRequired,
    SettleResponse,
)
from ..schemas.v1 import PaymentPayloadV1, PaymentRequiredV1
from .constants import PAYMENT_REQUIRED_HEADER, X_PAYMENT_HEADER


def safe_base64_encode(data: str) -> str:
    """Base64 encode a string safely."""
    return base64.b64encode(data.encode("utf-8")).decode("utf-8")


def safe_base64_decode(data: str) -> str:
    """Base64 decode a string safely."""
    return base64.b64decode(data.encode("utf-8")).decode("utf-8")


def encode_payment_signature_header(payload: PaymentPayload | PaymentPayloadV1) -> str:
    """Encode a payment payload as a base64 header value."""
    return safe_base64_encode(payload.model_dump_json(by_alias=True, exclude_none=True))


def decode_payment_signature_header(
    header_value: str,
) -> PaymentPayload | PaymentPayloadV1:
    """Decode a base64 payment signature header into a PaymentPayload."""
    json_str = safe_base64_decode(header_value)
    data = json.loads(json_str)

    # Detect version
    version = data.get("x402Version", 2)
    if version == 1:
        return PaymentPayloadV1.model_validate(data)
    return PaymentPayload.model_validate(data)


def encode_payment_required_header(
    payment_required: PaymentRequired | PaymentRequiredV1,
) -> str:
    """Encode a PaymentRequired object as a base64 header value."""
    return safe_base64_encode(payment_required.model_dump_json(by_alias=True, exclude_none=True))


def decode_payment_required_header(
    header_value: str,
) -> PaymentRequired | PaymentRequiredV1:
    """Decode a base64 payment required header into a PaymentRequired object."""
    json_str = safe_base64_decode(header_value)
    data = json.loads(json_str)

    # Detect version
    version = data.get("x402Version", 2)
    if version == 1:
        return PaymentRequiredV1.model_validate(data)
    return PaymentRequired.model_validate(data)


def encode_payment_response_header(settle_response: SettleResponse) -> str:
    """Encode a SettleResponse object as a base64 header value."""
    payload = settle_response.model_dump(by_alias=True, exclude_none=True)
    return safe_base64_encode(json.dumps(payload))


def decode_payment_response_header(header_value: str) -> SettleResponse:
    """Decode a base64 payment response header into a SettleResponse object."""
    json_str = safe_base64_decode(header_value)
    return SettleResponse.model_validate_json(json_str)


def detect_payment_required_version(
    headers: dict[str, str],
    body: bytes | None = None,
) -> int:
    """Detect the x402 protocol version from HTTP response headers and body.

    Prioritizes V2 header, then V1 body.

    Args:
        headers: Response headers (case-insensitive).
        body: Optional response body bytes.

    Returns:
        Protocol version (1 or 2).

    Raises:
        ValueError: If version cannot be detected.
    """
    normalized_headers = {k.upper(): v for k, v in headers.items()}

    if PAYMENT_REQUIRED_HEADER in normalized_headers:
        return 2
    if X_PAYMENT_HEADER in normalized_headers:
        return 1

    if body:
        try:
            data = json.loads(body.decode("utf-8"))
            version = data.get("x402Version")
            if version in [1, 2]:
                return version
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass

    raise ValueError("Could not detect x402 version from response")


def htmlsafe_json_dumps(obj: Any) -> str:
    """Serialize object to JSON with HTML-safe escaping.

    Escapes <, >, and & characters to prevent XSS attacks when
    embedding JSON in HTML script tags.

    Args:
        obj: Object to serialize to JSON.

    Returns:
        HTML-safe JSON string.
    """
    _json_script_escapes = {
        ord(">"): "\\u003E",
        ord("<"): "\\u003C",
        ord("&"): "\\u0026",
    }
    return json.dumps(obj).translate(_json_script_escapes)


# ============================================================================
# Response body limits
# ============================================================================


class ResponseBodyTooLargeError(Exception):
    """HTTP response body exceeded the buffering limit applied by x402 clients."""


# Bounds the payment-required and facilitator responses buffered by this package.
# Control-plane JSON is small, so a tight limit is enough.
MAX_CONTROL_PLANE_RESPONSE_BYTES = 1 << 20


def read_limited_body(
    source: IO[bytes] | Iterable[bytes],
    max_bytes: int = MAX_CONTROL_PLANE_RESPONSE_BYTES,
) -> bytes:
    """Read at most max_bytes from source. A larger body raises ResponseBodyTooLargeError without buffering the rest."""
    read = getattr(source, "read", None)
    if callable(read):
        body = read(max_bytes + 1)
        return _check_limited_body(body, max_bytes)
    return _check_limited_body(_read_limited_chunks(source, max_bytes), max_bytes)


async def aread_limited_body(
    source: AsyncIterable[bytes],
    max_bytes: int = MAX_CONTROL_PLANE_RESPONSE_BYTES,
) -> bytes:
    """Read at most max_bytes from an async source. A larger body raises ResponseBodyTooLargeError without buffering the rest."""
    buf = bytearray()
    limit = max_bytes + 1
    async for chunk in source:
        remaining = limit - len(buf)
        if remaining <= 0:
            break
        buf.extend(chunk[:remaining])
    return _check_limited_body(bytes(buf), max_bytes)


def _read_limited_chunks(source: Iterable[bytes], max_bytes: int) -> bytes:
    buf = bytearray()
    limit = max_bytes + 1
    for chunk in source:
        remaining = limit - len(buf)
        if remaining <= 0:
            break
        buf.extend(chunk[:remaining])
    return bytes(buf)


def _check_limited_body(body: bytes, max_bytes: int) -> bytes:
    if len(body) > max_bytes:
        raise ResponseBodyTooLargeError(f"http response body too large: limit {max_bytes} bytes")
    return body
