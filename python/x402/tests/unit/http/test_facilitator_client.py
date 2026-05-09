"""Unit tests for x402.http.facilitator_client."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

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
