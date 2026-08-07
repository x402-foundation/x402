"""Tests for the FastMCP payment wrapper."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from mcp.types import CallToolResult, TextContent
from x402.mcp.constants import MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY
from x402.mcp.server import create_payment_wrapper
from x402.schemas import (
    PaymentPayload,
    PaymentRequirements,
    ResourceInfo,
    SettleResponse,
)


class MockFastMCPContext:
    """Minimal FastMCP context shape used by the wrapper."""

    def __init__(self, meta: dict):
        self.request_context = SimpleNamespace(
            meta=SimpleNamespace(model_extra=meta),
        )


def _matching_resource_server(**overrides):
    """Mock resource server whose find_matching_requirements matches by scheme+network."""
    resource_server = Mock()
    resource_server.find_matching_requirements = Mock(
        side_effect=lambda accepts, payload: next(
            (
                req
                for req in accepts
                if req.scheme == payload.accepted.scheme and req.network == payload.accepted.network
            ),
            None,
        )
    )
    for name, value in overrides.items():
        setattr(resource_server, name, value)
    return resource_server


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


@pytest.mark.asyncio
async def test_fastmcp_verifies_and_settles_against_matched_accept():
    """The wrapper must use the requirement matched from payload.accepted, not accepts[0]."""
    evm = PaymentRequirements(
        scheme="exact",
        network="eip155:84532",
        amount="1000",
        asset="USDC",
        pay_to="0xevm",
        max_timeout_seconds=300,
    )
    tvm = PaymentRequirements(
        scheme="exact",
        network="tvm:-3",
        amount="1000",
        asset="TON",
        pay_to="0xtvm",
        max_timeout_seconds=300,
    )
    # Client paid the second (TVM) requirement.
    payload = PaymentPayload(
        x402_version=2,
        accepted=tvm.model_dump(by_alias=True),
        payload={"signature": "0x123"},
    )
    resource_server = _matching_resource_server(
        verify_payment=AsyncMock(return_value=Mock(is_valid=True)),
        settle_payment=AsyncMock(
            return_value=SettleResponse(success=True, transaction="0xtx123", network="tvm:-3")
        ),
    )

    wrapper = create_payment_wrapper(resource_server, accepts=[evm, tvm])

    @wrapper
    async def paid_tool() -> str:
        return "ok"

    result = await paid_tool(
        ctx=MockFastMCPContext({MCP_PAYMENT_META_KEY: payload.model_dump(by_alias=True)})
    )

    assert result.isError is False
    assert resource_server.verify_payment.call_args.args[1].network == "tvm:-3"
    assert resource_server.settle_payment.call_args.args[1].network == "tvm:-3"


@pytest.mark.asyncio
async def test_fastmcp_returns_payment_required_when_no_accept_matches():
    """A payload that matches none of the advertised accepts must not be verified."""
    evm = PaymentRequirements(
        scheme="exact",
        network="eip155:84532",
        amount="1000",
        asset="USDC",
        pay_to="0xevm",
        max_timeout_seconds=300,
    )
    tvm = PaymentRequirements(
        scheme="exact",
        network="tvm:-3",
        amount="1000",
        asset="TON",
        pay_to="0xtvm",
        max_timeout_seconds=300,
    )
    payload = PaymentPayload(
        x402_version=2,
        accepted=tvm.model_dump(by_alias=True),
        payload={"signature": "0x123"},
    )
    resource_server = _matching_resource_server(verify_payment=AsyncMock())

    wrapper = create_payment_wrapper(resource_server, accepts=[evm])

    @wrapper
    async def paid_tool() -> str:
        return "ok"

    result = await paid_tool(
        ctx=MockFastMCPContext({MCP_PAYMENT_META_KEY: payload.model_dump(by_alias=True)})
    )

    assert result.isError is True
    resource_server.verify_payment.assert_not_called()
    assert "No matching payment requirements" in result.structuredContent["error"]


@pytest.mark.asyncio
async def test_fastmcp_payment_required_omits_null_optional_fields():
    """Unset optional fields must not serialize as explicit null (exclude_none)."""
    requirements = PaymentRequirements(
        scheme="exact",
        network="eip155:84532",
        amount="1000",
        asset="USDC",
        pay_to="0xrecipient",
        max_timeout_seconds=300,
    )
    resource_server = Mock()

    wrapper = create_payment_wrapper(
        resource_server,
        accepts=[requirements],
        resource=ResourceInfo(url="mcp://tool/get_weather"),
    )

    @wrapper
    async def paid_tool() -> str:
        return "ok"

    # No payment in context -> payment required result.
    result = await paid_tool(ctx=MockFastMCPContext({}))

    assert result.isError is True
    # Optional ResourceInfo fields (description, mimeType, ...) default to None and
    # must be stripped rather than emitted as null.
    assert result.structuredContent["resource"] == {"url": "mcp://tool/get_weather"}
    assert all(value is not None for value in result.structuredContent["accepts"][0].values())
