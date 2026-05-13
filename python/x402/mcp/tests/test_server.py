"""Unit tests for MCP server payment wrapper."""

from unittest.mock import MagicMock, Mock

import pytest

from x402.mcp import (
    ResourceInfo,
)
from x402.mcp import (
    SyncPaymentWrapperConfig as PaymentWrapperConfig,
)
from x402.mcp import (
    create_payment_wrapper_sync as create_payment_wrapper,
)
from x402.mcp.types import MCPToolResult
from x402.mcp.types import SyncPaymentWrapperHooks as PaymentWrapperHooks
from x402.schemas import PaymentPayload, PaymentRequirements, SettleResponse


class MockResourceServer:
    """Mock resource server for testing."""

    def __init__(self):
        """Initialize mock server."""
        self.verify_payment = Mock()
        self.settle_payment = Mock()
        # Create a Mock that wraps the real method so we can track calls
        self._create_payment_required_response_impl = self._create_payment_required_response_real
        self.create_payment_required_response = MagicMock(
            side_effect=self._create_payment_required_response_real
        )

    def verify_payment(self, payload, requirements):
        """Mock verify payment."""
        return Mock(is_valid=True)

    def settle_payment(self, payload, requirements):
        """Mock settle payment."""
        return SettleResponse(
            success=True,
            transaction="0xtx123",
            network="eip155:84532",
        )

    def find_matching_requirements(self, available, payload):
        """Find requirements matching the payload's accepted field."""
        accepted = getattr(payload, "accepted", None)
        if accepted is None:
            return None
        for req in available:
            if (
                req.scheme == accepted.scheme
                and req.network == accepted.network
                and req.amount == accepted.amount
                and req.asset == accepted.asset
                and req.pay_to == accepted.pay_to
            ):
                return req
        return None

    def _create_payment_required_response_real(self, accepts, resource_info, error_msg):
        """Real implementation of create payment required response."""
        from x402.schemas import PaymentRequired

        return PaymentRequired(
            x402_version=2,
            accepts=accepts,
            error=error_msg,
            resource=resource_info,
        )


def test_create_payment_wrapper_basic_flow():
    """Test basic payment wrapper flow."""
    server = MockResourceServer()
    config = PaymentWrapperConfig(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ],
        resource=ResourceInfo(
            url="mcp://tool/test",
            description="Test tool",
            mime_type="application/json",
        ),
    )

    paid = create_payment_wrapper(server, config)

    # Create handler
    def handler(args, context):
        return {"content": [{"type": "text", "text": "success"}], "isError": False}

    wrapped = paid(handler)

    # Test with payment
    payload = PaymentPayload(
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

    args = {"test": "value"}
    extra = {
        "_meta": {
            "x402/payment": (payload.model_dump() if hasattr(payload, "model_dump") else payload)
        },
        "toolName": "test",
    }

    result = wrapped(args, extra)

    assert result.is_error is False
    assert "x402/payment-response" in result.meta
    assert server.verify_payment.called
    assert server.settle_payment.called


def test_create_payment_wrapper_no_payment():
    """Test payment wrapper when no payment provided."""
    server = MockResourceServer()
    config = PaymentWrapperConfig(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ],
    )

    paid = create_payment_wrapper(server, config)

    def handler(args, context):
        return {"content": [], "isError": False}

    wrapped = paid(handler)

    args = {}
    extra = {"_meta": {}, "toolName": "test"}

    result = wrapped(args, extra)

    # Should return payment required error
    assert result.is_error is True
    assert server.create_payment_required_response.called


def test_create_payment_wrapper_verification_failure():
    """Test payment wrapper when verification fails."""
    server = MockResourceServer()
    server.verify_payment = Mock(
        return_value=Mock(is_valid=False, invalid_reason="Invalid signature")
    )

    config = PaymentWrapperConfig(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ],
    )

    paid = create_payment_wrapper(server, config)

    def handler(args, context):
        return {"content": [], "isError": False}

    wrapped = paid(handler)

    payload = PaymentPayload(
        x402_version=2,
        accepted={
            "scheme": "exact",
            "network": "eip155:84532",
            "amount": "1000",
            "asset": "USDC",
            "pay_to": "0xrecipient",
            "max_timeout_seconds": 300,
        },
        payload={"signature": "0xinvalid"},
    )

    args = {}
    extra = {
        "_meta": {
            "x402/payment": (payload.model_dump() if hasattr(payload, "model_dump") else payload)
        },
        "toolName": "test",
    }

    result = wrapped(args, extra)

    # Should return payment required error
    assert result.is_error is True
    assert server.verify_payment.called
    assert not server.settle_payment.called


