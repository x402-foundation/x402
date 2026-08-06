"""Unit tests for McpError(-32042) payment challenge handling.

Tests the ability to extract PaymentRequired from thrown exceptions
(SEP-1036 UrlElicitationRequired) in addition to the existing isError
result path.  Mirrors the TypeScript tests in PR #1728.
"""

from unittest.mock import AsyncMock

import pytest

from x402.mcp import PaymentRequiredError, x402MCPClient
from x402.mcp.client import x402MCPClientSync
from x402.mcp.types import JSONRPC_PAYMENT_REQUIRED_CODE, MCP_PAYMENT_REQUIRED_CODE
from x402.mcp.utils import (
    extract_payment_required_from_error,
    is_payment_required_error,
)
from x402.schemas import PaymentPayload

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

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


class McpError(Exception):
    """Simulates the MCP SDK McpError that servers throw."""

    def __init__(self, code: int, message: str, data=None):
        super().__init__(message)
        self.code = code
        self.data = data


class MockAsyncMCPResult:
    def __init__(
        self, content=None, is_error=False, meta=None, structured_content=None
    ):
        self.content = content or [{"type": "text", "text": "pong"}]
        self.isError = is_error
        self._meta = meta or {}
        self.structuredContent = structured_content


class MockAsyncMCPClient:
    def __init__(self):
        self.call_tool = AsyncMock()


class MockAsyncPaymentClient:
    def __init__(self):
        self.create_payment_payload = AsyncMock(
            return_value=PaymentPayload(
                x402_version=2,
                accepted={
                    "scheme": "exact",
                    "network": "eip155:84532",
                    "amount": "1000",
                    "asset": "USDC",
                    "payTo": "0xrecipient",
                    "maxTimeoutSeconds": 300,
                },
                payload={"signature": "0xabc"},
            )
        )


class MockSyncMCPClient:
    def __init__(self):
        from unittest.mock import MagicMock

        self.call_tool = MagicMock()


class MockSyncPaymentClient:
    def __init__(self):
        from unittest.mock import MagicMock

        self.create_payment_payload = MagicMock(
            return_value=PaymentPayload(
                x402_version=2,
                accepted={
                    "scheme": "exact",
                    "network": "eip155:84532",
                    "amount": "1000",
                    "asset": "USDC",
                    "payTo": "0xrecipient",
                    "maxTimeoutSeconds": 300,
                },
                payload={"signature": "0xabc"},
            )
        )


# ===================================================================
# extract_payment_required_from_error — unit tests
# ===================================================================


class TestExtractPaymentRequiredFromError:
    """Tests for the updated extract_payment_required_from_error utility."""

    def test_direct_exception_with_payment_data(self):
        """McpError(-32042) with PaymentRequired directly in data."""
        err = McpError(-32042, "payment required", data=PAYMENT_REQUIRED_DATA)
        pr = extract_payment_required_from_error(err)
        assert pr is not None
        assert pr.x402_version == 2
        assert len(pr.accepts) == 1

    def test_namespaced_exception(self):
        """McpError(-32042) with PaymentRequired under data.x402."""
        err = McpError(
            -32042,
            "payment required",
            data={"x402": PAYMENT_REQUIRED_DATA},
        )
        pr = extract_payment_required_from_error(err)
        assert pr is not None
        assert pr.x402_version == 2

    def test_non_payment_error_returns_none(self):
        """McpError with a different code returns None."""
        err = McpError(-32600, "invalid request", data=PAYMENT_REQUIRED_DATA)
        pr = extract_payment_required_from_error(err)
        assert pr is None

    def test_no_data_returns_none(self):
        """McpError(-32042) without data returns None."""
        err = McpError(-32042, "payment required", data=None)
        pr = extract_payment_required_from_error(err)
        assert pr is None

    def test_empty_data_returns_none(self):
        """McpError(-32042) with empty dict data returns None."""
        err = McpError(-32042, "payment required", data={})
        pr = extract_payment_required_from_error(err)
        assert pr is None

    def test_dict_error_402(self):
        """Legacy dict-like error with code 402 still works."""
        err = {"code": 402, "data": PAYMENT_REQUIRED_DATA}
        pr = extract_payment_required_from_error(err)
        assert pr is not None
        assert pr.x402_version == 2

    def test_dict_error_32042(self):
        """Dict-like error with code -32042 works."""
        err = {"code": -32042, "data": PAYMENT_REQUIRED_DATA}
        pr = extract_payment_required_from_error(err)
        assert pr is not None

    def test_dict_error_wrong_code(self):
        """Dict-like error with wrong code returns None."""
        err = {"code": 500, "data": PAYMENT_REQUIRED_DATA}
        pr = extract_payment_required_from_error(err)
        assert pr is None

    def test_plain_exception_returns_none(self):
        """Regular Exception without code/data returns None."""
        err = Exception("something broke")
        pr = extract_payment_required_from_error(err)
        assert pr is None


