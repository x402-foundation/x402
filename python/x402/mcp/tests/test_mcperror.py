"""Tests for payment challenges raised as MCP JSON-RPC errors.

Servers may signal payment with a raised error (code 402 or SEP-1036 -32042)
instead of an isError result. The Python MCP SDK raises these as
``McpError(ErrorData(...))``, with code and data under ``.error``.
"""

from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest
from mcp.shared.exceptions import McpError

from mcp.types import ErrorData
from x402.mcp import PaymentRequiredError, x402MCPClient
from x402.mcp.client import x402MCPClientSync, x402MCPSession
from x402.mcp.types import PaymentRequiredHookResult
from x402.mcp.utils import extract_payment_required_from_error
from x402.schemas import PaymentPayload

PAYMENT_REQUIRED_DATA = {
    "x402Version": 2,
    "accepts": [
        {
            "scheme": "exact",
            "network": "eip155:84532",
            "amount": "1000",
            "asset": "USDC",
            "payTo": "0xrecipient",
            "maxTimeoutSeconds": 300,
        }
    ],
}

PAYMENT_PAYLOAD = PaymentPayload(
    x402_version=2,
    accepted=PAYMENT_REQUIRED_DATA["accepts"][0],
    payload={"signature": "0xabc"},
)


def payment_error(code: int = -32042, data=None) -> McpError:
    if data is None:
        data = {"x402": PAYMENT_REQUIRED_DATA}
    return McpError(ErrorData(code=code, message="Payment required", data=data))


class FlatError(Exception):
    """Exception exposing code/data directly, as some transport adapters do."""

    def __init__(self, code, data=None):
        super().__init__("flat error")
        self.code = code
        self.data = data


class MockResult:
    def __init__(self):
        self.content = [{"type": "text", "text": "ok"}]
        self.isError = False
        self._meta = {}
        self.meta = None
        self.structuredContent = None


def make_client(kind: str, **options):
    if kind == "sync":
        transport = MagicMock()
        payment = MagicMock()
        payment.create_payment_payload = MagicMock(return_value=PAYMENT_PAYLOAD)
        return x402MCPClientSync(transport, payment, **options), transport, payment
    transport = MagicMock()
    transport.call_tool = AsyncMock()
    payment = MagicMock()
    payment.create_payment_payload = AsyncMock(return_value=PAYMENT_PAYLOAD)
    if kind == "session":
        return x402MCPSession(transport, payment, **options), transport, payment
    return x402MCPClient(transport, payment, **options), transport, payment


async def call(client, *args, **kwargs):
    result = client.call_tool(*args, **kwargs)
    return await result if hasattr(result, "__await__") else result


# ---------------------------------------------------------------------------
# extract_payment_required_from_error
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("code", [402, -32042])
@pytest.mark.parametrize("namespaced", [False, True])
def test_extracts_from_sdk_mcp_error(code, namespaced):
    data = {"x402": PAYMENT_REQUIRED_DATA} if namespaced else PAYMENT_REQUIRED_DATA
    pr = extract_payment_required_from_error(payment_error(code, data))
    assert pr is not None
    assert pr.accepts[0].amount == "1000"


@pytest.mark.parametrize(
    "error",
    [
        FlatError(-32042, PAYMENT_REQUIRED_DATA),
        {"code": -32042, "data": PAYMENT_REQUIRED_DATA},
        {"code": 402, "data": {"x402": PAYMENT_REQUIRED_DATA}},
    ],
)
def test_extracts_from_flat_errors_and_dicts(error):
    assert extract_payment_required_from_error(error) is not None


@pytest.mark.parametrize(
    "error",
    [
        payment_error(-32603, PAYMENT_REQUIRED_DATA),
        payment_error(-32042, {"foo": "bar"}),
        McpError(ErrorData(code=-32042, message="Payment required")),
        FlatError(-32042, {}),
        FlatError("402", PAYMENT_REQUIRED_DATA),
        FlatError(True, PAYMENT_REQUIRED_DATA),
        Exception("boom"),
        None,
    ],
)
def test_ignores_non_payment_errors(error):
    assert extract_payment_required_from_error(error) is None


