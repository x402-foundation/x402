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

import warnings
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from ..client import x402Client, x402ClientSync
from ..schemas import PaymentPayload, PaymentRequired
from ..schemas.responses import SettleResponse
from .constants import MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY
from .types import (
    AfterPaymentContext,
    PaymentRequiredContext,
    PaymentRequiredError,
    SyncAfterPaymentHook,
    SyncBeforePaymentHook,
    SyncPaymentRequiredHook,
)
from .utils import (
    attach_payment_to_meta,
    convert_mcp_result,
    extract_payment_required_from_result,
    extract_payment_response_from_meta,
    paid_read_timeout_seconds,
    probe_read_timeout_seconds,
    resolve_max_request_timeout_seconds,
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
        max_request_timeout_seconds: int | None = None,
    ) -> None:
        self._session = session
        self._x402_client = x402_client
        self._auto_payment = auto_payment
        self._max_request_timeout_seconds = resolve_max_request_timeout_seconds(
            max_request_timeout_seconds
        )

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
        read_timeout_seconds: timedelta | None = None,
    ) -> MCPToolCallResult:
        """Call a tool with automatic x402 payment handling.

        1. Calls the tool without payment
        2. If the server returns payment required (isError=True), creates a payment
        3. Retries with payment attached in ``_meta``
        4. Returns the result with payment response extracted

        Args:
            name: Tool name to call.
            arguments: Arguments to pass to the tool.
            read_timeout_seconds: Per-call MCP timeout; overrides accept and cap.

        Returns:
            MCPToolCallResult with content, payment info, and error status.
        """
        probe_timeout = probe_read_timeout_seconds(
            read_timeout_seconds, self._max_request_timeout_seconds
        )
        # First call without payment
        result = await self._session.call_tool(
            name=name,
            arguments=arguments or {},
            read_timeout_seconds=probe_timeout,
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

        accepted = payment_payload.accepted
        max_timeout_seconds = accepted.max_timeout_seconds if accepted is not None else None
        paid_timeout = paid_read_timeout_seconds(
            read_timeout_seconds,
            max_timeout_seconds,
            self._max_request_timeout_seconds,
        )

        # Retry with payment in _meta
        result = await self._session.call_tool(
            name=name,
            arguments=arguments or {},
            meta={MCP_PAYMENT_META_KEY: payload_dict},
            read_timeout_seconds=paid_timeout,
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

    def _extract_payment_required(self, result: Any) -> Any:
        """Extract PaymentRequired (x402 v1 or v2) from an error result.

        Shares ``extract_payment_required_from_result`` with the sync and async
        clients so content[1] and FastMCP-wrapped text refuse the same way.
        Raises PaymentRequiredMismatchError when structuredContent and content
        text both parse but disagree.
        """
        return extract_payment_required_from_result(convert_mcp_result(result))


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
        on_payment_requested: Callable[[PaymentRequiredContext], bool] | None = None,
        max_request_timeout_seconds: int | None = None,
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
        self._max_request_timeout_seconds = resolve_max_request_timeout_seconds(
            max_request_timeout_seconds
        )
        self._payment_required_hooks: list[SyncPaymentRequiredHook] = []
        self._before_payment_hooks: list[SyncBeforePaymentHook] = []
        self._after_payment_hooks: list[SyncAfterPaymentHook] = []

        if not auto_payment and on_payment_requested is None:
            warnings.warn(
                "x402MCPClientSync created with auto_payment=False and no "
                "on_payment_requested callback. Paid tool calls will raise "
                "PaymentRequiredError unless a payment_required hook is "
                "registered via on_payment_required().",
                stacklevel=2,
            )

    @property
    def client(self) -> Any:
        """Get underlying MCP client."""
        return self._mcp_client

    @property
    def payment_client(self) -> x402ClientSync:
        """Get underlying x402 payment client."""
        return self._payment_client

    def on_payment_required(self, hook: SyncPaymentRequiredHook) -> x402MCPClientSync:
        """Register a hook for payment required events.

        Args:
            hook: Hook function

        Returns:
            Self for chaining
        """
        self._payment_required_hooks.append(hook)
        return self

    def on_before_payment(self, hook: SyncBeforePaymentHook) -> x402MCPClientSync:
        """Register a hook before payment creation.

        Args:
            hook: Hook function

        Returns:
            Self for chaining
        """
        self._before_payment_hooks.append(hook)
        return self

    def on_after_payment(self, hook: SyncAfterPaymentHook) -> x402MCPClientSync:
        """Register a hook after payment submission.

        Args:
            hook: Hook function

        Returns:
            Self for chaining
        """
        self._after_payment_hooks.append(hook)
        return self

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
            **kwargs: MCP client options (``read_timeout_seconds`` overrides accept/cap).

        Returns:
            MCPToolCallResult with content, payment info, and error status

        Raises:
            PaymentRequiredError: If payment is required and no hook, auto_payment
                or on_payment_requested approval lets it go ahead
        """
        args = args or {}
        params = {"name": name, "arguments": args}
        probe_timeout = probe_read_timeout_seconds(
            kwargs.get("read_timeout_seconds"), self._max_request_timeout_seconds
        )
        probe_kwargs = {**kwargs, "read_timeout_seconds": probe_timeout}

        result = self._mcp_client.call_tool(params, **probe_kwargs)
        mcp_result = convert_mcp_result(result)

        payment_required = extract_payment_required_from_result(mcp_result)
        if payment_required is None:
            return self._build_result(mcp_result, payment_made=False)

        payment_required_context = PaymentRequiredContext(
            tool_name=name,
            arguments=args,
            payment_required=payment_required,
        )

        for hook in self._payment_required_hooks:
            hook_result = hook(payment_required_context)
            if hook_result:
                if hook_result.abort:
                    raise PaymentRequiredError("Payment aborted by hook", payment_required)
                if hook_result.payment:
                    return self.call_tool_with_payment(name, args, hook_result.payment, **kwargs)

        if not self._auto_payment:
            raise PaymentRequiredError(
                "Payment required but auto_payment is disabled and no "
                "payment_required hook handled the request. Enable "
                "auto_payment or register a hook via on_payment_required().",
                payment_required,
            )

        if self._on_payment_requested and not self._on_payment_requested(payment_required_context):
            raise PaymentRequiredError("Payment request denied", payment_required)

        for hook in self._before_payment_hooks:
            hook(payment_required_context)

        payment_payload = self._payment_client.create_payment_payload(payment_required)
        return self.call_tool_with_payment(name, args, payment_payload, **kwargs)

    def call_tool_with_payment(
        self,
        name: str,
        args: dict[str, Any],
        payload: PaymentPayload,
        **kwargs: Any,
    ) -> MCPToolCallResult:
        """Call a tool with an explicit payment payload (sync).

        Args:
            name: Tool name
            args: Tool arguments
            payload: Payment payload
            **kwargs: MCP client options (``read_timeout_seconds`` overrides accept/cap).

        Returns:
            MCPToolCallResult with content, payment info, and error status
        """
        params = attach_payment_to_meta({"name": name, "arguments": args}, payload)

        accepted = payload.accepted
        max_timeout_seconds = accepted.max_timeout_seconds if accepted is not None else None
        paid_timeout = paid_read_timeout_seconds(
            kwargs.get("read_timeout_seconds"),
            max_timeout_seconds,
            self._max_request_timeout_seconds,
        )
        paid_kwargs = {**kwargs, "read_timeout_seconds": paid_timeout}
        result = self._mcp_client.call_tool(params, **paid_kwargs)
        mcp_result = convert_mcp_result(result)
        call_result = self._build_result(mcp_result, payment_made=True)

        after_context = AfterPaymentContext(
            tool_name=name,
            payment_payload=payload,
            result=mcp_result,
            settle_response=call_result.payment_response,
        )
        for hook in self._after_payment_hooks:
            hook(after_context)

        return call_result

    def get_tool_payment_requirements(
        self,
        name: str,
        args: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> PaymentRequired | None:
        """Probe a tool to discover its payment requirements (sync).

        WARNING: This actually calls the tool, so it may have side effects.

        Args:
            name: Tool name
            args: Tool arguments
            **kwargs: Additional MCP client options

        Returns:
            PaymentRequired if found, None otherwise
        """
        params = {"name": name, "arguments": args or {}}
        result = self._mcp_client.call_tool(params, **kwargs)
        return extract_payment_required_from_result(convert_mcp_result(result))

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
    max_request_timeout_seconds: int | None = None,
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
            mcp_session = x402MCPSession(
                session,
                x402_client,
                auto_payment,
                max_request_timeout_seconds=max_request_timeout_seconds,
            )
            await mcp_session.initialize()
            yield mcp_session


def wrap_mcp_client_with_payment_sync(
    mcp_client: Any,
    payment_client: x402ClientSync,
    *,
    auto_payment: bool = True,
    on_payment_requested: Any = None,
    max_request_timeout_seconds: int | None = None,
) -> x402MCPClientSync:
    """Wrap an existing sync MCP client with x402 payment handling."""
    return x402MCPClientSync(
        mcp_client,
        payment_client,
        auto_payment=auto_payment,
        on_payment_requested=on_payment_requested,
        max_request_timeout_seconds=max_request_timeout_seconds,
    )


def wrap_mcp_client_with_payment_from_config_sync(
    mcp_client: Any,
    *,
    schemes: list[dict[str, Any]] | None = None,
    config: Any = None,
    auto_payment: bool = True,
    on_payment_requested: Any = None,
    max_request_timeout_seconds: int | None = None,
) -> x402MCPClientSync:
    """Wrap a sync MCP client using ``x402ClientSync.from_config``."""
    from .utils import build_x402_client_config

    config_or_schemes = config if config is not None else (schemes or [])
    payment_client = x402ClientSync.from_config(build_x402_client_config(config_or_schemes))
    return x402MCPClientSync(
        mcp_client,
        payment_client,
        auto_payment=auto_payment,
        on_payment_requested=on_payment_requested,
        max_request_timeout_seconds=max_request_timeout_seconds,
    )
