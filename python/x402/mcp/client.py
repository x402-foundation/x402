"""MCP client-side x402 payment wrapper.

Provides create_x402_mcp_client() to create an MCP client session
that automatically handles x402 payment flows.

Example:
    ```python
    from x402 import x402Client
    from x402.mcp import create_x402_mcp_client

    client = x402Client()
    # ... register schemes ...

    async with create_x402_mcp_client(client, "http://localhost:4022") as mcp:
        result = await mcp.call_tool("get_weather", {"city": "San Francisco"})
        print(result.content)           # Tool response content
        print(result.payment_response)  # SettleResponse from payment
        print(result.payment_made)      # True if payment was made
    ```
"""

from __future__ import annotations

import json
import re
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

from ..client import x402Client, x402ClientSync
from ..schemas.payments import PaymentRequired
from ..schemas.responses import SettleResponse
from .constants import MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY
from .utils import (
    convert_mcp_result,
    extract_payment_required_from_result,
    extract_payment_response_from_meta,
)

__all__ = [
    "create_x402_mcp_client",
    "x402MCPSession",
    "x402MCPClientSync",
    "MCPToolCallResult",
]


@dataclass
class MCPToolCallResult:
    """Result of an MCP tool call with x402 payment support.

    Attributes:
        content: List of MCP content items from the tool response.
        is_error: Whether the tool returned an error.
        payment_response: Settlement response if payment was made, else None.
        payment_made: Whether a payment was made during this call.
        raw_result: The raw MCP CallToolResult for advanced use.
    """

    content: list[Any] = field(default_factory=list)
    is_error: bool = False
    payment_response: SettleResponse | dict | None = None
    payment_made: bool = False
    raw_result: Any = None


class x402MCPSession:
    """Wraps an MCP ClientSession with automatic x402 payment handling.

    Provides ``call_tool()`` which transparently handles the x402 payment
    flow: first call without payment, detect 402, create payment, retry.
    """

    def __init__(
        self,
        session: Any,
        x402_client: x402Client,
        auto_payment: bool = True,
    ) -> None:
        self._session = session
        self._x402_client = x402_client
        self._auto_payment = auto_payment

    async def initialize(self) -> None:
        """Initialize the MCP session."""
        await self._session.initialize()

    async def list_tools(self) -> Any:
        """List available tools from the MCP server."""
        return await self._session.list_tools()

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
    ) -> MCPToolCallResult:
        """Call a tool with automatic x402 payment handling.

        1. Calls the tool without payment
        2. If the server returns payment required (isError=True), creates a payment
        3. Retries with payment attached in ``_meta``
        4. Returns the result with payment response extracted

        Args:
            name: Tool name to call.
            arguments: Arguments to pass to the tool.

        Returns:
            MCPToolCallResult with content, payment info, and error status.
        """
        # First call without payment
        result = await self._session.call_tool(
            name=name,
            arguments=arguments or {},
        )

        # If no error, return directly
        if not result.isError:
            return self._build_result(result, payment_made=False)

        # Try to extract payment required from error content
        payment_required = self._extract_payment_required(result)
        if payment_required is None:
            return self._build_result(result, payment_made=False)

        if not self._auto_payment:
            return self._build_result(result, payment_made=False)

        # Create payment payload using the x402 client
        payment_payload = await self._x402_client.create_payment_payload(payment_required)

        # Serialize for transmission
        payload_dict = payment_payload.model_dump(by_alias=True)

        # Retry with payment in _meta
        result = await self._session.call_tool(
            name=name,
            arguments=arguments or {},
            meta={MCP_PAYMENT_META_KEY: payload_dict},
        )

        return self._build_result(result, payment_made=True)

    def _build_result(self, result: Any, payment_made: bool) -> MCPToolCallResult:
        """Convert MCP result to MCPToolCallResult."""
        payment_response = None
        if hasattr(result, "meta") and result.meta:
            meta_dict = dict(result.meta) if not isinstance(result.meta, dict) else result.meta
            pr = meta_dict.get(MCP_PAYMENT_RESPONSE_META_KEY)
            if pr:
                try:
                    payment_response = SettleResponse.model_validate(pr)
                except Exception:
                    payment_response = pr

        return MCPToolCallResult(
            content=list(result.content) if result.content else [],
            is_error=getattr(result, "isError", False),
            payment_response=payment_response,
            payment_made=payment_made,
            raw_result=result,
        )

    def _extract_payment_required(self, result: Any) -> PaymentRequired | None:
        """Extract PaymentRequired from an error result.

        Prefers ``structuredContent`` (per spec), falls back to parsing
        ``content[0].text`` as JSON.  Also handles FastMCP-wrapped error
        formats via regex fallback.
        """
        # Preferred path: check structuredContent first (per MCP x402 spec)
        if hasattr(result, "structuredContent") and result.structuredContent:
            sc = result.structuredContent
            if isinstance(sc, dict) and "accepts" in sc and "x402Version" in sc:
                try:
                    return PaymentRequired.model_validate(sc)
                except Exception:
                    pass

        # Fallback: parse content[].text as JSON
        if not hasattr(result, "content") or not result.content:
            return None

        for item in result.content:
            if not hasattr(item, "text"):
                continue
            parsed = _try_extract_payment_json(item.text)
            if parsed:
                try:
                    return PaymentRequired.model_validate(parsed)
                except Exception:
                    pass

        return None


