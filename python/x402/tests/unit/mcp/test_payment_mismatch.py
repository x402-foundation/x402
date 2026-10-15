"""Refuse auto-pay when MCP payment-required objects disagree."""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from x402.mcp import PaymentRequiredMismatchError
from x402.mcp.client import x402MCPSession
from x402.mcp.types import MCPToolResult
from x402.mcp.utils import extract_payment_required_from_result
from x402.schemas import PaymentRequired


def _terms(amount: str, pay_to: str) -> PaymentRequired:
    return PaymentRequired(
        x402_version=2,
        accepts=[
            {
                "scheme": "exact",
                "network": "eip155:84532",
                "amount": amount,
                "asset": "USDC",
                "payTo": pay_to,
                "maxTimeoutSeconds": 300,
            }
        ],
    )


def _dump(terms: PaymentRequired) -> dict:
    return terms.model_dump(by_alias=True)


def test_collected_extract_refuses_disagreeing_objects() -> None:
    structured = _terms("1000", "0xrecipient")
    text_terms = _terms("999999", "0xother")
    result = MCPToolResult(
        content=[{"type": "text", "text": json.dumps(_dump(text_terms))}],
        is_error=True,
        structured_content=_dump(structured),
    )
    with pytest.raises(PaymentRequiredMismatchError):
        extract_payment_required_from_result(result)


def test_content_after_first_item_and_fastmcp_wrapper_still_refuse() -> None:
    structured = _terms("1000", "0xrecipient")
    other = json.dumps(_dump(_terms("999999", "0xother")))
    wrapped = f"Error executing tool get_weather: {other}"
    result = MCPToolResult(
        content=[
            {"type": "text", "text": "tool failed"},
            {"type": "text", "text": wrapped},
        ],
        is_error=True,
        structured_content=_dump(structured),
    )
    with pytest.raises(PaymentRequiredMismatchError):
        extract_payment_required_from_result(result)


@pytest.mark.asyncio
async def test_session_call_tool_does_not_sign_when_objects_disagree() -> None:
    structured = _terms("1000", "0xrecipient")
    text_terms = _terms("999999", "0xother")
    probe = SimpleNamespace(
        isError=True,
        content=[SimpleNamespace(text=json.dumps(_dump(text_terms)))],
        structuredContent=_dump(structured),
        meta=None,
    )
    session = SimpleNamespace(call_tool=AsyncMock(return_value=probe))
    x402_client = SimpleNamespace(create_payment_payload=AsyncMock())

    with pytest.raises(PaymentRequiredMismatchError):
        await x402MCPSession(session, x402_client).call_tool("get_weather", {})

    x402_client.create_payment_payload.assert_not_called()
    session.call_tool.assert_awaited_once()
