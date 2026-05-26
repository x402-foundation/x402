"""Unit tests for MCP client wrapper."""

from unittest.mock import MagicMock, Mock

import pytest

from x402.mcp import PaymentRequiredError, x402MCPClientSync
from x402.schemas import PaymentPayload, PaymentRequired


class MockMCPClient:
    """Mock MCP client for testing."""

    def __init__(self):
        """Initialize mock client."""
        self.call_tool = Mock()
        self.connect = Mock()
        self.close = Mock()
        self.list_tools = Mock(return_value={"tools": []})
        self.list_resources = Mock(return_value={"resources": []})
        self.read_resource = Mock(return_value={"content": []})


class MockPaymentClient:
    """Mock payment client for testing."""

    def __init__(self):
        """Initialize mock client."""
        self.create_payment_payload = Mock()


def test_x402_mcp_client_free_tool():
    """Test calling a free tool (no payment required)."""
    mock_mcp = MockMCPClient()
    mock_payment = MockPaymentClient()

    # Create a mock result object with attributes (not dict) since _convert_mcp_result uses getattr
    class MockMCPResult:
        def __init__(self):
            self.content = [{"type": "text", "text": "pong"}]
            self.isError = False
            self._meta = {}
            self.structuredContent = None

    mock_mcp.call_tool = Mock(return_value=MockMCPResult())

    client = x402MCPClientSync(mock_mcp, mock_payment, auto_payment=True)
    result = client.call_tool("ping", {})

    assert result.payment_made is False
    assert result.is_error is False
    assert len(result.content) > 0
    mock_payment.create_payment_payload.assert_not_called()


def test_x402_mcp_client_payment_required_auto_payment():
    """Test calling a paid tool with auto-payment enabled."""
    mock_mcp = MockMCPClient()
    mock_payment = MockPaymentClient()

    # First call returns payment required
    class MockMCPResultPaymentRequired:
        def __init__(self):
            self.content = [
                {
                    "type": "text",
                    "text": '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532","amount":"1000","asset":"USDC","payTo":"0xrecipient","maxTimeoutSeconds":300}]}',
                }
            ]
            self.isError = True
            self._meta = {}
            self.structuredContent = None

    class MockMCPResultSuccess:
        def __init__(self):
            self.content = [{"type": "text", "text": "success"}]
            self.isError = False
            self._meta = {
                "x402/payment-response": {
                    "success": True,
                    "transaction": "0xtx",
                    "network": "eip155:84532",
                }
            }
            self.structuredContent = None

    mock_mcp.call_tool.side_effect = [
        MockMCPResultPaymentRequired(),
        MockMCPResultSuccess(),
    ]

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

    client = x402MCPClientSync(mock_mcp, mock_payment, auto_payment=True)
    result = client.call_tool("paid_tool", {})

    assert result.payment_made is True
    assert result.payment_response is not None
    assert result.payment_response.success is True
    assert mock_payment.create_payment_payload.called


def test_x402_mcp_client_payment_required_no_auto_payment():
    """Test calling a paid tool with auto-payment disabled."""
    mock_mcp = MockMCPClient()
    mock_payment = MockPaymentClient()

    class MockMCPResultPaymentRequired:
        def __init__(self):
            self.content = [
                {
                    "type": "text",
                    "text": '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532","amount":"1000","asset":"USDC","payTo":"0xrecipient","maxTimeoutSeconds":300}]}',
                }
            ]
            self.isError = True
            self._meta = {}
            self.structuredContent = None

    mock_mcp.call_tool.return_value = MockMCPResultPaymentRequired()

    client = x402MCPClientSync(mock_mcp, mock_payment, auto_payment=False)

    with pytest.raises(PaymentRequiredError) as exc_info:
        client.call_tool("paid_tool", {})

    assert exc_info.value.code == 402
    assert exc_info.value.payment_required is not None
    mock_payment.create_payment_payload.assert_not_called()


def test_x402_mcp_client_hooks():
    """Test client hooks are called."""
    mock_mcp = MockMCPClient()
    mock_payment = MockPaymentClient()

    class MockMCPResultPaymentRequired:
        def __init__(self):
            self.content = [
                {
                    "type": "text",
                    "text": '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532","amount":"1000","asset":"USDC","payTo":"0xrecipient","maxTimeoutSeconds":300}]}',
                }
            ]
            self.isError = True
            self._meta = {}
            self.structuredContent = None

    class MockMCPResultSuccess:
        def __init__(self):
            self.content = [{"type": "text", "text": "success"}]
            self.isError = False
            self._meta = {"x402/payment-response": {"success": True}}
            self.structuredContent = None

    mock_mcp.call_tool.side_effect = [
        MockMCPResultPaymentRequired(),
        MockMCPResultSuccess(),
    ]

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

    client = x402MCPClientSync(mock_mcp, mock_payment, auto_payment=True)
    client.on_before_payment(lambda ctx: before_called.append(ctx))
    client.on_after_payment(lambda ctx: after_called.append(ctx))

    client.call_tool("paid_tool", {})

    assert len(before_called) > 0
    assert len(after_called) > 0


