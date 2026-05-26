"""Unit tests for async MCP client wrapper."""

from unittest.mock import AsyncMock

import pytest

from x402.mcp import PaymentRequiredError, x402MCPClient
from x402.schemas import PaymentPayload, PaymentRequired


class MockAsyncMCPResult:
    """Mock MCP result for free tool."""

    def __init__(self, content=None, is_error=False, meta=None, structured_content=None):
        self.content = content or [{"type": "text", "text": "pong"}]
        self.isError = is_error
        self._meta = meta or {}
        self.structuredContent = structured_content


class MockAsyncMCPClient:
    """Mock async MCP client for testing."""

    def __init__(self):
        self.call_tool = AsyncMock()
        self.connect = AsyncMock()
        self.close = AsyncMock()
        self.list_tools = AsyncMock(return_value={"tools": []})
        self.list_resources = AsyncMock(return_value={"resources": []})
        self.read_resource = AsyncMock(return_value={"content": []})


class MockAsyncPaymentClient:
    """Mock async payment client for testing."""

    def __init__(self):
        self.create_payment_payload = AsyncMock()


@pytest.mark.asyncio
async def test_x402_mcp_client_async_free_tool():
    """Test calling a free tool (no payment required) with async client."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    mock_mcp.call_tool.return_value = MockAsyncMCPResult()

    client = x402MCPClient(mock_mcp, mock_payment, auto_payment=True)
    result = await client.call_tool("ping", {})

    assert result.payment_made is False
    assert result.is_error is False
    assert len(result.content) > 0
    mock_payment.create_payment_payload.assert_not_called()


@pytest.mark.asyncio
async def test_x402_mcp_client_async_payment_required_auto_payment():
    """Test calling a paid tool with auto-payment enabled (async)."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    # First call returns payment required
    payment_required_result = MockAsyncMCPResult(
        content=[
            {
                "type": "text",
                "text": '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532","amount":"1000","asset":"USDC","payTo":"0xrecipient","maxTimeoutSeconds":300}]}',
            }
        ],
        is_error=True,
    )

    # Second call returns success with payment response
    success_result = MockAsyncMCPResult(
        content=[{"type": "text", "text": "success"}],
        meta={
            "x402/payment-response": {
                "success": True,
                "transaction": "0xtx",
                "network": "eip155:84532",
            }
        },
    )

    mock_mcp.call_tool.side_effect = [payment_required_result, success_result]

    mock_payment.create_payment_payload.return_value = PaymentPayload(
        x402_version=2,
        accepted={
            "scheme": "exact",
            "network": "eip155:84532",
            "amount": "1000",
            "asset": "USDC",
            "pay_to": "0xrecipient",
            "max_timeout_seconds": 300,
        },
        payload={"signature": "0x123"},
    )

    client = x402MCPClient(mock_mcp, mock_payment, auto_payment=True)
    result = await client.call_tool("paid_tool", {})

    assert result.payment_made is True
    assert result.payment_response is not None
    assert result.payment_response.success is True
    assert mock_payment.create_payment_payload.called


@pytest.mark.asyncio
async def test_x402_mcp_client_async_payment_required_no_auto_payment():
    """Test calling a paid tool with auto-payment disabled (async)."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    payment_required_result = MockAsyncMCPResult(
        content=[
            {
                "type": "text",
                "text": '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532","amount":"1000","asset":"USDC","payTo":"0xrecipient","maxTimeoutSeconds":300}]}',
            }
        ],
        is_error=True,
    )

    mock_mcp.call_tool.return_value = payment_required_result

    client = x402MCPClient(mock_mcp, mock_payment, auto_payment=False)

    with pytest.raises(PaymentRequiredError) as exc_info:
        await client.call_tool("paid_tool", {})

    assert exc_info.value.code == 402
    assert exc_info.value.payment_required is not None
    mock_payment.create_payment_payload.assert_not_called()


@pytest.mark.asyncio
async def test_x402_mcp_client_async_hooks():
    """Test async client hooks are called."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    # First call returns payment required
    payment_required_result = MockAsyncMCPResult(
        content=[
            {
                "type": "text",
                "text": '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532","amount":"1000","asset":"USDC","payTo":"0xrecipient","maxTimeoutSeconds":300}]}',
            }
        ],
        is_error=True,
    )

    # Second call returns success
    success_result = MockAsyncMCPResult(
        content=[{"type": "text", "text": "success"}],
        meta={"x402/payment-response": {"success": True}},
    )

    mock_mcp.call_tool.side_effect = [payment_required_result, success_result]

    mock_payment.create_payment_payload.return_value = PaymentPayload(
        x402_version=2,
        accepted={
            "scheme": "exact",
            "network": "eip155:84532",
            "amount": "1000",
            "asset": "USDC",
            "pay_to": "0xrecipient",
            "max_timeout_seconds": 300,
        },
        payload={"signature": "0x123"},
    )

    before_called = []
    after_called = []

    client = x402MCPClient(mock_mcp, mock_payment, auto_payment=True)

    # Register sync hooks (async client supports both sync and async hooks)
    client.on_before_payment(lambda ctx: before_called.append(ctx))
    client.on_after_payment(lambda ctx: after_called.append(ctx))

    await client.call_tool("paid_tool", {})

    assert len(before_called) > 0
    assert len(after_called) > 0


