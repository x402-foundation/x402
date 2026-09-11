"""MCP client tool-call timeouts follow accept maxTimeoutSeconds."""

from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from x402.mcp.client import x402MCPClientSync, x402MCPSession
from x402.mcp.client_async import x402MCPClient
from x402.schemas import PaymentPayload


def _payment_required_text(max_timeout_seconds: int = 300) -> str:
    return (
        '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532",'
        f'"amount":"1000","asset":"USDC","payTo":"0xrecipient",'
        f'"maxTimeoutSeconds":{max_timeout_seconds}}}]}}'
    )


def _payload(max_timeout_seconds: int = 300) -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        accepted={
            "scheme": "exact",
            "network": "eip155:84532",
            "amount": "1000",
            "asset": "USDC",
            "pay_to": "0xrecipient",
            "max_timeout_seconds": max_timeout_seconds,
        },
        payload={"signature": "0x123"},
    )


class _Text:
    def __init__(self, text: str) -> None:
        self.text = text


class _SessionResult:
    def __init__(self, *, is_error: bool, text: str, meta: dict | None = None) -> None:
        self.isError = is_error
        self.content = [_Text(text)]
        self.meta = meta
        self.structuredContent = None


class _McpResult:
    def __init__(self, *, is_error: bool, text: str, meta: dict | None = None) -> None:
        self.content = [{"type": "text", "text": text}]
        self.isError = is_error
        self._meta = meta or {}
        self.structuredContent = None


def _read_timeout(call) -> timedelta:
    return call.kwargs["read_timeout_seconds"]


@pytest.mark.asyncio
async def test_session_probe_uses_300s_ceiling() -> None:
    session = SimpleNamespace(
        call_tool=AsyncMock(return_value=_SessionResult(is_error=False, text="pong"))
    )
    x402_client = SimpleNamespace(create_payment_payload=AsyncMock())

    result = await x402MCPSession(session, x402_client).call_tool("ping", {})

    assert result.payment_made is False
    assert result.content[0].text == "pong"
    assert _read_timeout(session.call_tool.await_args) == timedelta(seconds=300)
    x402_client.create_payment_payload.assert_not_called()


@pytest.mark.asyncio
async def test_session_paid_timeout_uses_accept_max_timeout_seconds() -> None:
    session = SimpleNamespace(
        call_tool=AsyncMock(
            side_effect=[
                _SessionResult(is_error=True, text=_payment_required_text(600)),
                _SessionResult(is_error=False, text="ok"),
            ]
        )
    )
    x402_client = SimpleNamespace(create_payment_payload=AsyncMock(return_value=_payload(600)))

    result = await x402MCPSession(session, x402_client).call_tool("paid_tool", {})

    assert result.payment_made is True
    assert result.content[0].text == "ok"
    probe_call, paid_call = session.call_tool.await_args_list
    assert _read_timeout(probe_call) == timedelta(seconds=300)
    assert _read_timeout(paid_call) == timedelta(seconds=600)


@pytest.mark.asyncio
async def test_session_paid_timeout_defaults_to_300s_without_accept() -> None:
    session = SimpleNamespace(
        call_tool=AsyncMock(
            side_effect=[
                _SessionResult(is_error=True, text=_payment_required_text()),
                _SessionResult(is_error=False, text="ok"),
            ]
        )
    )
    payload = SimpleNamespace(accepted=None, model_dump=lambda **_kwargs: {"payload": {}})
    x402_client = SimpleNamespace(create_payment_payload=AsyncMock(return_value=payload))

    result = await x402MCPSession(session, x402_client).call_tool("paid_tool", {})

    assert result.payment_made is True
    probe_call, paid_call = session.call_tool.await_args_list
    assert _read_timeout(probe_call) == timedelta(seconds=300)
    assert _read_timeout(paid_call) == timedelta(seconds=300)


@pytest.mark.asyncio
async def test_session_explicit_timeout_overrides_accept() -> None:
    session = SimpleNamespace(
        call_tool=AsyncMock(
            side_effect=[
                _SessionResult(is_error=True, text=_payment_required_text(600)),
                _SessionResult(is_error=False, text="ok"),
            ]
        )
    )
    x402_client = SimpleNamespace(create_payment_payload=AsyncMock(return_value=_payload(600)))
    override = timedelta(seconds=12)

    await x402MCPSession(session, x402_client).call_tool(
        "paid_tool", {}, read_timeout_seconds=override
    )

    probe_call, paid_call = session.call_tool.await_args_list
    assert _read_timeout(probe_call) == override
    assert _read_timeout(paid_call) == override


@pytest.mark.asyncio
async def test_async_client_probe_uses_300s_ceiling() -> None:
    mock_mcp = SimpleNamespace(
        call_tool=AsyncMock(return_value=_McpResult(is_error=False, text="pong"))
    )
    mock_payment = SimpleNamespace(create_payment_payload=AsyncMock())

    result = await x402MCPClient(mock_mcp, mock_payment).call_tool("ping", {})

    assert result.payment_made is False
    assert result.content[0]["text"] == "pong"
    assert mock_mcp.call_tool.await_args.kwargs["read_timeout_seconds"] == timedelta(seconds=300)
    mock_payment.create_payment_payload.assert_not_called()


@pytest.mark.asyncio
async def test_async_client_paid_timeout_uses_accept_max_timeout_seconds() -> None:
    mock_mcp = SimpleNamespace(
        call_tool=AsyncMock(
            side_effect=[
                _McpResult(is_error=True, text=_payment_required_text(600)),
                _McpResult(is_error=False, text="ok"),
            ]
        )
    )
    mock_payment = SimpleNamespace(create_payment_payload=AsyncMock(return_value=_payload(600)))

    result = await x402MCPClient(mock_mcp, mock_payment).call_tool("paid_tool", {})

    assert result.payment_made is True
    probe_call, paid_call = mock_mcp.call_tool.await_args_list
    assert probe_call.kwargs["read_timeout_seconds"] == timedelta(seconds=300)
    assert paid_call.kwargs["read_timeout_seconds"] == timedelta(seconds=600)


@pytest.mark.asyncio
async def test_async_client_call_tool_with_payment_uses_accept_timeout() -> None:
    mock_mcp = SimpleNamespace(
        call_tool=AsyncMock(return_value=_McpResult(is_error=False, text="ok"))
    )
    mock_payment = SimpleNamespace(create_payment_payload=AsyncMock())

    await x402MCPClient(mock_mcp, mock_payment).call_tool_with_payment(
        "paid_tool", {}, _payload(90)
    )

    assert mock_mcp.call_tool.await_args.kwargs["read_timeout_seconds"] == timedelta(seconds=90)


def test_sync_client_paid_timeout_uses_accept_max_timeout_seconds() -> None:
    mock_mcp = SimpleNamespace(
        call_tool=Mock(
            side_effect=[
                _McpResult(is_error=True, text=_payment_required_text(600)),
                _McpResult(is_error=False, text="ok"),
            ]
        )
    )
    mock_payment = SimpleNamespace(create_payment_payload=Mock(return_value=_payload(600)))

    result = x402MCPClientSync(mock_mcp, mock_payment).call_tool("paid_tool", {})

    assert result.payment_made is True
    probe_call, paid_call = mock_mcp.call_tool.call_args_list
    assert probe_call.kwargs["read_timeout_seconds"] == timedelta(seconds=300)
    assert paid_call.kwargs["read_timeout_seconds"] == timedelta(seconds=600)
