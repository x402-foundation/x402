"""Unit tests for x402.http.facilitator_client."""

from __future__ import annotations

import base64
import json
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from x402.http.extension_responses import EXTENSION_RESPONSES_HEADER
from x402.http.facilitator_client import (
    HTTPFacilitatorClient,
    HTTPFacilitatorClientSync,
)
from x402.http.facilitator_client_base import (
    FacilitatorConfig,
    FacilitatorResponseError,
)
from x402.http.utils import MAX_CONTROL_PLANE_RESPONSE_BYTES, ResponseBodyTooLargeError
from x402.schemas import PaymentPayload, PaymentRequirements


def make_payment_requirements() -> PaymentRequirements:
    """Helper to create valid PaymentRequirements."""
    return PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0x0000000000000000000000000000000000000000",
        amount="1000000",
        pay_to="0x1234567890123456789012345678901234567890",
        max_timeout_seconds=300,
    )


def make_v2_payload(signature: str = "0xmock") -> PaymentPayload:
    """Helper to create valid V2 PaymentPayload."""
    return PaymentPayload(
        x402_version=2,
        payload={"signature": signature},
        accepted=make_payment_requirements(),
    )


def _encode_extension_responses(payload: dict) -> str:
    return base64.b64encode(json.dumps(payload).encode("utf-8")).decode("utf-8")


def _make_http_response(
    status_code: int,
    json_data: dict | None = None,
    text: str | None = None,
    headers: dict[str, str] | None = None,
    content: bytes | None = None,
) -> httpx.Response:
    if content is None:
        if json_data is not None:
            content = json.dumps(json_data).encode("utf-8")
        elif text is not None:
            content = text.encode("utf-8")
        else:
            content = b""
    return httpx.Response(status_code, content=content, headers=headers or {})


def _async_http_client(response: httpx.Response) -> MagicMock:
    http_client = MagicMock()
    http_client.send = AsyncMock(return_value=response)
    return http_client


def _sync_http_client(response: httpx.Response) -> MagicMock:
    http_client = MagicMock()
    http_client.send.return_value = response
    return http_client


def _make_settle_response() -> dict:
    return {
        "success": True,
        "transaction": "0xabc",
        "network": "eip155:8453",
        "payer": "0x1234567890123456789012345678901234567890",
    }


@pytest.mark.asyncio
async def test_async_verify_sets_extension_responses_from_header():
    """Verify should populate extension_responses without touching extensions."""
    header_payload = {"bazaar": {"status": "processing"}}
    response = _make_http_response(
        200,
        {"isValid": True, "payer": "0xpayer"},
        headers={EXTENSION_RESPONSES_HEADER: _encode_extension_responses(header_payload)},
    )

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=_async_http_client(response))
    )

    result = await client.verify(make_v2_payload(), make_payment_requirements())

    assert result.extension_responses == header_payload
    assert result.extensions is None


@pytest.mark.asyncio
async def test_async_settle_keeps_body_extensions_independent_from_sidechannel():
    """Body extensions and header extension_responses must remain separate."""
    body_extensions = {"terms": {"info": {"format": "uri"}}}
    header_payload = {"bazaar": {"status": "success"}}
    response = _make_http_response(
        200,
        {
            **_make_settle_response(),
            "extensions": body_extensions,
        },
        headers={EXTENSION_RESPONSES_HEADER: _encode_extension_responses(header_payload)},
    )

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=_async_http_client(response))
    )

    result = await client.settle(make_v2_payload(), make_payment_requirements())

    assert result.extensions == body_extensions
    assert result.extension_responses == header_payload


@pytest.mark.asyncio
async def test_async_verify_ignores_malformed_extension_responses_header():
    response = _make_http_response(
        200,
        {"isValid": True, "payer": "0xpayer"},
        headers={EXTENSION_RESPONSES_HEADER: "not-valid"},
    )

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=_async_http_client(response))
    )

    result = await client.verify(make_v2_payload(), make_payment_requirements())

    assert result.extension_responses is None


