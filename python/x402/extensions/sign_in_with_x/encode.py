"""Header encoding for SIWX extension."""

from __future__ import annotations

import json

from x402.http.utils import safe_base64_encode

from .types import SIWxPayload


def encode_siwx_header(payload: SIWxPayload) -> str:
    """Encode SIWX payload for SIGN-IN-WITH-X header."""
    return safe_base64_encode(json.dumps(payload.model_dump(by_alias=True, exclude_none=True)))
