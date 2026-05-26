"""Shared test fixtures and mock classes for MCP tests."""

from unittest.mock import AsyncMock, MagicMock, Mock

from x402.schemas import (
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    SettleResponse,
)

# ============================================================================
# Shared constants
# ============================================================================

SAMPLE_PAYMENT_REQUIRED_JSON = (
    '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532",'
    '"amount":"1000","asset":"USDC","payTo":"0xrecipient","maxTimeoutSeconds":300}]}'
)

SAMPLE_ACCEPTS = [
    PaymentRequirements(
        scheme="exact",
        network="eip155:84532",
        amount="1000",
        asset="USDC",
        pay_to="0xrecipient",
        max_timeout_seconds=300,
    )
]

SAMPLE_PAYMENT_PAYLOAD = PaymentPayload(
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

SAMPLE_SETTLE_RESPONSE_DICT = {
    "success": True,
    "transaction": "0xtx123",
    "network": "eip155:84532",
}


# ============================================================================
# Sync mock classes
# ============================================================================


class MockMCPResult:
    """Configurable mock MCP result for testing."""

    def __init__(self, content=None, is_error=False, meta=None, structured_content=None):
        self.content = content or [{"type": "text", "text": "pong"}]
        self.isError = is_error
        self._meta = meta or {}
        self.structuredContent = structured_content


class MockMCPClient:
    """Mock MCP client for testing (sync)."""

    def __init__(self):
        self.call_tool = Mock()
        self.connect = Mock()
        self.close = Mock()
        self.list_tools = Mock(return_value={"tools": []})
        self.list_resources = Mock(return_value={"resources": []})
        self.read_resource = Mock(return_value={"content": []})


class MockPaymentClient:
    """Mock payment client for testing (sync)."""

    def __init__(self):
        self.create_payment_payload = Mock()


class MockResourceServer:
    """Mock resource server for testing (sync)."""

    def __init__(self):
        self.verify_payment = Mock(return_value=Mock(is_valid=True))
        self.settle_payment = Mock(
            return_value=SettleResponse(
                success=True,
                transaction="0xtx123",
                network="eip155:84532",
            )
        )
        self.create_payment_required_response = MagicMock(
            side_effect=self._create_payment_required_response_real
        )

    def _create_payment_required_response_real(self, accepts, resource_info, error_msg):
        return PaymentRequired(
            x402_version=2,
            accepts=accepts,
            error=error_msg,
            resource=resource_info,
        )


# ============================================================================
# Async mock classes
# ============================================================================


class MockAsyncMCPResult:
    """Configurable mock MCP result for async testing."""

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


class MockAsyncResourceServer:
    """Mock async resource server for testing."""

    def __init__(self):
        self.verify_payment = AsyncMock(return_value=Mock(is_valid=True))
        self.settle_payment = AsyncMock(
            return_value=SettleResponse(
                success=True,
                transaction="0xtx123",
                network="eip155:84532",
            )
        )
        self.create_payment_required_response = AsyncMock(
            side_effect=self._create_payment_required_response_real
        )

    async def _create_payment_required_response_real(self, accepts, resource_info, error_msg):
        return PaymentRequired(
            x402_version=2,
            accepts=accepts,
            error=error_msg,
            resource=resource_info,
        )


# ============================================================================
# Helper to build a payment-required MCP result
# ============================================================================


def make_payment_required_result(json_text=None):
    """Build a mock MCP result with payment required data."""
    return MockMCPResult(
        content=[{"type": "text", "text": json_text or SAMPLE_PAYMENT_REQUIRED_JSON}],
        is_error=True,
    )


def make_success_result(meta=None):
    """Build a mock MCP result for a successful tool call."""
    return MockMCPResult(
        content=[{"type": "text", "text": "success"}],
        meta=meta or {},
    )


def make_paid_success_result():
    """Build a mock MCP result for a successful paid tool call."""
    return MockMCPResult(
        content=[{"type": "text", "text": "success"}],
        meta={"x402/payment-response": SAMPLE_SETTLE_RESPONSE_DICT},
    )