def test_sync_settle_sets_extension_responses_from_header():
    header_payload = {
        "bazaar": {"status": "processing"},
        "builder_code": {"status": "accepted"},
    }
    response = _make_http_response(
        200,
        _make_settle_response(),
        headers={EXTENSION_RESPONSES_HEADER: _encode_extension_responses(header_payload)},
    )

    client = HTTPFacilitatorClientSync(
        FacilitatorConfig(url="https://facilitator.test", http_client=_sync_http_client(response))
    )

    result = client.settle(make_v2_payload(), make_payment_requirements())

    assert result.extension_responses == header_payload
    assert result.extensions is None


@pytest.mark.asyncio
async def test_async_verify_raises_facilitator_response_error_for_invalid_json():
    """Async verify should surface invalid JSON as facilitator boundary error."""
    response = _make_http_response(200, text="not-json")

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=_async_http_client(response))
    )

    with pytest.raises(
        FacilitatorResponseError,
        match="Facilitator verify returned invalid JSON",
    ):
        await client.verify(make_v2_payload(), make_payment_requirements())


@pytest.mark.asyncio
async def test_async_settle_raises_facilitator_response_error_for_invalid_schema():
    """Async settle should surface schema drift as facilitator boundary error."""
    response = _make_http_response(200, {"success": True})

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=_async_http_client(response))
    )

    with pytest.raises(
        FacilitatorResponseError,
        match="Facilitator settle returned invalid data",
    ):
        await client.settle(make_v2_payload(), make_payment_requirements())


def test_sync_verify_raises_facilitator_response_error_for_invalid_json():
    """Sync verify should surface invalid JSON as facilitator boundary error."""
    response = _make_http_response(200, text="not-json")

    client = HTTPFacilitatorClientSync(
        FacilitatorConfig(url="https://facilitator.test", http_client=_sync_http_client(response))
    )

    with pytest.raises(
        FacilitatorResponseError,
        match="Facilitator verify returned invalid JSON",
    ):
        client.verify(make_v2_payload(), make_payment_requirements())


def test_sync_settle_raises_facilitator_response_error_for_invalid_schema():
    """Sync settle should surface schema drift as facilitator boundary error."""
    response = _make_http_response(200, {"success": True})

    client = HTTPFacilitatorClientSync(
        FacilitatorConfig(url="https://facilitator.test", http_client=_sync_http_client(response))
    )

    with pytest.raises(
        FacilitatorResponseError,
        match="Facilitator settle returned invalid data",
    ):
        client.settle(make_v2_payload(), make_payment_requirements())


class _TrackingSyncStream(httpx.SyncByteStream):
    def __init__(self, nbytes: int) -> None:
        self.closed = False
        self._nbytes = nbytes

    def __iter__(self):
        remaining = self._nbytes
        while remaining > 0:
            n = min(65536, remaining)
            remaining -= n
            yield b"\x00" * n

    def close(self) -> None:
        self.closed = True


def test_http_facilitator_client_rejects_oversized_responses() -> None:
    requirements = make_payment_requirements()
    payload = make_v2_payload()

    tests = [
        ("supported 429", 429, lambda client: client.get_supported()),
        (
            "verify success",
            200,
            lambda client: client.verify(payload, requirements),
        ),
        (
            "settle error",
            500,
            lambda client: client.settle(payload, requirements),
        ),
    ]

    for name, status_code, call in tests:
        attempts = 0
        stream = _TrackingSyncStream(MAX_CONTROL_PLANE_RESPONSE_BYTES + 1)

        def send(_request, stream=True, _status=status_code, _body=stream):
            nonlocal attempts
            attempts += 1
            return httpx.Response(_status, stream=_body)

        http_client = MagicMock()
        http_client.send.side_effect = send
        client = HTTPFacilitatorClientSync(
            FacilitatorConfig(url="https://facilitator.example.com", http_client=http_client)
        )

        with pytest.raises(ResponseBodyTooLargeError):
            call(client)
        assert stream.closed, name
        assert attempts == 1, name
