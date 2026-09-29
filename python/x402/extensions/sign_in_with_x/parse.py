"""Header parsing for SIWX extension."""

from __future__ import annotations

import json
import re

from pydantic import ValidationError

from x402.http.utils import safe_base64_decode

from .types import SIWxPayload

_BASE64_RE = re.compile(r"^[A-Za-z0-9+/]*={0,2}$")


def parse_siwx_header(header: str) -> SIWxPayload:
    """Parse SIGN-IN-WITH-X header into structured payload."""
    if not _BASE64_RE.match(header):
        raise ValueError("Invalid SIWX header: not valid base64")

    json_str = safe_base64_decode(header)
    try:
        raw_payload = json.loads(json_str)
    except json.JSONDecodeError as e:
        raise ValueError("Invalid SIWX header: not valid JSON") from e

    try:
        return SIWxPayload.model_validate(raw_payload)
    except ValidationError as e:
        issues = ", ".join(
            f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}" for err in e.errors()
        )
        raise ValueError(f"Invalid SIWX header: {issues}") from e