# ===================================================================
# is_payment_required_error — unit tests
# ===================================================================


class TestIsPaymentRequiredError:
    """Tests for the updated is_payment_required_error utility."""

    def test_payment_required_error_instance(self):
        err = PaymentRequiredError("pay up")
        assert is_payment_required_error(err) is True

    def test_mcperror_32042(self):
        err = McpError(-32042, "payment required", data=PAYMENT_REQUIRED_DATA)
        assert is_payment_required_error(err) is True

    def test_mcperror_402(self):
        err = McpError(402, "payment required", data=PAYMENT_REQUIRED_DATA)
        assert is_payment_required_error(err) is True

    def test_mcperror_without_payment_data(self):
        err = McpError(-32042, "payment required")
        assert is_payment_required_error(err) is False

    def test_mcperror_other_code(self):
        err = McpError(-32600, "bad request")
        assert is_payment_required_error(err) is False

    def test_plain_exception(self):
        err = Exception("nope")
        assert is_payment_required_error(err) is False


# ===================================================================
# Async client — McpError(-32042) handling
# ===================================================================


@pytest.mark.asyncio
async def test_async_client_handles_thrown_32042():
    """Async client catches McpError(-32042) and proceeds with payment."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    # First call throws McpError(-32042)
    mock_mcp.call_tool.side_effect = [
        McpError(-32042, "payment required", data=PAYMENT_REQUIRED_DATA),
        MockAsyncMCPResult(content=[{"type": "text", "text": "success"}]),
    ]

    client = x402MCPClient(mock_mcp, mock_payment, auto_payment=True)
    result = await client.call_tool("paid_tool", {"q": "test"})

    assert result.payment_made is True
    assert not result.is_error
    mock_payment.create_payment_payload.assert_called_once()


@pytest.mark.asyncio
async def test_async_client_handles_namespaced_32042():
    """Async client handles namespaced data.x402 in McpError(-32042)."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    mock_mcp.call_tool.side_effect = [
        McpError(-32042, "payment required", data={"x402": PAYMENT_REQUIRED_DATA}),
        MockAsyncMCPResult(content=[{"type": "text", "text": "success"}]),
    ]

    client = x402MCPClient(mock_mcp, mock_payment, auto_payment=True)
    result = await client.call_tool("paid_tool", {})

    assert result.payment_made is True
    mock_payment.create_payment_payload.assert_called_once()


@pytest.mark.asyncio
async def test_async_client_rethrows_non_payment_error():
    """Async client re-raises non-payment exceptions."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    mock_mcp.call_tool.side_effect = McpError(-32600, "invalid request")

    client = x402MCPClient(mock_mcp, mock_payment, auto_payment=True)
    with pytest.raises(McpError, match="invalid request"):
        await client.call_tool("tool", {})

    mock_payment.create_payment_payload.assert_not_called()


@pytest.mark.asyncio
async def test_async_client_rethrows_32042_without_valid_data():
    """Async client re-raises -32042 if data doesn't contain valid PaymentRequired."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    mock_mcp.call_tool.side_effect = McpError(
        -32042, "no payment data", data={"foo": "bar"}
    )

    client = x402MCPClient(mock_mcp, mock_payment, auto_payment=True)
    with pytest.raises(McpError, match="no payment data"):
        await client.call_tool("tool", {})


@pytest.mark.asyncio
async def test_async_client_auto_payment_false_raises():
    """Async client raises PaymentRequiredError when auto_payment=False and -32042 thrown."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    mock_mcp.call_tool.side_effect = McpError(
        -32042, "payment required", data=PAYMENT_REQUIRED_DATA
    )

    client = x402MCPClient(mock_mcp, mock_payment, auto_payment=False)
    with pytest.raises(PaymentRequiredError):
        await client.call_tool("tool", {})


@pytest.mark.asyncio
async def test_async_get_tool_payment_requirements_from_32042():
    """get_tool_payment_requirements extracts from thrown McpError(-32042)."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    mock_mcp.call_tool.side_effect = McpError(
        -32042, "payment required", data=PAYMENT_REQUIRED_DATA
    )

    client = x402MCPClient(mock_mcp, mock_payment)
    pr = await client.get_tool_payment_requirements("tool", {})

    assert pr is not None
    assert pr.x402_version == 2
    assert len(pr.accepts) == 1