def test_create_payment_wrapper_hooks():
    """Test payment wrapper hooks."""
    from x402.mcp.types import SyncPaymentWrapperHooks as PaymentWrapperHooks

    server = MockResourceServer()
    before_called = []
    after_called = []
    settlement_called = []

    config = PaymentWrapperConfig(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ],
        hooks=PaymentWrapperHooks(
            on_before_execution=lambda ctx: before_called.append(ctx) or True,
            on_after_execution=lambda ctx: after_called.append(ctx),
            on_after_settlement=lambda ctx: settlement_called.append(ctx),
        ),
    )

    paid = create_payment_wrapper(server, config)

    def handler(args, context):
        return {"content": [{"type": "text", "text": "success"}]}

    wrapped = paid(handler)
    payload = PaymentPayload(
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
    wrapped(
        {"test": "value"},
        {
            "_meta": {
                "x402/payment": (
                    payload.model_dump() if hasattr(payload, "model_dump") else payload
                )
            }
        },
    )

    assert len(before_called) > 0
    assert len(after_called) > 0
    assert len(settlement_called) > 0


def test_create_payment_wrapper_abort_on_before_execution():
    """Test that onBeforeExecution can abort execution."""
    from x402.mcp.types import SyncPaymentWrapperHooks as PaymentWrapperHooks

    server = MockResourceServer()
    handler_called = []

    config = PaymentWrapperConfig(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ],
        hooks=PaymentWrapperHooks(
            on_before_execution=lambda ctx: False,  # Abort
        ),
    )

    paid = create_payment_wrapper(server, config)

    def handler(args, context):
        handler_called.append(True)
        return {"content": [{"type": "text", "text": "success"}]}

    wrapped = paid(handler)
    result = wrapped(
        {"test": "value"},
        {"_meta": {"x402/payment": {"x402Version": 2, "payload": {"signature": "0x123"}}}},
    )

    assert len(handler_called) == 0, "Handler should not be called when hook aborts"
    assert result.is_error is True


def test_create_payment_wrapper_settlement_failure():
    """Test handling of settlement failure."""
    server = MockResourceServer()
    server.settle_payment.side_effect = Exception("Settlement failed")

    config = PaymentWrapperConfig(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ],
    )

    paid = create_payment_wrapper(server, config)

    def handler(args, context):
        return {"content": [{"type": "text", "text": "success"}]}

    wrapped = paid(handler)
    result = wrapped(
        {"test": "value"},
        {"_meta": {"x402/payment": {"x402Version": 2, "payload": {"signature": "0x123"}}}},
    )

    assert result.is_error is True
    assert "settlement" in str(result.content).lower() or result.structured_content is not None


