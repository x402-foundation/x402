"""Legacy MCP payment payloads preserve paid results without v2 response contexts."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from x402.mcp.client import x402MCPClientSync, x402MCPSession
from x402.mcp.client_async import x402MCPClient
from x402.mcp.constants import MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY
from x402.schemas import (
    PaymentPayloadV1,
    PaymentRequiredV1,
    PaymentRequirementsV1,
    SettleResponse,
)


def _result(
    *,
    required: PaymentRequiredV1 | None = None,
    settlement: SettleResponse | None = None,
) -> SimpleNamespace:
    meta = (
        {MCP_PAYMENT_RESPONSE_META_KEY: settlement.model_dump(by_alias=True)}
        if settlement is not None
        else {}
    )
    return SimpleNamespace(
        content=[{"type": "text", "text": "paid output"}],
        isError=required is not None,
        structuredContent=required.model_dump(by_alias=True) if required else None,
        meta=meta,
        _meta=meta,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("client_kind", ["session", "sync", "async"])
@pytest.mark.parametrize("is_error", [False, True], ids=["settled", "payment-required"])
async def test_v1_paid_result_preserved_without_v2_response_context(
    client_kind: str, is_error: bool
) -> None:
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
    settlement = (
        SettleResponse(success=True, transaction="0xtx123", network="base-sepolia")
        if not is_error
        else None
    )
    final = _result(required=required if is_error else None, settlement=settlement)
    mock_type = Mock if client_kind == "sync" else AsyncMock
    transport = SimpleNamespace(
        call_tool=mock_type(side_effect=[_result(required=required), final])
    )
    payment = SimpleNamespace(
        create_payment_payload=mock_type(return_value=payload),
        handle_payment_response=mock_type(
            side_effect=AssertionError("v1 payloads have no accepted v2 requirements")
        ),
    )
    wrapper = {
        "session": x402MCPSession,
        "sync": x402MCPClientSync,
        "async": x402MCPClient,
    }[client_kind](transport, payment)

    result = wrapper.call_tool("paid_tool", {})
    if client_kind != "sync":
        result = await result

    payment.create_payment_payload.assert_called_once_with(required)
    payment.handle_payment_response.assert_not_called()
    assert transport.call_tool.call_count == 2
    assert result.content == final.content
    assert result.raw_result.content == final.content
    assert result.payment_response == settlement
    assert result.payment_made is True
    assert result.is_error is is_error
    paid_call = transport.call_tool.call_args_list[1]
    meta = paid_call.kwargs["meta"] if client_kind == "session" else paid_call.args[0]["_meta"]
    assert meta[MCP_PAYMENT_META_KEY] == payload.model_dump(by_alias=True)
