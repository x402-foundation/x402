"""Paid MCP results reach payment response hooks, including one recovery retry."""

from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock, Mock, call

import pytest

from x402.client import x402ClientSync
from x402.mcp.client import x402MCPClientSync, x402MCPSession
from x402.mcp.constants import MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY
from x402.mcp.types import PaymentRequiredError, PaymentRequiredHookResult
from x402.schemas import (
    PaymentPayload,
    PaymentPayloadV1,
    PaymentRequired,
    PaymentRequiredV1,
    PaymentRequirements,
    PaymentRequirementsV1,
    SettleResponse,
)
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
    *,
    required: PaymentRequired | PaymentRequiredV1 | None = None,
    settlement: SettleResponse | None = None,
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
    required: PaymentRequired | PaymentRequiredV1 | None = None,
) -> None:
    assert ctx.payment_payload is payload
    assert ctx.requirements is payload.accepted
    assert ctx.settle_response == settlement
    assert ctx.payment_required == required


@pytest.mark.asyncio
async def test_session_dispatches_successful_payment_response(
    payment_required: PaymentRequired, settlement: SettleResponse
) -> None:
    payload = _payload(payment_required, "0x123")
    final = _result(settlement=settlement)
    session = SimpleNamespace(
        call_tool=AsyncMock(side_effect=[_result(required=payment_required), final])
    )
    payment_client: Any = SimpleNamespace(
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


def test_sync_client_dispatches_successful_payment_response(
    payment_required: PaymentRequired, settlement: SettleResponse
) -> None:
    payload = _payload(payment_required, "0x123")
    final = _result(settlement=settlement)
    mcp_client = SimpleNamespace(
        call_tool=Mock(side_effect=[_result(required=payment_required), final])
    )
    payment_client: Any = SimpleNamespace(
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


def test_sync_explicit_paid_call_dispatches_payment_response(
    payment_required: PaymentRequired, settlement: SettleResponse
) -> None:
    payload = _payload(payment_required, "0x123")
    mcp_client = SimpleNamespace(call_tool=Mock(return_value=_result(settlement=settlement)))
    payment_client: Any = SimpleNamespace(handle_payment_response=Mock(return_value=None))

    result = x402MCPClientSync(mcp_client, payment_client).call_tool_with_payment(
        "paid_tool", {}, payload
    )

    payment_client.handle_payment_response.assert_called_once()
    _assert_context(
        payment_client.handle_payment_response.call_args.args[0], payload, settlement=settlement
    )
    assert mcp_client.call_tool.call_count == 1
    assert result.payment_response == settlement


@pytest.mark.asyncio
async def test_session_recovers_once_and_dispatches_retry_response(
    payment_required: PaymentRequired, settlement: SettleResponse
) -> None:
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
    payment_client: Any = SimpleNamespace(
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


def test_sync_client_recovers_once_and_dispatches_retry_response(
    payment_required: PaymentRequired, settlement: SettleResponse
) -> None:
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
    payment_client: Any = SimpleNamespace(
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
        assert params["_meta"][MCP_PAYMENT_META_KEY] == sent_payload.model_dump(
            by_alias=True, exclude_none=True
        )
    assert payment_client.handle_payment_response.call_count == 2
    first, retry = payment_client.handle_payment_response.call_args_list
    _assert_context(first.args[0], payload, required=corrective)
    _assert_context(retry.args[0], fresh_payload, settlement=settlement)
    assert result.content == final.content
    assert result.payment_response == settlement
    assert result.payment_made is True
    assert result.is_error is False


def test_sync_client_does_not_retry_a_second_corrective_402(
    payment_required: PaymentRequired,
) -> None:
    corrective = payment_required.model_copy(
        update={
            "error": "corrective payment required",
            "accepts": [payment_required.accepts[0].model_copy(update={"amount": "2000"})],
        }
    )
    payload = _payload(payment_required, "0x123")
    fresh_payload = _payload(corrective, "0x456")
    mcp_client = SimpleNamespace(
        call_tool=Mock(
            side_effect=[
                _result(required=payment_required),
                _result(required=corrective),
                _result(required=corrective),
            ]
        )
    )
    payment_client: Any = SimpleNamespace(
        create_payment_payload=Mock(side_effect=[payload, fresh_payload]),
        handle_payment_response=Mock(
            side_effect=[RecoveredResponseResult(), RecoveredResponseResult()]
        ),
    )

    result = x402MCPClientSync(mcp_client, payment_client).call_tool("paid_tool", {})

    assert mcp_client.call_tool.call_count == 3
    assert payment_client.create_payment_payload.call_count == 2
    assert payment_client.handle_payment_response.call_count == 2
    assert result.is_error is True


@pytest.mark.asyncio
async def test_session_does_not_retry_a_second_corrective_402(
    payment_required: PaymentRequired,
) -> None:
    corrective = payment_required.model_copy(
        update={
            "error": "corrective payment required",
            "accepts": [payment_required.accepts[0].model_copy(update={"amount": "2000"})],
        }
    )
    payload = _payload(payment_required, "0x123")
    fresh_payload = _payload(corrective, "0x456")
    session = SimpleNamespace(
        call_tool=AsyncMock(
            side_effect=[
                _result(required=payment_required),
                _result(required=corrective),
                _result(required=corrective),
            ]
        )
    )
    payment_client: Any = SimpleNamespace(
        create_payment_payload=AsyncMock(side_effect=[payload, fresh_payload]),
        handle_payment_response=AsyncMock(
            side_effect=[RecoveredResponseResult(), RecoveredResponseResult()]
        ),
    )

    result = await x402MCPSession(session, payment_client).call_tool("paid_tool", {})

    assert session.call_tool.await_count == 3
    assert payment_client.create_payment_payload.await_count == 2
    assert payment_client.handle_payment_response.await_count == 2
    assert result.is_error is True


def test_sync_client_rechecks_all_payment_gates_before_corrective_retry(
    payment_required: PaymentRequired,
) -> None:
    corrective = payment_required.model_copy(
        update={
            "error": "corrective payment required",
            "accepts": [payment_required.accepts[0].model_copy(update={"amount": "2000"})],
        }
    )
    payload = _payload(payment_required, "0x123")
    fresh_payload = _payload(corrective, "0x456")
    events = []
    results = iter(
        [
            _result(required=payment_required),
            _result(required=corrective),
            _result(),
        ]
    )

    def call_tool(params: Any, **_kwargs: Any) -> SimpleNamespace:
        events.append("paid-call" if "_meta" in params else "probe")
        return next(results)

    def payment_required_hook(ctx: Any) -> PaymentRequiredHookResult:
        events.append(f"payment-required:{ctx.payment_required.accepts[0].amount}")
        return PaymentRequiredHookResult()

    def payment_requested_hook(ctx: Any) -> bool:
        events.append(f"payment-requested:{ctx.payment_required.accepts[0].amount}")
        return True

    def before_payment_hook(ctx: Any) -> None:
        events.append(f"before-payment:{ctx.payment_required.accepts[0].amount}")

    def create_payment_payload(required: Any) -> PaymentPayload:
        events.append(f"create-payload:{required.accepts[0].amount}")
        return payload if required is payment_required else fresh_payload

    def handle_payment_response(ctx: Any) -> RecoveredResponseResult | None:
        amount = ctx.payment_required.accepts[0].amount if ctx.payment_required else "none"
        events.append(f"payment-response:{amount}")
        return RecoveredResponseResult() if ctx.payment_required else None

    client = x402MCPClientSync(
        SimpleNamespace(call_tool=Mock(side_effect=call_tool)),
        cast(
            x402ClientSync,
            SimpleNamespace(
                create_payment_payload=Mock(side_effect=create_payment_payload),
                handle_payment_response=Mock(side_effect=handle_payment_response),
            ),
        ),
        on_payment_requested=payment_requested_hook,
    )
    client.on_payment_required(payment_required_hook)
    client.on_before_payment(before_payment_hook)
    client.on_after_payment(lambda _ctx: events.append("after-payment"))

    result = client.call_tool("paid_tool", {"arg": "value"})

    assert events == [
        "probe",
        "payment-required:1000",
        "payment-requested:1000",
        "before-payment:1000",
        "create-payload:1000",
        "paid-call",
        "after-payment",
        "payment-response:2000",
        "payment-required:2000",
        "payment-requested:2000",
        "before-payment:2000",
        "create-payload:2000",
        "paid-call",
        "after-payment",
        "payment-response:none",
    ]
    assert result.is_error is False
    assert result.payment_made is True


@pytest.mark.parametrize("rejection", ["payment-requested", "payment-required"])
def test_sync_client_rejection_prevents_corrective_payment(
    payment_required: PaymentRequired, rejection: str
) -> None:
    corrective = payment_required.model_copy(
        update={
            "error": "corrective payment required",
            "accepts": [payment_required.accepts[0].model_copy(update={"amount": "2000"})],
        }
    )
    payload = _payload(payment_required, "0x123")
    calls = []
    required_hook_calls = 0
    requested_hook_calls = 0
    mcp_client = SimpleNamespace(
        call_tool=Mock(
            side_effect=[_result(required=payment_required), _result(required=corrective)]
        )
    )
    payment_client: Any = SimpleNamespace(
        create_payment_payload=Mock(return_value=payload),
        handle_payment_response=Mock(return_value=RecoveredResponseResult()),
    )

    def on_payment_requested(ctx: Any) -> bool:
        nonlocal requested_hook_calls
        requested_hook_calls += 1
        calls.append(f"requested:{ctx.payment_required.accepts[0].amount}")
        return rejection != "payment-requested" or requested_hook_calls == 1

    client = x402MCPClientSync(
        mcp_client, payment_client, on_payment_requested=on_payment_requested
    )

    if rejection == "payment-required":

        def payment_required_hook(ctx: Any) -> PaymentRequiredHookResult:
            nonlocal required_hook_calls
            required_hook_calls += 1
            calls.append(f"required:{ctx.payment_required.accepts[0].amount}")
            return PaymentRequiredHookResult(abort=required_hook_calls == 2)

        client.on_payment_required(payment_required_hook)

    client.on_before_payment(
        lambda ctx: calls.append(f"before:{ctx.payment_required.accepts[0].amount}")
    )

    with pytest.raises(PaymentRequiredError):
        client.call_tool("paid_tool", {})

    assert mcp_client.call_tool.call_count == 2
    assert payment_client.create_payment_payload.call_count == 1
    assert payment_client.handle_payment_response.call_count == 1
    assert not any(event == "before:2000" for event in calls)


def test_sync_client_uses_corrective_custom_payment_payload(
    payment_required: PaymentRequired,
) -> None:
    corrective = payment_required.model_copy(
        update={
            "error": "corrective payment required",
            "accepts": [payment_required.accepts[0].model_copy(update={"amount": "2000"})],
        }
    )
    payload = _payload(payment_required, "0x123")
    custom_payload = _payload(corrective, "0xcustom")
    mcp_client = SimpleNamespace(
        call_tool=Mock(
            side_effect=[
                _result(required=payment_required),
                _result(required=corrective),
                _result(),
            ]
        )
    )
    payment_client: Any = SimpleNamespace(
        create_payment_payload=Mock(return_value=payload),
        handle_payment_response=Mock(side_effect=[RecoveredResponseResult(), None]),
    )
    client = x402MCPClientSync(mcp_client, payment_client)
    hook_calls = []
    required_hook_calls = 0

    def payment_required_hook(ctx: Any) -> PaymentRequiredHookResult:
        nonlocal required_hook_calls
        required_hook_calls += 1
        hook_calls.append(ctx.payment_required.accepts[0].amount)
        return (
            PaymentRequiredHookResult(payment=custom_payload)
            if required_hook_calls == 2
            else PaymentRequiredHookResult()
        )

    client.on_payment_required(payment_required_hook)
    client.on_before_payment(lambda _ctx: hook_calls.append("before"))

    result = client.call_tool("paid_tool", {})

    assert hook_calls == ["1000", "before", "2000"]
    assert payment_client.create_payment_payload.call_count == 1
    retry_params = mcp_client.call_tool.call_args_list[2].args[0]
    assert retry_params["_meta"][MCP_PAYMENT_META_KEY] == custom_payload.model_dump(
        by_alias=True, exclude_none=True
    )
    assert result.is_error is False


def test_sync_client_does_not_auto_sign_corrective_terms_when_disabled(
    payment_required: PaymentRequired,
) -> None:
    corrective = payment_required.model_copy(
        update={
            "error": "corrective payment required",
            "accepts": [payment_required.accepts[0].model_copy(update={"amount": "2000"})],
        }
    )
    custom_payload = _payload(payment_required, "0xcustom")
    mcp_client = SimpleNamespace(
        call_tool=Mock(
            side_effect=[_result(required=payment_required), _result(required=corrective)]
        )
    )
    payment_client: Any = SimpleNamespace(
        create_payment_payload=Mock(),
        handle_payment_response=Mock(return_value=RecoveredResponseResult()),
    )
    on_payment_requested = Mock(return_value=True)
    client = x402MCPClientSync(
        mcp_client,
        payment_client,
        auto_payment=False,
        on_payment_requested=on_payment_requested,
    )
    hook_calls = 0

    def payment_required_hook(_ctx: Any) -> PaymentRequiredHookResult:
        nonlocal hook_calls
        hook_calls += 1
        return (
            PaymentRequiredHookResult(payment=custom_payload)
            if hook_calls == 1
            else PaymentRequiredHookResult()
        )

    client.on_payment_required(payment_required_hook)

    with pytest.raises(PaymentRequiredError):
        client.call_tool("paid_tool", {})

    assert mcp_client.call_tool.call_count == 2
    payment_client.create_payment_payload.assert_not_called()
    payment_client.handle_payment_response.assert_called_once()
    on_payment_requested.assert_not_called()


@pytest.mark.asyncio
async def test_session_skips_response_handling_without_accepted_requirements() -> None:
    required = PaymentRequiredV1(
        accepts=[
            PaymentRequirementsV1(
                scheme="exact",
                network="base-sepolia",
                max_amount_required="1000",
                resource="mcp://paid_tool",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
                asset="USDC",
            )
        ]
    )
    payload = PaymentPayloadV1(
        scheme="exact", network="base-sepolia", payload={"signature": "0x123"}
    )
    session = SimpleNamespace(
        call_tool=AsyncMock(side_effect=[_result(required=required), _result(required=required)])
    )
    payment_client: Any = SimpleNamespace(
        create_payment_payload=AsyncMock(return_value=payload),
        handle_payment_response=AsyncMock(),
    )

    result = await x402MCPSession(session, payment_client).call_tool("paid_tool", {})

    payment_client.handle_payment_response.assert_not_awaited()
    payment_client.create_payment_payload.assert_awaited_once_with(required)
    assert session.call_tool.await_count == 2
    assert result.is_error is True


def test_sync_client_skips_response_handling_without_accepted_requirements() -> None:
    required = PaymentRequiredV1(
        accepts=[
            PaymentRequirementsV1(
                scheme="exact",
                network="base-sepolia",
                max_amount_required="1000",
                resource="mcp://paid_tool",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
                asset="USDC",
            )
        ]
    )
    payload = PaymentPayloadV1(
        scheme="exact", network="base-sepolia", payload={"signature": "0x123"}
    )
    mcp_client = SimpleNamespace(
        call_tool=Mock(side_effect=[_result(required=required), _result(required=required)])
    )
    payment_client: Any = SimpleNamespace(
        create_payment_payload=Mock(return_value=payload),
        handle_payment_response=Mock(),
    )

    result = x402MCPClientSync(mcp_client, payment_client).call_tool("paid_tool", {})

    payment_client.handle_payment_response.assert_not_called()
    payment_client.create_payment_payload.assert_called_once_with(required)
    assert mcp_client.call_tool.call_count == 2
    assert result.is_error is True


@pytest.mark.asyncio
async def test_session_propagates_payment_response_handler_failure(
    payment_required: PaymentRequired,
) -> None:
    payload = _payload(payment_required, "0x123")
    session = SimpleNamespace(
        call_tool=AsyncMock(side_effect=[_result(required=payment_required), _result()])
    )
    payment_client: Any = SimpleNamespace(
        create_payment_payload=AsyncMock(return_value=payload),
        handle_payment_response=AsyncMock(side_effect=RuntimeError("response hook failed")),
    )

    with pytest.raises(RuntimeError, match="response hook failed"):
        await x402MCPSession(session, payment_client).call_tool("paid_tool", {})

    assert session.call_tool.await_count == 2
    payment_client.handle_payment_response.assert_awaited_once()


def test_sync_client_propagates_payment_response_handler_failure(
    payment_required: PaymentRequired,
) -> None:
    payload = _payload(payment_required, "0x123")
    mcp_client = SimpleNamespace(
        call_tool=Mock(side_effect=[_result(required=payment_required), _result()])
    )
    payment_client: Any = SimpleNamespace(
        create_payment_payload=Mock(return_value=payload),
        handle_payment_response=Mock(side_effect=RuntimeError("response hook failed")),
    )

    with pytest.raises(RuntimeError, match="response hook failed"):
        x402MCPClientSync(mcp_client, payment_client).call_tool("paid_tool", {})

    assert mcp_client.call_tool.call_count == 2
    payment_client.handle_payment_response.assert_called_once()


@pytest.mark.asyncio
async def test_session_propagates_paid_call_timeout(payment_required: PaymentRequired) -> None:
    payload = _payload(payment_required, "0x123")
    session = SimpleNamespace(
        call_tool=AsyncMock(side_effect=[_result(required=payment_required), TimeoutError])
    )
    payment_client: Any = SimpleNamespace(create_payment_payload=AsyncMock(return_value=payload))

    with pytest.raises(TimeoutError):
        await x402MCPSession(session, payment_client).call_tool("paid_tool", {})

    assert session.call_tool.await_count == 2


def test_sync_client_propagates_paid_call_timeout(payment_required: PaymentRequired) -> None:
    payload = _payload(payment_required, "0x123")
    mcp_client = SimpleNamespace(
        call_tool=Mock(side_effect=[_result(required=payment_required), TimeoutError])
    )
    payment_client: Any = SimpleNamespace(create_payment_payload=Mock(return_value=payload))

    with pytest.raises(TimeoutError):
        x402MCPClientSync(mcp_client, payment_client).call_tool("paid_tool", {})

    assert mcp_client.call_tool.call_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled", [True, False])
async def test_public_async_corrective_authorization(
    payment_required: PaymentRequired, enabled: bool
) -> None:
    from x402.mcp.client_async import x402MCPClient

    payload = _payload(payment_required, "first")
    transport = SimpleNamespace(
        call_tool=AsyncMock(side_effect=[_result(required=payment_required), _result()])
    )
    payer: Any = SimpleNamespace(
        handle_payment_response=AsyncMock(return_value=RecoveredResponseResult()),
        create_payment_payload=AsyncMock(return_value=payload),
    )
    approval = Mock(return_value=True)
    client = x402MCPClient(transport, payer, auto_payment=enabled, on_payment_requested=approval)
    if enabled:
        await client.call_tool_with_payment("paid", {}, payload)
        assert transport.call_tool.await_count == 2
        assert payer.handle_payment_response.await_count == 2
        approval.assert_called_once()
    else:
        with pytest.raises(PaymentRequiredError):
            await client.call_tool_with_payment("paid", {}, payload)
        payer.create_payment_payload.assert_not_awaited()
        assert transport.call_tool.await_count == 1
