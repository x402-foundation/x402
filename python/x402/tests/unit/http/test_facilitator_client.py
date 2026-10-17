"""Unit tests for x402.http.facilitator_client."""

from __future__ import annotations

import base64
import inspect
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
from x402.schemas import PaymentPayload, PaymentRequirements
from x402.schemas.errors import SettleError, VerifyError
from x402.server_base import settle_with_pending_retry, settle_with_pending_retry_async


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


def test_defaults_timeout_to_90_seconds():
    assert HTTPFacilitatorClient()._timeout == 90.0
    assert HTTPFacilitatorClient(FacilitatorConfig(timeout=5.0))._timeout == 5.0
    assert HTTPFacilitatorClient({})._timeout == 90.0


def _error_client(responses, as_async):
    post = AsyncMock(side_effect=responses) if as_async else MagicMock(side_effect=responses)
    http_client = MagicMock(post=post)
    client_type = HTTPFacilitatorClient if as_async else HTTPFacilitatorClientSync
    return client_type(FacilitatorConfig(http_client=http_client)), post


async def _resolve(result):
    return await result if inspect.isawaitable(result) else result


@pytest.mark.asyncio
@pytest.mark.parametrize("as_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("operation,status", [("verify", 400), ("settle", 500)])
async def test_non_200_response_raises_typed_error_with_response(as_async, operation, status):
    body = (
        {
            "isValid": False,
            "invalidReason": "insufficient_funds",
            "invalidMessage": "Balance too low",
            "payer": "0xpayer",
        }
        if operation == "verify"
        else {
            "success": False,
            "errorReason": "settlement_pending",
            "errorMessage": "Confirmation timed out",
            "transaction": "0xpending",
            "network": "eip155:8453",
            "payer": "0xpayer",
        }
    )
    body["extensions"] = {"terms": {"info": {"format": "uri"}}}
    sidechannel = {"bazaar": {"status": "processing"}}
    response = httpx.Response(
        status,
        json=body,
        headers={EXTENSION_RESPONSES_HEADER: _encode_extension_responses(sidechannel)},
    )
    client, post = _error_client([response], as_async)
    error_type = VerifyError if operation == "verify" else SettleError

    with pytest.raises(error_type) as exc:
        await _resolve(getattr(client, operation)(make_v2_payload(), make_payment_requirements()))

    error = exc.value
    assert error.payer == "0xpayer"
    assert error.status_code == status
    assert error.response.model_dump(by_alias=True, exclude_none=True) == body
    assert error.response.extension_responses == sidechannel
    if operation == "verify":
        assert error.invalid_reason == "insufficient_funds"
        assert error.invalid_message == "Balance too low"
    else:
        assert error.error_reason == "settlement_pending"
        assert error.error_message == "Confirmation timed out"
        assert error.transaction == "0xpending"
    assert post.call_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("as_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("operation", ["verify", "settle"])
@pytest.mark.parametrize(
    "body",
    [
        "not-json",
        "[]",
        '{"error":"unavailable"}',
        # The settlement schema requires transaction and network even on failure.
        '{"success":false}',
    ],
)
async def test_non_200_invalid_body_keeps_http_failure(as_async, operation, body):
    client, post = _error_client([httpx.Response(503, text=body)], as_async)

    with pytest.raises(ValueError, match=rf"Facilitator {operation} failed \(503\)"):
        await _resolve(getattr(client, operation)(make_v2_payload(), make_payment_requirements()))

    assert post.call_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("as_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("second_pending", [False, True], ids=["confirmed", "still-pending"])
async def test_non_200_pending_response_retries_once(as_async, second_pending):
    pending = {
        "success": False,
        "errorReason": "settlement_pending",
        "transaction": "0xpending",
        "network": "eip155:8453",
    }
    second = pending if second_pending else _make_settle_response()
    client, post = _error_client(
        [
            httpx.Response(500, json=pending),
            httpx.Response(500 if second_pending else 200, json=second),
        ],
        as_async,
    )
    payload, requirements = make_v2_payload(), make_payment_requirements()
    retry = settle_with_pending_retry_async if as_async else settle_with_pending_retry

    if second_pending:
        with pytest.raises(SettleError) as exc:
            await _resolve(retry(client, payload, requirements))
        assert exc.value.transaction == "0xpending"
        assert exc.value.response.network == "eip155:8453"
    else:
        result = await _resolve(retry(client, payload, requirements))
        assert result.success is True
        assert result.transaction == "0xabc"
    assert post.call_count == 2
    assert post.call_args_list[0] == post.call_args_list[1]


@pytest.mark.asyncio
@pytest.mark.parametrize("as_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize(
    "reason,transaction,success",
    [
        ("insufficient_funds", "0xpending", False),
        ("settlement_pending", "", False),
        ("settlement_pending", "0xpending", True),
    ],
)
async def test_non_200_non_retryable_response_does_not_retry(
    as_async, reason, transaction, success
):
    body = {
        "success": success,
        "errorReason": reason,
        "transaction": transaction,
        "network": "eip155:8453",
    }
    client, post = _error_client([httpx.Response(500, json=body)], as_async)
    retry = settle_with_pending_retry_async if as_async else settle_with_pending_retry

    with pytest.raises(SettleError):
        await _resolve(retry(client, make_v2_payload(), make_payment_requirements()))
    assert post.call_count == 1