def test_wrap_mcp_client_with_payment():
    """Test wrap_mcp_client_with_payment factory function."""
    from x402.mcp import wrap_mcp_client_with_payment_sync

    mock_mcp = MockMCPClient()
    mock_payment = MockPaymentClient()

    client = wrap_mcp_client_with_payment_sync(mock_mcp, mock_payment, auto_payment=True)
    assert isinstance(client, x402MCPClientSync)
    assert client.client == mock_mcp
    assert client.payment_client == mock_payment


def test_wrap_mcp_client_with_payment_from_config():
    """Test wrap_mcp_client_with_payment_from_config factory function."""
    from x402.mcp import wrap_mcp_client_with_payment_from_config_sync
    from x402.mechanisms.evm.exact import ExactEvmClientScheme

    mock_mcp = MockMCPClient()
    mock_signer = MagicMock()

    client = wrap_mcp_client_with_payment_from_config_sync(
        mock_mcp,
        schemes=[{"network": "eip155:84532", "client": ExactEvmClientScheme(mock_signer)}],
        auto_payment=True,
    )

    assert isinstance(client, x402MCPClientSync)
    assert client.client == mock_mcp


def test_x402_mcp_client_payment_client():
    """Test accessing payment client property."""
    mock_mcp = MockMCPClient()
    mock_payment = MockPaymentClient()

    client = x402MCPClientSync(mock_mcp, mock_payment, auto_payment=True)

    assert client.payment_client == mock_payment


def test_x402_mcp_client_call_tool_with_payment():
    """Test calling tool with explicit payment payload."""
    mock_mcp = MockMCPClient()
    mock_payment = MockPaymentClient()

    settle_response = {
        "success": True,
        "transaction": "0xtxhash123",
        "network": "eip155:84532",
    }

    # Create a mock result object with payment response
    class MockMCPResult:
        def __init__(self):
            self.content = [{"type": "text", "text": "success"}]
            self.isError = False
            self._meta = {"x402/payment-response": settle_response}
            self.structuredContent = None

    mock_mcp.call_tool = Mock(return_value=MockMCPResult())

    client = x402MCPClientSync(mock_mcp, mock_payment, auto_payment=True)

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

    result = client.call_tool_with_payment("paid_tool", {"arg": "value"}, payload)

    assert result.payment_made is True
    assert result.payment_response is not None
    # SettleResponse is a Pydantic model, access as attribute
    if hasattr(result.payment_response, "transaction"):
        assert result.payment_response.transaction == "0xtxhash123"
    else:
        assert result.payment_response.get("transaction") == "0xtxhash123"
    assert result.is_error is False


def test_x402_mcp_client_call_tool_with_payment_after_hook():
    """Test that after payment hook is called when using call_tool_with_payment."""
    mock_mcp = MockMCPClient()
    mock_payment = MockPaymentClient()

    settle_response = {
        "success": True,
        "transaction": "0xtxhash123",
        "network": "eip155:84532",
    }

    class MockMCPResult:
        def __init__(self):
            self.content = [{"type": "text", "text": "success"}]
            self.isError = False
            self._meta = {"x402/payment-response": settle_response}
            self.structuredContent = None

    mock_mcp.call_tool = Mock(return_value=MockMCPResult())

    client = x402MCPClientSync(mock_mcp, mock_payment, auto_payment=True)

    hook_called = False

    def after_hook(context):
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

    client.call_tool_with_payment("paid_tool", {}, payload)

    assert hook_called is True


def test_x402_mcp_client_hook_abort():
    """Test that payment required hook can abort the payment flow."""
    mock_mcp = MockMCPClient()
    mock_payment = MockPaymentClient()

    class MockMCPResultPaymentRequired:
        def __init__(self):
            self.content = [
                {
                    "type": "text",
                    "text": '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532","amount":"1000","asset":"USDC","payTo":"0xrecipient","maxTimeoutSeconds":300}]}',
                }
            ]
            self.isError = True
            self._meta = {}
            self.structuredContent = None

    mock_mcp.call_tool.return_value = MockMCPResultPaymentRequired()

    client = x402MCPClientSync(mock_mcp, mock_payment, auto_payment=True)

    # Register hook that aborts
    from x402.mcp.types import PaymentRequiredHookResult

    client.on_payment_required(lambda ctx: PaymentRequiredHookResult(abort=True))

    with pytest.raises(PaymentRequiredError) as exc_info:
        client.call_tool("paid_tool", {})

    assert exc_info.value.code == 402
    mock_payment.create_payment_payload.assert_not_called()


