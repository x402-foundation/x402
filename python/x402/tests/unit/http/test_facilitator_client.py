"""Unit tests for x402.http.facilitator_client."""

from __future__ import annotations

import base64
import json
from unittest.mock import AsyncMock, MagicMock

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
    response = MagicMock(status_code=200, text="ok")
    response.json.return_value = {"isValid": True, "payer": "0xpayer"}
    response.headers = {EXTENSION_RESPONSES_HEADER: _encode_extension_responses(header_payload)}

    http_client = MagicMock()
    http_client.post = AsyncMock(return_value=response)

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    result = await client.verify(make_v2_payload(), make_payment_requirements())

    assert result.extension_responses == header_payload
    assert result.extensions is None


@pytest.mark.asyncio
async def test_async_settle_keeps_body_extensions_independent_from_sidechannel():
    """Body extensions and header extension_responses must remain separate."""
    body_extensions = {"terms": {"info": {"format": "uri"}}}
    header_payload = {"bazaar": {"status": "success"}}
    response = MagicMock(status_code=200, text="ok")
    response.json.return_value = {
        **_make_settle_response(),
        "extensions": body_extensions,
    }
    response.headers = {EXTENSION_RESPONSES_HEADER: _encode_extension_responses(header_payload)}

    http_client = MagicMock()
    http_client.post = AsyncMock(return_value=response)

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    result = await client.settle(make_v2_payload(), make_payment_requirements())

    assert result.extensions == body_extensions
    assert result.extension_responses == header_payload


@pytest.mark.asyncio
async def test_async_verify_ignores_malformed_extension_responses_header():
    response = MagicMock(status_code=200, text="ok")
    response.json.return_value = {"isValid": True, "payer": "0xpayer"}
    response.headers = {EXTENSION_RESPONSES_HEADER: "not-valid"}

    http_client = MagicMock()
    http_client.post = AsyncMock(return_value=response)

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    result = await client.verify(make_v2_payload(), make_payment_requirements())

    assert result.extension_responses is None


def test_sync_settle_sets_extension_responses_from_header():
    header_payload = {
        "bazaar": {"status": "processing"},
        "builder_code": {"status": "accepted"},
    }
    response = MagicMock(status_code=200, text="ok")
    response.json.return_value = _make_settle_response()
    response.headers = {EXTENSION_RESPONSES_HEADER: _encode_extension_responses(header_payload)}

    http_client = MagicMock()
    http_client.post.return_value = response

    client = HTTPFacilitatorClientSync(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    result = client.settle(make_v2_payload(), make_payment_requirements())

    assert result.extension_responses == header_payload
    assert result.extensions is None


@pytest.mark.asyncio
async def test_async_verify_raises_facilitator_response_error_for_invalid_json():
    """Async verify should surface invalid JSON as facilitator boundary error."""
    response = MagicMock(status_code=200, text="not-json")
    response.json.side_effect = json.JSONDecodeError("Expecting value", "not-json", 0)

    http_client = MagicMock()
    http_client.post = AsyncMock(return_value=response)

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    with pytest.raises(
        FacilitatorResponseError,
        match="Facilitator verify returned invalid JSON",
    ):
        await client.verify(make_v2_payload(), make_payment_requirements())


@pytest.mark.asyncio
async def test_async_settle_raises_facilitator_response_error_for_invalid_schema():
    """Async settle should surface schema drift as facilitator boundary error."""
    response = MagicMock(status_code=200, text='{"success": true}')
    response.json.return_value = {"success": True}

    http_client = MagicMock()
    http_client.post = AsyncMock(return_value=response)

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    with pytest.raises(
        FacilitatorResponseError,
        match="Facilitator settle returned invalid data",
    ):
        await client.settle(make_v2_payload(), make_payment_requirements())


def test_sync_verify_raises_facilitator_response_error_for_invalid_json():
    """Sync verify should surface invalid JSON as facilitator boundary error."""
    response = MagicMock(status_code=200, text="not-json")
    response.json.side_effect = json.JSONDecodeError("Expecting value", "not-json", 0)

    http_client = MagicMock()
    http_client.post.return_value = response

    client = HTTPFacilitatorClientSync(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    with pytest.raises(
        FacilitatorResponseError,
        match="Facilitator verify returned invalid JSON",
    ):
        client.verify(make_v2_payload(), make_payment_requirements())


def test_sync_settle_raises_facilitator_response_error_for_invalid_schema():
    """Sync settle should surface schema drift as facilitator boundary error."""
    response = MagicMock(status_code=200, text='{"success": true}')
    response.json.return_value = {"success": True}

    http_client = MagicMock()
    http_client.post.return_value = response

    client = HTTPFacilitatorClientSync(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    with pytest.raises(
        FacilitatorResponseError,
        match="Facilitator settle returned invalid data",
    ):
        client.settle(make_v2_payload(), make_payment_requirements())