@pytest.mark.asyncio
async def test_x402_mcp_client_async_hooks_async():
    """Test async client with truly async hooks."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    # First call returns payment required
    payment_required_result = MockAsyncMCPResult(
        content=[
            {
                "type": "text",
                "text": '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532","amount":"1000","asset":"USDC","payTo":"0xrecipient","maxTimeoutSeconds":300}]}',
            }
        ],
        is_error=True,
    )

    # Second call returns success
    success_result = MockAsyncMCPResult(
        content=[{"type": "text", "text": "success"}],
        meta={"x402/payment-response": {"success": True}},
    )

    mock_mcp.call_tool.side_effect = [payment_required_result, success_result]

    mock_payment.create_payment_payload.return_value = PaymentPayload(
        x402_version=2,
        accepted={
            "scheme": "exact",
            "network": "eip155:84532",
            "amount": "1000",
            "asset": "USDC",
            "pay_to": "0xrecipient",
            "max_timeout_seconds": 300,
        },
        payload={"signature": "0x123"},
    )

    before_called = []
    after_called = []

    client = x402MCPClient(mock_mcp, mock_payment, auto_payment=True)

    # Register async hooks
    async def async_before_hook(ctx):
        before_called.append(ctx)

    async def async_after_hook(ctx):
        after_called.append(ctx)

    client.on_before_payment(async_before_hook)
    client.on_after_payment(async_after_hook)

    await client.call_tool("paid_tool", {})

    assert len(before_called) > 0
    assert len(after_called) > 0


@pytest.mark.asyncio
async def test_wrap_mcp_client_with_payment_async():
    """Test wrap_mcp_client_with_payment_async factory function."""
    from x402.mcp import wrap_mcp_client_with_payment

    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    client = wrap_mcp_client_with_payment(mock_mcp, mock_payment, auto_payment=True)
    assert isinstance(client, x402MCPClient)
    assert client.client == mock_mcp
    assert client.payment_client == mock_payment


@pytest.mark.asyncio
async def test_x402_mcp_client_async_payment_client():
    """Test accessing payment client property."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    client = x402MCPClient(mock_mcp, mock_payment, auto_payment=True)

    assert client.payment_client == mock_payment


@pytest.mark.asyncio
async def test_x402_mcp_client_async_call_tool_with_payment():
    """Test calling tool with explicit payment payload (async)."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    settle_response = {
        "success": True,
        "transaction": "0xtxhash123",
        "network": "eip155:84532",
    }

    mock_mcp.call_tool.return_value = MockAsyncMCPResult(
        content=[{"type": "text", "text": "success"}],
        meta={"x402/payment-response": settle_response},
    )

    client = x402MCPClient(mock_mcp, mock_payment, auto_payment=True)

    payload = PaymentPayload(
        x402_version=2,
        accepted={
            "scheme": "exact",
            "network": "eip155:84532",
            "amount": "1000",
            "asset": "USDC",
            "payTo": "0xrecipient",
            "maxTimeoutSeconds": 300,
        },
        payload={"signature": "0x123"},
    )

    result = await client.call_tool_with_payment("paid_tool", {"arg": "value"}, payload)

    assert result.payment_made is True
    assert result.payment_response is not None
    if hasattr(result.payment_response, "transaction"):
        assert result.payment_response.transaction == "0xtxhash123"
    assert result.is_error is False


@pytest.mark.asyncio
async def test_x402_mcp_client_async_call_tool_with_payment_after_hook():
    """Test that after payment hook is called with async call_tool_with_payment."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    settle_response = {
        "success": True,
        "transaction": "0xtxhash123",
        "network": "eip155:84532",
    }

    mock_mcp.call_tool.return_value = MockAsyncMCPResult(
        content=[{"type": "text", "text": "success"}],
        meta={"x402/payment-response": settle_response},
    )

    client = x402MCPClient(mock_mcp, mock_payment, auto_payment=True)

    hook_called = False

    async def after_hook(context):
        nonlocal hook_called
        hook_called = True
        assert context.tool_name == "paid_tool"
        assert context.settle_response is not None

    client.on_after_payment(after_hook)

    payload = PaymentPayload(
        x402_version=2,
        accepted={
            "scheme": "exact",
            "network": "eip155:84532",
            "amount": "1000",
            "asset": "USDC",
            "payTo": "0xrecipient",
            "maxTimeoutSeconds": 300,
        },
        payload={"signature": "0x123"},
    )

    await client.call_tool_with_payment("paid_tool", {}, payload)

    assert hook_called is True