def test_x402_mcp_client_hook_custom_payment():
    """Test that payment required hook can provide a custom payment."""
    mock_mcp = MockMCPClient()
    mock_payment = MockPaymentClient()

    class MockMCPResultPaymentRequired:
        def __init__(self):
            self.content = [
                {
                    "type": "text",
                    "text": '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532","amount":"1000","asset":"USDC","payTo":"0xrecipient","maxTimeoutSeconds":300}]}',
                }
            ]
            self.isError = True
            self._meta = {}
            self.structuredContent = None

    class MockMCPResultSuccess:
        def __init__(self):
            self.content = [{"type": "text", "text": "success"}]
            self.isError = False
            self._meta = {
                "x402/payment-response": {
                    "success": True,
                    "transaction": "0xcustom",
                    "network": "eip155:84532",
                }
            }
            self.structuredContent = None

    mock_mcp.call_tool.side_effect = [
        MockMCPResultPaymentRequired(),
        MockMCPResultSuccess(),
    ]

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

    client = x402MCPClientSync(mock_mcp, mock_payment, auto_payment=True)

    from x402.mcp.types import PaymentRequiredHookResult

    client.on_payment_required(lambda ctx: PaymentRequiredHookResult(payment=custom_payload))

    result = client.call_tool("paid_tool", {})

    assert result.payment_made is True
    # create_payment_payload should NOT be called since hook provided custom payment
    mock_payment.create_payment_payload.assert_not_called()


def test_x402_mcp_client_on_payment_requested_denied():
    """Test that on_payment_requested callback can deny payment."""
    mock_mcp = MockMCPClient()
    mock_payment = MockPaymentClient()

    class MockMCPResultPaymentRequired:
        def __init__(self):
            self.content = [
                {
                    "type": "text",
                    "text": '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532","amount":"1000","asset":"USDC","payTo":"0xrecipient","maxTimeoutSeconds":300}]}',
                }
            ]
            self.isError = True
            self._meta = {}
            self.structuredContent = None

    mock_mcp.call_tool.return_value = MockMCPResultPaymentRequired()

    client = x402MCPClientSync(
        mock_mcp,
        mock_payment,
        auto_payment=True,
        on_payment_requested=lambda ctx: False,  # Deny
    )

    with pytest.raises(PaymentRequiredError):
        client.call_tool("paid_tool", {})

    mock_payment.create_payment_payload.assert_not_called()


def test_x402_mcp_client_on_payment_requested_approved():
    """Test that on_payment_requested callback can approve payment."""
    mock_mcp = MockMCPClient()
    mock_payment = MockPaymentClient()

    class MockMCPResultPaymentRequired:
        def __init__(self):
            self.content = [
                {
                    "type": "text",
                    "text": '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532","amount":"1000","asset":"USDC","payTo":"0xrecipient","maxTimeoutSeconds":300}]}',
                }
            ]
            self.isError = True
            self._meta = {}
            self.structuredContent = None

    class MockMCPResultSuccess:
        def __init__(self):
            self.content = [{"type": "text", "text": "success"}]
            self.isError = False
            self._meta = {}
            self.structuredContent = None

    mock_mcp.call_tool.side_effect = [
        MockMCPResultPaymentRequired(),
        MockMCPResultSuccess(),
    ]

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
    client = x402MCPClientSync(
        mock_mcp,
        mock_payment,
        auto_payment=True,
        on_payment_requested=lambda ctx: approval_called.append(True) or True,
    )

    result = client.call_tool("paid_tool", {})
    assert result.payment_made is True
    assert len(approval_called) == 1


def test_x402_mcp_client_get_tool_payment_requirements():
    """Test getting tool payment requirements."""
    mock_mcp = MockMCPClient()
    mock_payment = MockPaymentClient()

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

    import json

    payment_required_json = json.dumps(
        payment_required.model_dump()
        if hasattr(payment_required, "model_dump")
        else payment_required
    )

    class MockMCPResult:
        def __init__(self):
            self.content = [{"type": "text", "text": payment_required_json}]
            self.isError = True
            self._meta = {}
            self.structuredContent = (
                payment_required.model_dump()
                if hasattr(payment_required, "model_dump")
                else payment_required
            )

    mock_mcp.call_tool = Mock(return_value=MockMCPResult())

    client = x402MCPClientSync(mock_mcp, mock_payment, auto_payment=True)

    result = client.get_tool_payment_requirements("paid_tool", {})

    assert result is not None
    assert result.x402_version == 2
    assert len(result.accepts) == 1
    # PaymentRequirements is a Pydantic model, access as attribute
    if hasattr(result.accepts[0], "scheme"):
        assert result.accepts[0].scheme == "exact"
    else:
        assert result.accepts[0]["scheme"] == "exact"
