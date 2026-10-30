"""Tests for the FastMCP payment wrapper."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from mcp.types import CallToolResult, ContentBlock, ImageContent, TextContent
from x402.mcp.constants import MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY
from x402.mcp.server import create_payment_wrapper
from x402.mcp.types import PaymentWrapperHooks
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
@pytest.mark.parametrize(
    "content",
    [
        [TextContent(type="text", text="first"), TextContent(type="text", text="second")],
        [ImageContent(type="image", data="aW1hZ2U=", mimeType="image/png")],
        [],
    ],
    ids=["multiple-text", "image", "empty"],
)
@pytest.mark.parametrize("is_error", [False, True], ids=["success", "handler-error"])
async def test_fastmcp_wrapper_preserves_call_tool_result(
    content: list[ContentBlock], is_error: bool
) -> None:
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
        accepted=requirements,
        payload={"signature": "0x123"},
    )
    settlement = SettleResponse(
        success=True,
        transaction="0xtx123",
        network=requirements.network,
    )
    resource_server = _matching_resource_server(
        verify_payment=AsyncMock(return_value=Mock(is_valid=True)),
        settle_payment=AsyncMock(return_value=settlement),
    )
    after_execution = Mock()
    original = CallToolResult(
        content=content,
        structuredContent={"answer": 42},
        isError=is_error,
        _meta={"traceId": "trace-123", MCP_PAYMENT_RESPONSE_META_KEY: {"success": False}},
    )
    original_data = original.model_dump(by_alias=True)
    wrapper = create_payment_wrapper(
        resource_server,
        accepts=[requirements],
        hooks=PaymentWrapperHooks(on_after_execution=after_execution),
    )

    @wrapper
    async def paid_tool() -> CallToolResult:
        return original

    result = await paid_tool(
        ctx=MockFastMCPContext({MCP_PAYMENT_META_KEY: payload.model_dump(by_alias=True)})
    )

    assert result.content == original.content
    assert result.structuredContent == {"answer": 42}
    assert result.isError is is_error
    assert result.meta["traceId"] == "trace-123"
    assert original.model_dump(by_alias=True) == original_data
    after_execution.assert_called_once()
    hook_result = after_execution.call_args.args[0].result
    assert hook_result.content == original.model_dump(by_alias=True, exclude_none=True)["content"]
    assert hook_result.structured_content == {"answer": 42}
    assert hook_result.is_error is is_error
    assert hook_result.meta == original.meta
    if is_error:
        assert result is original
        resource_server.settle_payment.assert_not_awaited()
    else:
        resource_server.settle_payment.assert_awaited_once_with(payload, requirements)
        assert result is not original
        assert result.meta[MCP_PAYMENT_RESPONSE_META_KEY] == settlement.model_dump(
            by_alias=True, exclude_none=True
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("raises", [False, True], ids=["refused", "exception"])
async def test_fastmcp_wrapper_withholds_tool_result_when_settlement_fails(raises: bool) -> None:
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
        accepted=requirements,
        payload={"signature": "0x123"},
    )
    resource_server = _matching_resource_server(
        verify_payment=AsyncMock(return_value=Mock(is_valid=True)),
        settle_payment=AsyncMock(
            return_value=SettleResponse(
                success=False,
                error_reason="insufficient_balance",
                transaction="",
                network=requirements.network,
            ),
            side_effect=RuntimeError("settle unavailable") if raises else None,
        ),
    )
    original = CallToolResult(
        content=[ImageContent(type="image", data="aW1hZ2U=", mimeType="image/png")],
        structuredContent={"secret": "paid result"},
        _meta={"private": "handler metadata"},
    )
    original_data = original.model_dump(by_alias=True)
    wrapper = create_payment_wrapper(resource_server, accepts=[requirements])

    @wrapper
    async def paid_tool() -> CallToolResult:
        return original

    result = await paid_tool(
        ctx=MockFastMCPContext({MCP_PAYMENT_META_KEY: payload.model_dump(by_alias=True)})
    )

    resource_server.settle_payment.assert_awaited_once_with(payload, requirements)
    assert result.isError is True
    assert all(block.type == "text" for block in result.content)
    assert result.structuredContent["x402Version"] == 2
    assert result.structuredContent[MCP_PAYMENT_RESPONSE_META_KEY]["success"] is False
    assert "secret" not in result.structuredContent
    assert result.meta is None
    assert original.model_dump(by_alias=True) == original_data


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
