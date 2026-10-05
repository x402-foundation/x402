"""RFC 8785 canonical JSON used by Masumi commitments and signed terms."""

from typing import Any

import rfc8785


def _json_numbers(value: Any, ancestors: set[int]) -> Any:
    """Interpret JSON integers as ECMAScript numbers without coercing other values."""
    if value is None or type(value) in (str, bool, float):
        return value
    if type(value) is int:
        # JSON.parse uses IEEE-754 even when the wire spelling has no decimal point.
        # Keep protocol integer strings untouched: only JSON numbers are rounded.
        try:
            return float(value) if abs(value) > 2**53 - 1 else value
        except OverflowError as exc:
            raise ValueError("JCS number exceeds the finite IEEE-754 range") from exc
    if type(value) not in (list, dict):
        raise ValueError(f"JCS cannot serialize a value of type {type(value).__name__}")
    identity = id(value)
    if identity in ancestors:
        raise ValueError("JCS cannot serialize a cyclic value")
    ancestors.add(identity)
    try:
        if isinstance(value, list):
            return [_json_numbers(item, ancestors) for item in value]
        if any(not isinstance(key, str) for key in value):
            raise ValueError("JCS object keys must be strings")
        return {key: _json_numbers(item, ancestors) for key, item in value.items()}
    finally:
        ancestors.remove(identity)


def jcs(value: Any) -> str:
    """Canonicalize JSON with ECMAScript numbers and UTF-16 key order.

    Numeric integers use IEEE-754 rounding, matching JavaScript JSON.parse.
    Use strings for values that require exact arbitrary-precision integers.
    Non-JSON values, cycles and non-finite numbers raise ValueError.
    """
    return jcs_bytes(value).decode("utf-8")


def jcs_bytes(value: Any) -> bytes:
    """Return canonical JSON encoded as UTF-8."""
    return rfc8785.dumps(_json_numbers(value, set()))