class x402MCPClientSync:
    """Sync x402-enabled MCP client that handles payment for tool calls.

    Wraps a sync MCP client to automatically detect 402 (payment required)
    errors and retry with payment. Use with x402ClientSync for sync payment creation.
    """

    def __init__(
        self,
        mcp_client: Any,
        payment_client: x402ClientSync,
        *,
        auto_payment: bool = True,
        on_payment_requested: Any = None,
    ) -> None:
        """Initialize sync x402 MCP client.

        Args:
            mcp_client: Underlying sync MCP client with call_tool(params, **kwargs)
            payment_client: x402 sync payment client
            auto_payment: Whether to automatically create and submit payment
            on_payment_requested: Optional callback for payment approval
        """
        self._mcp_client = mcp_client
        self._payment_client = payment_client
        self._auto_payment = auto_payment
        self._on_payment_requested = on_payment_requested

    def call_tool(
        self,
        name: str,
        args: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> MCPToolCallResult:
        """Call a tool with automatic payment handling (sync).

        Args:
            name: Tool name
            args: Tool arguments
            **kwargs: Additional MCP client options

        Returns:
            MCPToolCallResult with content, payment info, and error status
        """
        args = args or {}
        params = {"name": name, "arguments": args}

        result = self._mcp_client.call_tool(params, **kwargs)
        mcp_result = convert_mcp_result(result)

        payment_required = extract_payment_required_from_result(mcp_result)
        if payment_required is None:
            return self._build_result(mcp_result, payment_made=False)

        if not self._auto_payment:
            return self._build_result(mcp_result, payment_made=False)

        if self._on_payment_requested:
            approved = self._on_payment_requested(
                type("Ctx", (), {"payment_required": payment_required})()
            )
            if not approved:
                return self._build_result(mcp_result, payment_made=False)

        payment_payload = self._payment_client.create_payment_payload(payment_required)
        payload_dict = payment_payload.model_dump(by_alias=True)

        params_with_meta = {
            "name": name,
            "arguments": args,
            "_meta": {MCP_PAYMENT_META_KEY: payload_dict},
        }
        result = self._mcp_client.call_tool(params_with_meta, **kwargs)
        mcp_result = convert_mcp_result(result)
        return self._build_result(mcp_result, payment_made=True)

    def _build_result(self, mcp_result: Any, payment_made: bool) -> MCPToolCallResult:
        """Build MCPToolCallResult from MCPToolResult."""
        payment_response = extract_payment_response_from_meta(mcp_result)
        return MCPToolCallResult(
            content=mcp_result.content,
            is_error=mcp_result.is_error,
            payment_response=payment_response,
            payment_made=payment_made,
            raw_result=mcp_result,
        )


@asynccontextmanager
async def create_x402_mcp_client(
    x402_client: x402Client,
    server_url: str,
    *,
    auto_payment: bool = True,
):
    """Create an MCP client session with automatic x402 payment handling.

    This is an async context manager that connects to an MCP server via SSE
    and provides a session with transparent payment handling.

    Args:
        x402_client: A configured ``x402Client`` with schemes registered.
        server_url: The MCP server URL (``/sse`` is appended if needed).
        auto_payment: If True (default), automatically creates and sends
            payments when the server requires them.

    Yields:
        An ``x402MCPSession`` with ``call_tool()`` for paid tool calls.

    Example:
        ```python
        async with create_x402_mcp_client(client, "http://localhost:4022") as mcp:
            result = await mcp.call_tool("get_weather", {"city": "SF"})
        ```
    """
    from mcp.client.sse import sse_client

    from mcp import ClientSession

    sse_url = server_url.rstrip("/")
    if not sse_url.endswith("/sse"):
        sse_url += "/sse"

    async with sse_client(sse_url) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            mcp_session = x402MCPSession(session, x402_client, auto_payment)
            await mcp_session.initialize()
            yield mcp_session


def _try_extract_payment_json(text: str) -> dict | None:
    """Try to extract payment required JSON from text.

    Handles both raw JSON and FastMCP-wrapped error format like:
    ``Error executing tool get_weather: {"x402Version": 2, "accepts": [...]}``
    """
    # Try direct parse first
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict) and "accepts" in parsed:
            return parsed
    except (json.JSONDecodeError, TypeError):
        pass

    # Try to extract JSON from FastMCP error wrapper
    match = re.search(r'\{.*"accepts"\s*:\s*\[.*\].*\}', text, re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, dict) and "accepts" in parsed:
                return parsed
        except (json.JSONDecodeError, TypeError):
            pass

    return None