def test_create_payment_wrapper_handler_error_no_settlement():
    """Test that settlement is NOT called when handler returns an error."""
    server = MockResourceServer()
    server.settle_payment = Mock()  # Track calls

    config = PaymentWrapperConfig(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ],
    )

    paid = create_payment_wrapper(server, config)

    def handler(args, context):
        return {"content": [{"type": "text", "text": "tool error"}], "isError": True}

    wrapped = paid(handler)
    payload = PaymentPayload(
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
    result = wrapped(
        {"test": "value"},
        {
            "_meta": {
                "x402/payment": (
                    payload.model_dump() if hasattr(payload, "model_dump") else payload
                )
            }
        },
    )

    assert result.is_error is True
    server.settle_payment.assert_not_called()


def test_create_payment_wrapper_hook_errors_non_fatal():
    """Test that on_after_execution errors are swallowed and don't propagate."""
    from x402.mcp.types import SyncPaymentWrapperHooks as PaymentWrapperHooks

    server = MockResourceServer()

    def error_after_hook(ctx):
        raise Exception("after execution hook error")

    def error_settlement_hook(ctx):
        raise Exception("after settlement hook error")

    config = PaymentWrapperConfig(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ],
        hooks=PaymentWrapperHooks(
            on_after_execution=error_after_hook,
            on_after_settlement=error_settlement_hook,
        ),
    )

    paid = create_payment_wrapper(server, config)

    def handler(args, context):
        return {"content": [{"type": "text", "text": "success"}]}

    wrapped = paid(handler)
    payload = PaymentPayload(
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

    # Should not raise despite hook errors
    result = wrapped(
        {"test": "value"},
        {
            "_meta": {
                "x402/payment": (
                    payload.model_dump() if hasattr(payload, "model_dump") else payload
                )
            }
        },
    )

    assert result.is_error is False
    assert "x402/payment-response" in result.meta


def test_create_payment_wrapper_find_matching_requirement():
    """Test that payment matching selects the correct requirement from accepts."""
    server = MockResourceServer()

    accepts = [
        PaymentRequirements(
            scheme="exact",
            network="eip155:84532",
            amount="1000",
            asset="USDC",
            pay_to="0xA",
            max_timeout_seconds=300,
        ),
        PaymentRequirements(
            scheme="exact",
            network="eip155:1",
            amount="2000",
            asset="USDC",
            pay_to="0xB",
            max_timeout_seconds=300,
        ),
    ]

    config = PaymentWrapperConfig(accepts=accepts)
    paid = create_payment_wrapper(server, config)

    def handler(args, context):
        return {"content": [{"type": "text", "text": "success"}]}

    wrapped = paid(handler)

    # Send payment matching eip155:1
    payload = PaymentPayload(
        x402_version=2,
        accepted={
            "scheme": "exact",
            "network": "eip155:1",
            "amount": "2000",
            "asset": "USDC",
            "pay_to": "0xB",
            "max_timeout_seconds": 300,
        },
        payload={"signature": "0x123"},
    )
    result = wrapped(
        {},
        {
            "_meta": {
                "x402/payment": (
                    payload.model_dump() if hasattr(payload, "model_dump") else payload
                )
            }
        },
    )

    assert result.is_error is False
    # verify_payment was called with the matched requirement (eip155:1)
    call_args = server.verify_payment.call_args
    matched_req = call_args[0][1] if call_args[0] else call_args[1].get("requirements")
    assert matched_req.network == "eip155:1"


def test_create_payment_wrapper_hooks_order():
    """Test that hooks are called in correct order."""
    from x402.mcp.types import SyncPaymentWrapperHooks as PaymentWrapperHooks

    server = MockResourceServer()
    call_order = []

    config = PaymentWrapperConfig(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ],
        hooks=PaymentWrapperHooks(
            on_before_execution=lambda ctx: call_order.append("before") or True,
            on_after_execution=lambda ctx: call_order.append("after"),
            on_after_settlement=lambda ctx: call_order.append("settlement"),
        ),
    )

    paid = create_payment_wrapper(server, config)

    def handler(args, context):
        call_order.append("handler")
        return {"content": [{"type": "text", "text": "success"}]}

    wrapped = paid(handler)
    payload = PaymentPayload(
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
    wrapped(
        {"test": "value"},
        {
            "_meta": {
                "x402/payment": (
                    payload.model_dump() if hasattr(payload, "model_dump") else payload
                )
            }
        },
    )

    assert call_order == ["before", "handler", "after", "settlement"]


def test_no_meta_key_returns_402():
    """Test that missing _meta key returns payment-required error."""
    server = MockResourceServer()
    config = PaymentWrapperConfig(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ],
    )

    wrapped = create_payment_wrapper(server, config)(lambda args, ctx: {"content": []})
    result = wrapped({}, {"toolName": "test"})

    assert result.is_error is True


def test_non_dict_meta_returns_402():
    """Test that non-dict _meta returns payment-required error."""
    server = MockResourceServer()
    config = PaymentWrapperConfig(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ],
    )

    wrapped = create_payment_wrapper(server, config)(lambda args, ctx: {"content": []})
    result = wrapped({}, {"_meta": "bad", "toolName": "test"})

    assert result.is_error is True


def test_no_matching_requirements():
    """Test that mismatched network returns 402 without verification."""
    server = MockResourceServer()
    config = PaymentWrapperConfig(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ],
    )

    wrapped = create_payment_wrapper(server, config)(lambda args, ctx: {"content": []})

    payload = PaymentPayload(
        x402_version=2,
        accepted={
            "scheme": "exact",
            "network": "eip155:1",
            "amount": "1000",
            "asset": "USDC",
            "pay_to": "0xrecipient",
            "max_timeout_seconds": 300,
        },
        payload={"signature": "0x123"},
    )
    extra = {
        "_meta": {
            "x402/payment": (payload.model_dump() if hasattr(payload, "model_dump") else payload)
        },
        "toolName": "test",
    }

    result = wrapped({}, extra)

    assert result.is_error is True
    assert not server.verify_payment.called