@pytest.mark.asyncio
async def test_async_get_tool_payment_requirements_rethrows_non_payment_error():
    """get_tool_payment_requirements re-raises non-payment exceptions."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    mock_mcp.call_tool.side_effect = McpError(-32600, "bad request")

    client = x402MCPClient(mock_mcp, mock_payment)
    with pytest.raises(McpError, match="bad request"):
        await client.get_tool_payment_requirements("tool", {})


@pytest.mark.asyncio
async def test_async_client_backward_compat_iserror():
    """Existing isError path still works alongside -32042 handling."""
    mock_mcp = MockAsyncMCPClient()
    mock_payment = MockAsyncPaymentClient()

    # Return payment required via isError (legacy path)
    import json

    mock_mcp.call_tool.side_effect = [
        MockAsyncMCPResult(
            content=[{"type": "text", "text": json.dumps(PAYMENT_REQUIRED_DATA)}],
            is_error=True,
        ),
        MockAsyncMCPResult(content=[{"type": "text", "text": "success"}]),
    ]

    client = x402MCPClient(mock_mcp, mock_payment, auto_payment=True)
    result = await client.call_tool("tool", {})

    assert result.payment_made is True
    mock_payment.create_payment_payload.assert_called_once()


# ===================================================================
# Sync client — McpError(-32042) handling
# ===================================================================


def test_sync_client_handles_thrown_32042():
    """Sync client catches McpError(-32042) and proceeds with payment."""
    mock_mcp = MockSyncMCPClient()
    mock_payment = MockSyncPaymentClient()

    # First call throws, second succeeds
    success_result = MockAsyncMCPResult(content=[{"type": "text", "text": "ok"}])
    mock_mcp.call_tool.side_effect = [
        McpError(-32042, "payment required", data=PAYMENT_REQUIRED_DATA),
        success_result,
    ]

    client = x402MCPClientSync(mock_mcp, mock_payment, auto_payment=True)
    result = client.call_tool("tool", {})

    assert result.payment_made is True
    mock_payment.create_payment_payload.assert_called_once()


def test_sync_client_rethrows_non_payment_error():
    """Sync client re-raises non-payment exceptions."""
    mock_mcp = MockSyncMCPClient()
    mock_payment = MockSyncPaymentClient()

    mock_mcp.call_tool.side_effect = McpError(-32600, "invalid request")

    client = x402MCPClientSync(mock_mcp, mock_payment, auto_payment=True)
    with pytest.raises(McpError, match="invalid request"):
        client.call_tool("tool", {})


def test_sync_client_auto_payment_false_raises():
    """Sync client does not pay a thrown challenge when auto-payment is disabled."""
    mock_mcp = MockSyncMCPClient()
    mock_payment = MockSyncPaymentClient()

    mock_mcp.call_tool.side_effect = McpError(
        -32042, "payment required", data=PAYMENT_REQUIRED_DATA
    )

    client = x402MCPClientSync(mock_mcp, mock_payment, auto_payment=False)
    with pytest.raises(PaymentRequiredError):
        client.call_tool("tool", {})

    mock_payment.create_payment_payload.assert_not_called()


def test_sync_get_tool_payment_requirements_from_32042():
    """Sync requirement probing extracts a thrown -32042 challenge."""
    mock_mcp = MockSyncMCPClient()
    mock_payment = MockSyncPaymentClient()

    mock_mcp.call_tool.side_effect = McpError(
        -32042, "payment required", data=PAYMENT_REQUIRED_DATA
    )

    client = x402MCPClientSync(mock_mcp, mock_payment)
    payment_required = client.get_tool_payment_requirements("tool", {})

    assert payment_required is not None
    assert payment_required.x402_version == 2


def test_sync_get_tool_payment_requirements_rethrows_non_payment_error():
    """Sync requirement probing re-raises non-payment exceptions."""
    mock_mcp = MockSyncMCPClient()
    mock_payment = MockSyncPaymentClient()

    mock_mcp.call_tool.side_effect = McpError(-32600, "bad request")

    client = x402MCPClientSync(mock_mcp, mock_payment)
    with pytest.raises(McpError, match="bad request"):
        client.get_tool_payment_requirements("tool", {})


# ===================================================================
# Constants
# ===================================================================


def test_jsonrpc_payment_required_code_value():
    """Verify the constant matches SEP-1036."""
    assert JSONRPC_PAYMENT_REQUIRED_CODE == -32042


def test_mcp_payment_required_code_unchanged():
    """Verify the original 402 constant is unchanged."""
    assert MCP_PAYMENT_REQUIRED_CODE == 402
