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


# ---------------------------------------------------------------------------
# omit_optional_payload_fields
# ---------------------------------------------------------------------------


def make_v2_payload_with_optional(signature: str = "0xmock") -> PaymentPayload:
    """V2 PaymentPayload carrying the optional resource + extensions siblings."""
    return PaymentPayload(
        x402_version=2,
        payload={"signature": signature},
        accepted=make_payment_requirements(),
        resource={"url": "https://resource.test/paid"},
        extensions={"note": "informational-only"},
    )


def _posted_payment_payload(http_client: MagicMock) -> dict:
    """Return the paymentPayload dict that was POSTed to the facilitator."""
    body = http_client.post.call_args.kwargs["json"]
    return body["paymentPayload"]


@pytest.mark.asyncio
async def test_async_verify_keeps_optional_payload_fields_by_default():
    """Default behavior is unchanged: the full payload (incl. optional fields) is sent."""
    response = MagicMock(status_code=200, text='{"isValid": true}')
    response.json.return_value = {"isValid": True}

    http_client = MagicMock()
    http_client.post = AsyncMock(return_value=response)

    client = HTTPFacilitatorClient(
        FacilitatorConfig(url="https://facilitator.test", http_client=http_client)
    )

    await client.verify(make_v2_payload_with_optional(), make_payment_requirements())

    posted = _posted_payment_payload(http_client)
    assert "resource" in posted
    assert "extensions" in posted
    assert {"x402Version", "payload", "accepted"} <= set(posted)


@pytest.mark.asyncio
async def test_async_verify_omits_optional_payload_fields_when_configured():
    """With the flag set, resource/extensions are stripped before POST; rest untouched."""
    response = MagicMock(status_code=200, text='{"isValid": true}')
    response.json.return_value = {"isValid": True}

    http_client = MagicMock()
    http_client.post = AsyncMock(return_value=response)

    client = HTTPFacilitatorClient(
        FacilitatorConfig(
            url="https://facilitator.test",
            http_client=http_client,
            omit_optional_payload_fields=True,
        )
    )

    await client.verify(make_v2_payload_with_optional(), make_payment_requirements())

    posted = _posted_payment_payload(http_client)
    assert "resource" not in posted
    assert "extensions" not in posted
    # The fields the facilitator needs to verify the payment are left intact.
    assert posted["x402Version"] == 2
    assert posted["payload"] == {"signature": "0xmock"}
    assert "accepted" in posted


def test_sync_settle_omits_optional_payload_fields_when_configured():
    """Strip applies on the sync settle path too — verify + settle share one chokepoint."""
    response = MagicMock(
        status_code=200,
        text='{"success": true, "transaction": "0xhash", "network": "eip155:8453"}',
    )
    response.json.return_value = {
        "success": True,
        "transaction": "0xhash",
        "network": "eip155:8453",
    }

    http_client = MagicMock()
    http_client.post.return_value = response

    client = HTTPFacilitatorClientSync(
        FacilitatorConfig(
            url="https://facilitator.test",
            http_client=http_client,
            omit_optional_payload_fields=True,
        )
    )

    client.settle(make_v2_payload_with_optional(), make_payment_requirements())

    posted = _posted_payment_payload(http_client)
    assert "resource" not in posted
    assert "extensions" not in posted
    assert "accepted" in posted
