"""Tests for the FastMCP payment wrapper."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from mcp.types import CallToolResult, TextContent
from x402.mcp.constants import MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY
from x402.mcp.server import create_payment_wrapper
from x402.schemas import PaymentPayload, PaymentRequirements, SettleResponse


class MockFastMCPContext:
    """Minimal FastMCP context shape used by the wrapper."""

    def __init__(self, meta: dict):
        self.request_context = SimpleNamespace(
            meta=SimpleNamespace(model_extra=meta),
        )


@pytest.mark.asyncio
async def test_fastmcp_wrapper_preserves_call_tool_result_meta():
    """Preserve existing MCP metadata when adding the x402 payment response."""
    requirements = PaymentRequirements(
        scheme="exact",
        network="eip155:84532",
        amount="1000",
        asset="USDC",
        pay_to="0xrecipient",
        max_timeout_seconds=300,
    )
    payload = PaymentPayload(
        x402_version=2,
        accepted=requirements.model_dump(by_alias=True),
        payload={"signature": "0x123"},
    )
    resource_server = Mock()
    resource_server.verify_payment = AsyncMock(return_value=Mock(is_valid=True))
    resource_server.settle_payment = AsyncMock(
        return_value=SettleResponse(
            success=True,
            transaction="0xtx123",
            network="eip155:84532",
        )
    )

    wrapper = create_payment_wrapper(resource_server, accepts=[requirements])

    @wrapper
    async def paid_tool() -> CallToolResult:
        return CallToolResult(
            content=[TextContent(type="text", text="ok")],
            isError=False,
            _meta={"traceId": "trace-123"},
        )

    result = await paid_tool(
        ctx=MockFastMCPContext({MCP_PAYMENT_META_KEY: payload.model_dump(by_alias=True)})
    )

    assert result.isError is False
    assert result.content[0].text == "ok"
    assert result.meta["traceId"] == "trace-123"
    assert result.meta[MCP_PAYMENT_RESPONSE_META_KEY]["transaction"] == "0xtx123"
