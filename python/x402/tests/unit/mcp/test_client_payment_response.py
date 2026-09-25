"""Paid MCP results reach payment response hooks, including one recovery retry."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, call

import pytest

from x402.mcp.client import x402MCPClientSync, x402MCPSession
from x402.mcp.constants import MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY
from x402.schemas import PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse
from x402.schemas.hooks import PaymentResponseContext, RecoveredResponseResult


@pytest.fixture
def payment_required() -> PaymentRequired:
    return PaymentRequired(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ]
    )


@pytest.fixture
def settlement() -> SettleResponse:
    return SettleResponse(success=True, transaction="0xtx123", network="eip155:84532")


def _payload(required: PaymentRequired, signature: str) -> PaymentPayload:
    return PaymentPayload(accepted=required.accepts[0], payload={"signature": signature})


def _result(
    *, required: PaymentRequired | None = None, settlement: SettleResponse | None = None
) -> SimpleNamespace:
    meta = (
        {MCP_PAYMENT_RESPONSE_META_KEY: settlement.model_dump(by_alias=True)}
        if settlement is not None
        else {}
    )
    return SimpleNamespace(
        content=[{"type": "text", "text": "payment required" if required else "final result"}],
        isError=required is not None,
        structuredContent=required.model_dump(by_alias=True) if required else None,
        meta=meta,
        _meta=meta,
    )


def _assert_context(
    ctx: PaymentResponseContext,
    payload: PaymentPayload,
    *,
    settlement: SettleResponse | None = None,
    required: PaymentRequired | None = None,
) -> None:
    assert ctx.payment_payload is payload
    assert ctx.requirements is payload.accepted
    assert ctx.settle_response == settlement
    assert ctx.payment_required == required


@pytest.mark.asyncio
async def test_session_dispatches_successful_payment_response(payment_required, settlement):
    payload = _payload(payment_required, "0x123")
    final = _result(settlement=settlement)
    session = SimpleNamespace(
        call_tool=AsyncMock(side_effect=[_result(required=payment_required), final])
    )
    payment_client = SimpleNamespace(
        create_payment_payload=AsyncMock(return_value=payload),
        handle_payment_response=AsyncMock(return_value=None),
    )

    result = await x402MCPSession(session, payment_client).call_tool("paid_tool", {})

    payment_client.handle_payment_response.assert_awaited_once()
    _assert_context(
        payment_client.handle_payment_response.await_args.args[0], payload, settlement=settlement
    )
    assert session.call_tool.await_count == 2
    assert result.content == final.content
    assert result.payment_response == settlement
    assert result.payment_made is True
    assert result.is_error is False


def test_sync_client_dispatches_successful_payment_response(payment_required, settlement):
    payload = _payload(payment_required, "0x123")
    final = _result(settlement=settlement)
    mcp_client = SimpleNamespace(
        call_tool=Mock(side_effect=[_result(required=payment_required), final])
    )
    payment_client = SimpleNamespace(
        create_payment_payload=Mock(return_value=payload),
        handle_payment_response=Mock(return_value=None),
    )

    result = x402MCPClientSync(mcp_client, payment_client).call_tool("paid_tool", {})

    payment_client.handle_payment_response.assert_called_once()
    _assert_context(
        payment_client.handle_payment_response.call_args.args[0], payload, settlement=settlement
    )
    assert mcp_client.call_tool.call_count == 2
    assert result.content == final.content
    assert result.payment_response == settlement
    assert result.payment_made is True
    assert result.is_error is False


@pytest.mark.asyncio
async def test_session_recovers_once_and_dispatches_retry_response(payment_required, settlement):
    corrective = payment_required.model_copy(
        update={
            "error": "corrective payment required",
            "accepts": [payment_required.accepts[0].model_copy(update={"amount": "2000"})],
        }
    )
    payload = _payload(payment_required, "0x123")
    fresh_payload = _payload(corrective, "0x456")
    final = _result(settlement=settlement)
    session = SimpleNamespace(
        call_tool=AsyncMock(
            side_effect=[_result(required=payment_required), _result(required=corrective), final]
        )
    )
    payment_client = SimpleNamespace(
        create_payment_payload=AsyncMock(side_effect=[payload, fresh_payload]),
        handle_payment_response=AsyncMock(side_effect=[RecoveredResponseResult(), None]),
    )

    result = await x402MCPSession(session, payment_client).call_tool("paid_tool", {"key": "value"})

    assert payment_client.create_payment_payload.await_args_list == [
        call(payment_required),
        call(corrective),
    ]
    assert session.call_tool.await_count == 3
    for paid_call, sent_payload in zip(
        session.call_tool.await_args_list[1:], (payload, fresh_payload), strict=True
    ):
        assert paid_call.kwargs["name"] == "paid_tool"
        assert paid_call.kwargs["arguments"] == {"key": "value"}
        assert paid_call.kwargs["meta"][MCP_PAYMENT_META_KEY] == sent_payload.model_dump(
            by_alias=True
        )
    assert payment_client.handle_payment_response.await_count == 2
    first, retry = payment_client.handle_payment_response.await_args_list
    _assert_context(first.args[0], payload, required=corrective)
    _assert_context(retry.args[0], fresh_payload, settlement=settlement)
    assert result.content == final.content
    assert result.payment_response == settlement
    assert result.payment_made is True
    assert result.is_error is False


def test_sync_client_recovers_once_and_dispatches_retry_response(payment_required, settlement):
    corrective = payment_required.model_copy(
        update={
            "error": "corrective payment required",
            "accepts": [payment_required.accepts[0].model_copy(update={"amount": "2000"})],
        }
    )
    payload = _payload(payment_required, "0x123")
    fresh_payload = _payload(corrective, "0x456")
    final = _result(settlement=settlement)
    mcp_client = SimpleNamespace(
        call_tool=Mock(
            side_effect=[_result(required=payment_required), _result(required=corrective), final]
        )
    )
    payment_client = SimpleNamespace(
        create_payment_payload=Mock(side_effect=[payload, fresh_payload]),
        handle_payment_response=Mock(side_effect=[RecoveredResponseResult(), None]),
    )

    result = x402MCPClientSync(mcp_client, payment_client).call_tool("paid_tool", {"key": "value"})

    assert payment_client.create_payment_payload.call_args_list == [
        call(payment_required),
        call(corrective),
    ]
    assert mcp_client.call_tool.call_count == 3
    for paid_call, sent_payload in zip(
        mcp_client.call_tool.call_args_list[1:], (payload, fresh_payload), strict=True
    ):
        params = paid_call.args[0]
        assert params["name"] == "paid_tool"
        assert params["arguments"] == {"key": "value"}
        assert params["_meta"][MCP_PAYMENT_META_KEY] == sent_payload.model_dump(by_alias=True)
    assert payment_client.handle_payment_response.call_count == 2
    first, retry = payment_client.handle_payment_response.call_args_list
    _assert_context(first.args[0], payload, required=corrective)
    _assert_context(retry.args[0], fresh_payload, settlement=settlement)
    assert result.content == final.content
    assert result.payment_response == settlement
    assert result.payment_made is True
    assert result.is_error is False
