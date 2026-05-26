"""Unit tests for MCP async server payment wrapper."""

from unittest.mock import AsyncMock, Mock

import pytest

from x402.mcp.server_async import (
    PaymentWrapperConfig,
    PaymentWrapperHooks,
    create_payment_wrapper,
)
from x402.mcp.types import ResourceInfo
from x402.schemas import PaymentPayload, PaymentRequirements, SettleResponse


class MockAsyncResourceServer:
    """Mock async resource server for testing."""

    def __init__(self):
        """Initialize mock async server."""
        self.verify_payment = AsyncMock(return_value=Mock(is_valid=True))
        self.settle_payment = AsyncMock(
            return_value=SettleResponse(
                success=True,
                transaction="0xtx123",
                network="eip155:84532",
            )
        )
        # Create an AsyncMock that wraps the real method so we can track calls
        self._create_payment_required_response_impl = self._create_payment_required_response_real
        self.create_payment_required_response = AsyncMock(
            side_effect=self._create_payment_required_response_real
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

    async def _create_payment_required_response_real(
        self, accepts, resource_info, error_msg, extensions=None
    ):
        """Real implementation of create payment required response."""
        from x402.schemas import PaymentRequired

        return PaymentRequired(
            x402_version=2,
            accepts=accepts,
            error=error_msg,
            resource=resource_info,
        )


@pytest.mark.asyncio
async def test_create_payment_wrapper_async_basic_flow():
    """Test basic async payment wrapper flow."""
    server = MockAsyncResourceServer()
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

    # Create async handler
    async def handler(args, context):
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

    result = await wrapped(args, extra)

    assert result.is_error is False
    assert "x402/payment-response" in result.meta
    assert server.verify_payment.called
    assert server.settle_payment.called


@pytest.mark.asyncio
async def test_create_payment_wrapper_async_no_payment():
    """Test async payment wrapper when no payment provided."""
    server = MockAsyncResourceServer()
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

    async def handler(args, context):
        return {"content": [], "isError": False}

    wrapped = paid(handler)

    args = {}
    extra = {"_meta": {}, "toolName": "test"}

    result = await wrapped(args, extra)

    # Should return payment required error
    assert result.is_error is True
    assert server.create_payment_required_response.called


@pytest.mark.asyncio
async def test_create_payment_wrapper_async_verification_failure():
    """Test async payment wrapper when verification fails."""
    server = MockAsyncResourceServer()
    server.verify_payment = AsyncMock(
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

    async def handler(args, context):
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

    result = await wrapped(args, extra)

    # Should return payment required error
    assert result.is_error is True
    assert server.verify_payment.called
    assert not server.settle_payment.called


@pytest.mark.asyncio
async def test_create_payment_wrapper_async_hooks():
    """Test async payment wrapper hooks."""
    server = MockAsyncResourceServer()
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

    async def handler(args, context):
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
    await wrapped(
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


@pytest.mark.asyncio
async def test_create_payment_wrapper_async_abort_on_before_execution():
    """Test that onBeforeExecution can abort execution."""
    server = MockAsyncResourceServer()
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

    async def handler(args, context):
        handler_called.append(True)
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
    result = await wrapped(
        {"test": "value"},
        {
            "_meta": {
                "x402/payment": (
                    payload.model_dump() if hasattr(payload, "model_dump") else payload
                )
            }
        },
    )

    assert len(handler_called) == 0, "Handler should not be called when hook aborts"
    assert result.is_error is True


@pytest.mark.asyncio
async def test_create_payment_wrapper_async_settlement_failure():
    """Test handling of settlement failure."""
    server = MockAsyncResourceServer()
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

    async def handler(args, context):
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
    result = await wrapped(
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
    assert "settlement" in str(result.content).lower() or result.structured_content is not None


@pytest.mark.asyncio
async def test_create_payment_wrapper_async_settlement_returns_failure():
    """Replay attack regression: settle returning success=False must withhold tool output."""
    from x402.mcp.types import MCP_PAYMENT_RESPONSE_META_KEY

    server = MockAsyncResourceServer()
    server.settle_payment = AsyncMock(
        return_value=SettleResponse(
            success=False,
            error_reason="AuthorizationAlreadyUsed",
            transaction="",
            network="eip155:84532",
        )
    )

    after_settlement_calls = []

    async def on_after_settlement(ctx):
        after_settlement_calls.append(ctx)

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
        hooks=PaymentWrapperHooks(on_after_settlement=on_after_settlement),
    )

    paid = create_payment_wrapper(server, config)

    async def handler(args, context):
        return {"content": [{"type": "text", "text": "should-not-be-returned"}]}

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
    result = await wrapped(
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
    assert "should-not-be-returned" not in str(result.content)
    assert "should-not-be-returned" not in str(result.structured_content)
    assert result.structured_content is not None
    payment_response = result.structured_content[MCP_PAYMENT_RESPONSE_META_KEY]
    assert payment_response["success"] is False
    assert "AuthorizationAlreadyUsed" in result.structured_content["error"]
    assert after_settlement_calls == []


@pytest.mark.asyncio
async def test_create_payment_wrapper_async_handler_error_no_settlement():
    """Test that settlement is NOT called when async handler returns an error."""
    server = MockAsyncResourceServer()
    server.settle_payment = AsyncMock()  # Track calls

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

    async def handler(args, context):
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
    result = await wrapped(
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


@pytest.mark.asyncio
async def test_create_payment_wrapper_async_find_matching_requirement():
    """Test that payment matching selects the correct requirement from accepts (async)."""
    server = MockAsyncResourceServer()

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

    async def handler(args, context):
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
    result = await wrapped(
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


@pytest.mark.asyncio
async def test_create_payment_wrapper_async_hooks_order():
    """Test that hooks are called in correct order."""
    server = MockAsyncResourceServer()
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

    async def handler(args, context):
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
    await wrapped(
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


@pytest.mark.asyncio
async def test_create_payment_wrapper_async_async_hooks():
    """Test with truly async hooks (async def callbacks)."""
    server = MockAsyncResourceServer()
    before_called = []
    after_called = []
    settlement_called = []

    async def async_before_hook(ctx):
        before_called.append(ctx)
        return True

    async def async_after_hook(ctx):
        after_called.append(ctx)

    async def async_settlement_hook(ctx):
        settlement_called.append(ctx)

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
            on_before_execution=async_before_hook,
            on_after_execution=async_after_hook,
            on_after_settlement=async_settlement_hook,
        ),
    )

    paid = create_payment_wrapper(server, config)

    async def handler(args, context):
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
    await wrapped(
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


@pytest.mark.asyncio
async def test_create_payment_wrapper_async_hook_error_swallowed():
    """Test that on_after_execution errors don't propagate."""
    server = MockAsyncResourceServer()

    def error_hook(ctx):
        raise Exception("Hook error")

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
            on_after_execution=error_hook,
        ),
    )

    paid = create_payment_wrapper(server, config)

    async def handler(args, context):
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
    # Should not raise exception
    result = await wrapped(
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
    assert server.settle_payment.called