def test_handler_returns_mcp_tool_result():
    """Test that handler returning MCPToolResult directly is used as-is."""
    server = MockResourceServer()
    config = PaymentWrapperConfig(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ],
    )

    def handler(args, context):
        return MCPToolResult(
            content=[{"type": "text", "text": "direct result"}],
            is_error=False,
        )

    wrapped = create_payment_wrapper(server, config)(handler)

    payload = PaymentPayload(
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
    extra = {
        "_meta": {
            "x402/payment": (payload.model_dump() if hasattr(payload, "model_dump") else payload)
        },
        "toolName": "test",
    }

    result = wrapped({}, extra)

    assert result.is_error is False
    assert result.content[0]["text"] == "direct result"


def test_handler_returns_non_dict():
    """Test that handler returning a non-dict gets stringified."""
    server = MockResourceServer()
    config = PaymentWrapperConfig(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ],
    )

    wrapped = create_payment_wrapper(server, config)(lambda args, ctx: 42)

    payload = PaymentPayload(
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
    extra = {
        "_meta": {
            "x402/payment": (payload.model_dump() if hasattr(payload, "model_dump") else payload)
        },
        "toolName": "test",
    }

    result = wrapped({}, extra)

    assert result.is_error is False
    assert result.content[0]["text"] == "42"


def test_handler_dict_with_structured_content():
    """Test that dict result with structuredContent key is preserved."""
    server = MockResourceServer()
    config = PaymentWrapperConfig(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ],
    )

    def handler(args, context):
        return {
            "content": [{"type": "text", "text": "ok"}],
            "isError": False,
            "structuredContent": {"key": "value"},
        }

    wrapped = create_payment_wrapper(server, config)(handler)

    payload = PaymentPayload(
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
    extra = {
        "_meta": {
            "x402/payment": (payload.model_dump() if hasattr(payload, "model_dump") else payload)
        },
        "toolName": "test",
    }

    result = wrapped({}, extra)

    assert result.structured_content == {"key": "value"}


def test_empty_accepts_raises():
    """Test that empty accepts raises ValueError."""
    with pytest.raises(ValueError, match="at least one"):
        PaymentWrapperConfig(accepts=[])


def test_verification_failure_no_reason():
    """Test that verification failure without reason still returns 402."""
    server = MockResourceServer()
    server.verify_payment = Mock(return_value=Mock(is_valid=False, invalid_reason=None))
    config = PaymentWrapperConfig(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ],
    )

    wrapped = create_payment_wrapper(server, config)(lambda args, ctx: {"content": []})

    payload = PaymentPayload(
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
    extra = {
        "_meta": {
            "x402/payment": (payload.model_dump() if hasattr(payload, "model_dump") else payload)
        },
        "toolName": "test",
    }

    result = wrapped({}, extra)

    assert result.is_error is True


def test_hook_context_carries_expected_fields():
    """Test that hook context objects carry tool_name, arguments, and payment data."""
    server = MockResourceServer()
    captured_before = []
    captured_after = []
    captured_settlement = []

    config = PaymentWrapperConfig(
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                amount="1000",
                asset="USDC",
                pay_to="0xrecipient",
                max_timeout_seconds=300,
            )
        ],
        hooks=PaymentWrapperHooks(
            on_before_execution=lambda ctx: captured_before.append(ctx) or True,
            on_after_execution=lambda ctx: captured_after.append(ctx),
            on_after_settlement=lambda ctx: captured_settlement.append(ctx),
        ),
    )

    wrapped = create_payment_wrapper(server, config)(
        lambda args, ctx: {"content": [{"type": "text", "text": "data"}]}
    )

    payload = PaymentPayload(
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
    extra = {
        "_meta": {
            "x402/payment": (payload.model_dump() if hasattr(payload, "model_dump") else payload)
        },
        "toolName": "test",
    }

    wrapped({"city": "NYC"}, extra)

    before_ctx = captured_before[0]
    assert before_ctx.tool_name == "test"
    assert before_ctx.arguments == {"city": "NYC"}
    assert before_ctx.payment_requirements is not None
    assert before_ctx.payment_payload is not None

    after_ctx = captured_after[0]
    assert after_ctx.result is not None
    assert after_ctx.result.content[0]["text"] == "data"

    settle_ctx = captured_settlement[0]
    assert settle_ctx.settlement is not None
    assert settle_ctx.settlement.success is True