@pytest.mark.asyncio
async def test_x402_mcp_client_async_hook_abort():
    """Test that payment required hook can abort the payment flow (async)."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    payment_required_result = MockAsyncMCPResult(
        content=[
            {
                "type": "text",
                "text": '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532","amount":"1000","asset":"USDC","payTo":"0xrecipient","maxTimeoutSeconds":300}]}',
            }
        ],
        is_error=True,
    )

    mock_mcp.call_tool.return_value = payment_required_result

    client = x402MCPClient(mock_mcp, mock_payment, auto_payment=True)

    from x402.mcp.types import PaymentRequiredHookResult

    client.on_payment_required(lambda ctx: PaymentRequiredHookResult(abort=True))

    with pytest.raises(PaymentRequiredError) as exc_info:
        await client.call_tool("paid_tool", {})

    assert exc_info.value.code == 402
    mock_payment.create_payment_payload.assert_not_called()


@pytest.mark.asyncio
async def test_x402_mcp_client_async_hook_custom_payment():
    """Test that payment required hook can provide a custom payment (async)."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    payment_required_result = MockAsyncMCPResult(
        content=[
            {
                "type": "text",
                "text": '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532","amount":"1000","asset":"USDC","payTo":"0xrecipient","maxTimeoutSeconds":300}]}',
            }
        ],
        is_error=True,
    )

    success_result = MockAsyncMCPResult(
        content=[{"type": "text", "text": "success"}],
        meta={
            "x402/payment-response": {
                "success": True,
                "transaction": "0xcustom",
                "network": "eip155:84532",
            }
        },
    )

    mock_mcp.call_tool.side_effect = [payment_required_result, success_result]

    custom_payload = PaymentPayload(
        x402_version=2,
        accepted={
            "scheme": "exact",
            "network": "eip155:84532",
            "amount": "1000",
            "asset": "USDC",
            "pay_to": "0xrecipient",
            "max_timeout_seconds": 300,
        },
        payload={"signature": "0xcustom_sig"},
    )

    client = x402MCPClient(mock_mcp, mock_payment, auto_payment=True)

    from x402.mcp.types import PaymentRequiredHookResult

    client.on_payment_required(lambda ctx: PaymentRequiredHookResult(payment=custom_payload))

    result = await client.call_tool("paid_tool", {})
    assert result.payment_made is True
    mock_payment.create_payment_payload.assert_not_called()


@pytest.mark.asyncio
async def test_x402_mcp_client_async_on_payment_requested_denied():
    """Test that on_payment_requested callback can deny payment (async)."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    payment_required_result = MockAsyncMCPResult(
        content=[
            {
                "type": "text",
                "text": '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532","amount":"1000","asset":"USDC","payTo":"0xrecipient","maxTimeoutSeconds":300}]}',
            }
        ],
        is_error=True,
    )

    mock_mcp.call_tool.return_value = payment_required_result

    client = x402MCPClient(
        mock_mcp,
        mock_payment,
        auto_payment=True,
        on_payment_requested=lambda ctx: False,
    )

    with pytest.raises(PaymentRequiredError):
        await client.call_tool("paid_tool", {})

    mock_payment.create_payment_payload.assert_not_called()


@pytest.mark.asyncio
async def test_x402_mcp_client_async_on_payment_requested_approved():
    """Test that on_payment_requested callback can approve payment (async)."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    payment_required_result = MockAsyncMCPResult(
        content=[
            {
                "type": "text",
                "text": '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532","amount":"1000","asset":"USDC","payTo":"0xrecipient","maxTimeoutSeconds":300}]}',
            }
        ],
        is_error=True,
    )

    success_result = MockAsyncMCPResult(
        content=[{"type": "text", "text": "success"}],
    )

    mock_mcp.call_tool.side_effect = [payment_required_result, success_result]

    mock_payment.create_payment_payload.return_value = PaymentPayload(
        x402_version=2,
        accepted={
            "scheme": "exact",
            "network": "eip155:84532",
            "amount": "1000",
            "asset": "USDC",
            "pay_to": "0xrecipient",
            "max_timeout_seconds": 300,
        },
        payload={"signature": "0x123"},
    )

    approval_called = []
    client = x402MCPClient(
        mock_mcp,
        mock_payment,
        auto_payment=True,
        on_payment_requested=lambda ctx: approval_called.append(True) or True,
    )

    result = await client.call_tool("paid_tool", {})
    assert result.payment_made is True
    assert len(approval_called) == 1


@pytest.mark.asyncio
async def test_x402_mcp_client_async_get_tool_payment_requirements():
    """Test getting tool payment requirements (async)."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    import json

    payment_required = PaymentRequired(
        x402_version=2,
        accepts=[
            {
                "scheme": "exact",
                "network": "eip155:84532",
                "amount": "1000",
                "asset": "USDC",
                "payTo": "0xrecipient",
                "maxTimeoutSeconds": 300,
            }
        ],
    )

    payment_required_dict = payment_required.model_dump()
    payment_required_json = json.dumps(payment_required_dict)

    mock_mcp.call_tool.return_value = MockAsyncMCPResult(
        content=[{"type": "text", "text": payment_required_json}],
        is_error=True,
        structured_content=payment_required_dict,
    )

    client = x402MCPClient(mock_mcp, mock_payment, auto_payment=True)

    result = await client.get_tool_payment_requirements("paid_tool", {})

    assert result is not None
    assert result.x402_version == 2
    assert len(result.accepts) == 1
    if hasattr(result.accepts[0], "scheme"):
        assert result.accepts[0].scheme == "exact"
