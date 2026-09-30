"""Utilities for facilitator EXTENSION-RESPONSES sidechannel on HTTP."""

from __future__ import annotations

import base64
import json
import logging
from typing import Any

EXTENSION_RESPONSES_HEADER = "EXTENSION-RESPONSES"

_logger = logging.getLogger("x402")


def extract_extension_responses_header(http_response: Any) -> dict[str, Any] | None:
    """Decode the EXTENSION-RESPONSES header into a keyed extension map.

    Silently returns None when the header is absent or malformed.

    Args:
        http_response: HTTP response object with a ``headers`` mapping.

    Returns:
        Decoded extension responses keyed by extension name, or None.
    """
    header = http_response.headers.get(EXTENSION_RESPONSES_HEADER) or http_response.headers.get(
        "extension-responses"
    )
    if not header:
        return None

    try:
        decoded = base64.b64decode(header).decode("utf-8")
        header_extensions = json.loads(decoded)
        if not isinstance(header_extensions, dict):
            return None
        return header_extensions
    except Exception:
        return None


def log_extension_responses(decoded: dict[str, Any] | None) -> None:
    """Log decoded extension responses from the facilitator sidechannel."""
    if not decoded:
        return

    _logger.info(
        "[x402] extension responses: %s",
        json.dumps(decoded),
    )