# ---------------------------------------------------------------------------
# Client flows
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("kind", ["sync", "async", "session"])
@pytest.mark.parametrize("override_seconds", [None, 7])
@pytest.mark.asyncio
async def test_raised_challenge_pays_and_retries_once(kind, override_seconds):
    client, transport, payment = make_client(kind, max_request_timeout_seconds=60)
    transport.call_tool.side_effect = [payment_error(), MockResult()]
    kwargs = (
        {"read_timeout_seconds": timedelta(seconds=override_seconds)} if override_seconds else {}
    )

    result = await call(client, "paid_tool", {"input": "kept"}, **kwargs)

    assert result.payment_made is True
    assert transport.call_tool.call_count == 2
    payment.create_payment_payload.assert_called_once()
    expected_timeout = timedelta(seconds=override_seconds or 60)
    first, second = transport.call_tool.call_args_list
    assert first.kwargs["read_timeout_seconds"] == expected_timeout
    assert second.kwargs["read_timeout_seconds"] == expected_timeout
    if kind == "session":
        assert second.kwargs["arguments"] == {"input": "kept"}
        assert "x402/payment" in second.kwargs["meta"]
    else:
        assert second.args[0]["arguments"] == {"input": "kept"}
        assert "x402/payment" in second.args[0]["_meta"]


@pytest.mark.parametrize("kind", ["sync", "async", "session"])
@pytest.mark.asyncio
async def test_non_payment_error_propagates(kind):
    client, transport, payment = make_client(kind)
    error = payment_error(-32603, PAYMENT_REQUIRED_DATA)
    transport.call_tool.side_effect = error

    with pytest.raises(McpError) as exc_info:
        await call(client, "tool", {})

    assert exc_info.value is error
    assert transport.call_tool.call_count == 1
    payment.create_payment_payload.assert_not_called()


@pytest.mark.parametrize("kind", ["sync", "async", "session"])
@pytest.mark.filterwarnings("ignore:x402MCPClient")
@pytest.mark.asyncio
async def test_raised_challenge_with_auto_payment_disabled_does_not_pay(kind):
    client, transport, payment = make_client(kind, auto_payment=False)
    transport.call_tool.side_effect = payment_error()

    with pytest.raises(PaymentRequiredError):
        await call(client, "tool", {})

    assert transport.call_tool.call_count == 1
    payment.create_payment_payload.assert_not_called()


@pytest.mark.parametrize("kind", ["sync", "async"])
@pytest.mark.asyncio
async def test_raised_challenge_goes_through_approval_hooks(kind):
    calls = []
    client, transport, payment = make_client(
        kind,
        on_payment_requested=lambda ctx: calls.append(("approve", ctx.tool_name)) or True,
    )
    client.on_payment_required(lambda ctx: calls.append(("required", ctx.tool_name)))
    client.on_before_payment(lambda ctx: calls.append(("before", ctx.tool_name)))
    client.on_after_payment(lambda ctx: calls.append(("after", ctx.tool_name)))
    transport.call_tool.side_effect = [payment_error(), MockResult()]

    result = await call(client, "paid_tool", {})

    assert result.payment_made is True
    assert calls == [
        ("required", "paid_tool"),
        ("approve", "paid_tool"),
        ("before", "paid_tool"),
        ("after", "paid_tool"),
    ]


@pytest.mark.parametrize("kind", ["sync", "async"])
@pytest.mark.asyncio
async def test_raised_challenge_denied_or_aborted_does_not_pay(kind):
    client, transport, payment = make_client(kind, on_payment_requested=lambda ctx: False)
    transport.call_tool.side_effect = payment_error()
    with pytest.raises(PaymentRequiredError, match="denied"):
        await call(client, "tool", {})

    client, transport, payment = make_client(kind)
    client.on_payment_required(lambda ctx: PaymentRequiredHookResult(abort=True))
    transport.call_tool.side_effect = payment_error()
    with pytest.raises(PaymentRequiredError, match="aborted"):
        await call(client, "tool", {})
    payment.create_payment_payload.assert_not_called()


@pytest.mark.parametrize("kind", ["sync", "async"])
@pytest.mark.asyncio
async def test_get_tool_payment_requirements_from_raised_challenge(kind):
    client, transport, _ = make_client(kind)
    transport.call_tool.side_effect = payment_error()
    pr = client.get_tool_payment_requirements("tool", {})
    pr = await pr if hasattr(pr, "__await__") else pr
    assert pr is not None
    assert pr.accepts[0].amount == "1000"

    transport.call_tool.side_effect = payment_error(-32603, PAYMENT_REQUIRED_DATA)
    with pytest.raises(McpError):
        pr = client.get_tool_payment_requirements("tool", {})
        await pr if hasattr(pr, "__await__") else pr
