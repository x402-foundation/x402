"""Unit tests for extension_responses HTTP sidechannel utilities."""

from __future__ import annotations

import base64
import json
from unittest.mock import MagicMock

from x402.http.extension_responses import (
    EXTENSION_RESPONSES_HEADER,
    extract_extension_responses_header,
)


def _response_with_header(value: str | None) -> MagicMock:
    response = MagicMock()
    headers = {}
    if value is not None:
        headers[EXTENSION_RESPONSES_HEADER] = value
    response.headers = headers
    return response


class TestExtractExtensionResponsesHeader:
    def test_decodes_multi_key_envelope(self) -> None:
        payload = {
            "bazaar": {"status": "processing"},
            "builder_code": {"status": "accepted"},
        }
        encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("utf-8")
        response = _response_with_header(encoded)

        assert extract_extension_responses_header(response) == payload

    def test_returns_none_when_header_missing(self) -> None:
        response = _response_with_header(None)

        assert extract_extension_responses_header(response) is None

    def test_returns_none_for_malformed_header(self) -> None:
        response = _response_with_header("not-valid-base64!!!")

        assert extract_extension_responses_header(response) is None

    def test_returns_none_for_non_object_json(self) -> None:
        encoded = base64.b64encode(b'"string-value"').decode("utf-8")
        response = _response_with_header(encoded)

        assert extract_extension_responses_header(response) is None

    def test_accepts_lowercase_header_name(self) -> None:
        payload = {"bazaar": {"status": "success"}}
        encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("utf-8")
        response = MagicMock()
        response.headers = {"extension-responses": encoded}

        assert extract_extension_responses_header(response) == payload
