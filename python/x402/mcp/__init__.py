"""x402 MCP integration - payment protocol for MCP tool calls.

Provides server-side and client-side wrappers for adding x402 payment
handling to MCP (Model Context Protocol) tools.

Requires the 'mcp' optional dependency: pip install x402[mcp]

Server-side:
    ```python
    from x402.mcp import create_payment_wrapper

    wrapper = create_payment_wrapper(
        resource_server,
        accepts=weather_accepts,
        resource=ResourceInfo(url="mcp://tool/get_weather"),
    )

    @mcp.tool(name="get_weather", description="Get weather")
    @wrapper
    async def get_weather(city: str) -> str:
        return json.dumps({"city": city, "weather": "sunny"})
    ```

Client-side:
    ```python
    from x402.mcp import create_x402_mcp_client

    async with create_x402_mcp_client(client, "http://localhost:4022") as mcp:
        result = await mcp.call_tool("get_weather", {"city": "SF"})
    ```
"""

from __future__ import annotations

from .constants import (
    MCP_PAYMENT_META_KEY,
    MCP_PAYMENT_RESPONSE_META_KEY,
)

# Lazy imports to avoid requiring mcp at import time
__all__ = [
    # Server
    "create_payment_wrapper",
    "create_payment_wrapper_sync",
    "PaymentWrapperConfig",
    "PaymentWrapperHooks",
    "ResourceInfo",
    "SyncPaymentWrapperConfig",
    # Client
    "create_x402_mcp_client",
    "create_x402_mcp_client_from_config",
    "wrap_mcp_client_with_payment",
    "wrap_mcp_client_with_payment_from_config",
    "x402MCPSession",
    "x402MCPClient",
    "x402MCPClientSync",
    "MCPToolCallResult",
    "MCPToolResult",
    # Constants
    "MCP_PAYMENT_META_KEY",
    "MCP_PAYMENT_RESPONSE_META_KEY",
    "PaymentRequiredError",
    # Utils
    "is_object",
    "create_payment_required_error",
    "extract_payment_required_from_error",
]


def __getattr__(name: str):
    """Lazy import MCP components to avoid requiring mcp at import time."""
    if name == "create_payment_wrapper":
        from .server import create_payment_wrapper

        return create_payment_wrapper
    if name == "create_payment_wrapper_sync":
        from .server_sync import create_payment_wrapper_sync

        return create_payment_wrapper_sync
    if name == "PaymentWrapperConfig":
        from .server_async import PaymentWrapperConfig

        return PaymentWrapperConfig
    if name == "PaymentWrapperHooks":
        from .types import PaymentWrapperHooks

        return PaymentWrapperHooks
    if name == "ResourceInfo":
        from .types import ResourceInfo

        return ResourceInfo
    if name == "SyncPaymentWrapperConfig":
        from .types import SyncPaymentWrapperConfig

        return SyncPaymentWrapperConfig
    if name in ("create_x402_mcp_client", "x402MCPSession", "MCPToolCallResult"):
        from . import client as _client

        return getattr(_client, name)
    if name in (
        "create_x402_mcp_client_from_config",
        "wrap_mcp_client_with_payment",
        "wrap_mcp_client_with_payment_from_config",
    ):
        from . import client_async as _client_async

        return getattr(_client_async, name)
    if name == "MCPToolResult":
        from .types import MCPToolResult

        return MCPToolResult
    if name == "x402MCPClient":
        from . import client_async as _client_async

        return _client_async.x402MCPClient
    if name == "x402MCPClientSync":
        from . import client as _client

        return _client.x402MCPClientSync
    if name == "PaymentRequiredError":
        from .types import PaymentRequiredError

        return PaymentRequiredError
    if name in (
        "is_object",
        "create_payment_required_error",
        "extract_payment_required_from_error",
    ):
        from . import utils as _utils

        return getattr(_utils, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
