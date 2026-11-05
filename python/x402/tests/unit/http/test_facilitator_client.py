"""Unit tests for x402.http.facilitator_client."""

from __future__ import annotations

import base64
import inspect
import json
from types import MappingProxyType
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from x402.http.extension_responses import EXTENSION_RESPONSES_HEADER
from x402.http.facilitator_client import (
    HTTPFacilitatorClient,
    HTTPFacilitatorClientSync,
)
from x402.http.facilitator_client_base import (
    CreateHeadersAuthProvider,
    FacilitatorConfig,
    FacilitatorResponseError,
)
from x402.http.utils import MAX_CONTROL_PLANE_RESPONSE_BYTES, ResponseBodyTooLargeError
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


def test_defaults_timeout_to_90_seconds():
    assert HTTPFacilitatorClient()._timeout == 90.0
    assert HTTPFacilitatorClient(FacilitatorConfig(timeout=5.0))._timeout == 5.0
    assert HTTPFacilitatorClient({})._timeout == 90.0


def _error_client(responses, as_async):
    send = AsyncMock(side_effect=responses) if as_async else MagicMock(side_effect=responses)
    http_client = MagicMock(send=send)
    http_client.build_request.side_effect = httpx.Request
    client_type = HTTPFacilitatorClient if as_async else HTTPFacilitatorClientSync
    return client_type(FacilitatorConfig(http_client=http_client)), send


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
    client, send = _error_client([response], as_async)
    error_type = VerifyError if operation == "verify" else SettleError

    with pytest.raises(error_type) as exc:
        await _resolve(getattr(client, operation)(make_v2_payload(), make_payment_requirements()))

    error = exc.value
    assert error.payer == "0xpayer"
    assert error.status_code == status
    assert error.response.model_dump(by_alias=True, exclude_none=True) == body
    assert error.response.extension_responses == sidechannel
    assert response.is_closed
    if operation == "verify":
        assert error.invalid_reason == "insufficient_funds"
        assert error.invalid_message == "Balance too low"
    else:
        assert error.error_reason == "settlement_pending"
        assert error.error_message == "Confirmation timed out"
        assert error.transaction == "0xpending"
    assert send.call_count == 1


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
    client, send = _error_client([httpx.Response(503, text=body)], as_async)

    with pytest.raises(ValueError, match=rf"Facilitator {operation} failed \(503\)"):
        await _resolve(getattr(client, operation)(make_v2_payload(), make_payment_requirements()))

    assert send.call_count == 1


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
    client, send = _error_client(
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
    assert send.call_count == 2
    first, second = (call.args[0] for call in send.call_args_list)
    assert first.method == second.method == "POST"
    assert first.url == second.url
    assert first.content == second.content
    assert first.headers == second.headers
    assert all(call.kwargs == {"stream": True} for call in send.call_args_list)


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
    client, send = _error_client([httpx.Response(500, json=body)], as_async)
    retry = settle_with_pending_retry_async if as_async else settle_with_pending_retry

    with pytest.raises(SettleError):
        await _resolve(retry(client, make_v2_payload(), make_payment_requirements()))
    assert send.call_count == 1


def test_create_headers_allows_omitted_paths():
    provider = CreateHeadersAuthProvider(lambda: {"verify": {"Authorization": "Bearer verify"}})

    headers = provider.get_auth_headers()

    assert headers.verify == {"Authorization": "Bearer verify"}
    assert headers.settle == {}


def test_create_headers_accepts_mapping_path_values():
    client = HTTPFacilitatorClientSync(
        {
            "url": "https://facilitator.test",
            "create_headers": lambda: {
                "verify": MappingProxyType({"Authorization": "Bearer verify"}),
            },
        }
    )

    assert client._get_verify_headers()["Authorization"] == "Bearer verify"


def test_create_headers_rejects_flat_headers_dict():
    client = HTTPFacilitatorClientSync(
        {
            "url": "https://facilitator.test",
            "create_headers": lambda: {"Authorization": "Bearer token"},
        }
    )

    with pytest.raises(ValueError, match="keyed by facilitator path"):
        client._get_verify_headers()


class _TrackingStream(httpx.SyncByteStream, httpx.AsyncByteStream):
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

    async def __aiter__(self):
        for chunk in self:
            yield chunk

    async def aclose(self) -> None:
        self.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "as_async,operation,status_code",
    [
        (False, "get_supported", 429),
        (False, "verify", 200),
        (False, "settle", 500),
        (True, "verify", 200),
        (True, "settle", 500),
    ],
)
async def test_http_facilitator_client_rejects_oversized_responses(
    as_async, operation, status_code
) -> None:
    requirements = make_payment_requirements()
    payload = make_v2_payload()

    stream = _TrackingStream(MAX_CONTROL_PLANE_RESPONSE_BYTES + 1)
    response = httpx.Response(status_code, stream=stream)
    client, send = _error_client([response], as_async)
    args = () if operation == "get_supported" else (payload, requirements)

    with pytest.raises(ResponseBodyTooLargeError):
        await _resolve(getattr(client, operation)(*args))
    assert stream.closed
    assert send.call_count == 1
    assert send.call_args.kwargs == {"stream": True}
