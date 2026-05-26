"""Regression tests for MCP server wrapper payment-required responses."""

from __future__ import annotations

import pytest

from x402.mcp.constants import MCP_PAYMENT_RESPONSE_META_KEY
from x402.mcp.server import _create_settlement_failed_result
from x402.mcp.server_async import (
    PaymentWrapperConfig,
    _create_settlement_failed_result_async,
)
from x402.mcp.server_sync import _create_settlement_failed_result_sync
from x402.mcp.types import SyncPaymentWrapperConfig
from x402.schemas import PaymentRequirements, ResourceInfo


def make_payment_requirements() -> PaymentRequirements:
    """Helper to create valid payment requirements."""
    return PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0x0000000000000000000000000000000000000000",
        amount="1000000",
        pay_to="0x1234567890123456789012345678901234567890",
        max_timeout_seconds=300,
    )


class MockAsyncResourceServer:
    """Minimal async resource server for settlement failure helper tests."""

    def __init__(self):
        self.last_extensions = None

    async def create_payment_required_response(  # noqa: PLR0913
        self,
        accepts,
        resource,
        error_message,
        extensions=None,
    ):
        self.last_extensions = extensions
        return {
            "x402Version": 2,
            "accepts": [req.model_dump(by_alias=True) for req in accepts],
            "error": error_message,
            "resource": resource.model_dump(by_alias=True),
            "extensions": extensions,
        }


class MockSyncResourceServer:
    """Minimal sync resource server for settlement failure helper tests."""

    def __init__(self):
        self.last_extensions = None

    def create_payment_required_response(  # noqa: PLR0913
        self,
        accepts,
        resource,
        error_message,
        extensions=None,
    ):
        self.last_extensions = extensions
        return {
            "x402Version": 2,
            "accepts": [req.model_dump(by_alias=True) for req in accepts],
            "error": error_message,
            "resource": resource.model_dump(by_alias=True),
            "extensions": extensions,
        }


@pytest.mark.asyncio
async def test_async_settlement_failure_preserves_extensions() -> None:
    """Settlement failure 402 keeps extensions in async wrapper path."""
    server = MockAsyncResourceServer()
    extensions = {
        "bazaar": {
            "info": {
                "input": {
                    "type": "mcp",
                    "toolName": "get_weather",
                    "inputSchema": {"type": "object"},
                }
            },
            "schema": {"type": "object"},
        }
    }
    config = PaymentWrapperConfig(
        accepts=[make_payment_requirements()],
        extensions=extensions,
    )

    result = await _create_settlement_failed_result_async(
        server,
        "get_weather",
        config,
        "settle exploded",
    )

    assert server.last_extensions == extensions
    assert result.structured_content is not None
    assert result.structured_content["extensions"] == extensions
    assert result.structured_content[MCP_PAYMENT_RESPONSE_META_KEY]["success"] is False


def test_sync_settlement_failure_preserves_extensions() -> None:
    """Settlement failure 402 keeps extensions in sync wrapper path."""
    server = MockSyncResourceServer()
    extensions = {
        "bazaar": {
            "info": {
                "input": {
                    "type": "mcp",
                    "toolName": "get_weather",
                    "inputSchema": {"type": "object"},
                }
            },
            "schema": {"type": "object"},
        }
    }
    config = SyncPaymentWrapperConfig(
        accepts=[make_payment_requirements()],
        extensions=extensions,
    )

    result = _create_settlement_failed_result_sync(
        server,
        "get_weather",
        config,
        "settle exploded",
    )

    assert server.last_extensions == extensions
    assert result.structured_content is not None
    assert result.structured_content["extensions"] == extensions
    assert result.structured_content[MCP_PAYMENT_RESPONSE_META_KEY]["success"] is False


def test_fastmcp_settlement_failure_preserves_extensions() -> None:
    """Settlement failure 402 keeps extensions in FastMCP wrapper path."""
    extensions = {
        "bazaar": {
            "info": {
                "input": {
                    "type": "mcp",
                    "toolName": "get_weather",
                    "inputSchema": {"type": "object"},
                }
            },
            "schema": {"type": "object"},
        }
    }
    result = _create_settlement_failed_result(
        accepts=[make_payment_requirements()],
        resource=ResourceInfo(
            url="mcp://tool/get_weather",
            description="Tool: get_weather",
            mime_type="application/json",
        ),
        error_message="settle exploded",
        extensions=extensions,
    )

    assert result.structuredContent is not None
    assert result.structuredContent["extensions"] == extensions
    assert result.structuredContent[MCP_PAYMENT_RESPONSE_META_KEY]["success"] is False
