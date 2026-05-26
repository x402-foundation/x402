"""MCP client wrapper with x402 payment handling (async, default)."""

from __future__ import annotations

import warnings
from collections.abc import Awaitable, Callable
from typing import Any

from ..schemas import PaymentPayload, PaymentRequired
from .types import (
    AfterPaymentContext,
    MCPToolCallResult,
    MCPToolResult,
    PaymentRequiredContext,
    PaymentRequiredError,
    PaymentRequiredHookResult,
)
from .utils import (
    attach_payment_to_meta,
    convert_mcp_result,
    extract_payment_required_from_result,
    extract_payment_response_from_meta,
    register_schemes,
)

# Async hook type aliases
PaymentRequiredHook = Callable[
    [PaymentRequiredContext],
    PaymentRequiredHookResult | Awaitable[PaymentRequiredHookResult],
]
BeforePaymentHook = Callable[[PaymentRequiredContext], None | Awaitable[None]]
AfterPaymentHook = Callable[[AfterPaymentContext], None | Awaitable[None]]


class x402MCPClient:
    """Async x402-enabled MCP client that handles payment for tool calls.

    Wraps an async MCP client to automatically detect 402 (payment required)
    errors from tool calls, create payment payloads, and retry with payment attached.

    This is the async counterpart to x402MCPClientSync, designed for use with
    asyncio-based MCP clients (which is the default for the Python MCP SDK).

    Example:
        ```python
        from x402 import x402ClientAsync
        from x402.mcp import x402MCPClient
        from x402.mechanisms.evm.exact import ExactEvmClientScheme

        # Create async x402 payment client
        payment_client = x402ClientAsync()
        payment_client.register("eip155:84532", ExactEvmClientScheme(signer))

        # Wrap async MCP client
        x402_mcp = x402MCPClient(mcp_client, payment_client, auto_payment=True)

        # Call tools - payment handled automatically
        result = await x402_mcp.call_tool("get_weather", {"city": "NYC"})
        ```
    """

    def __init__(
        self,
        mcp_client: Any,  # Async MCP SDK client
        payment_client: Any,  # x402ClientAsync
        *,
        auto_payment: bool = True,
        on_payment_requested: (
            Callable[[PaymentRequiredContext], bool | Awaitable[bool]] | None
        ) = None,
    ):
        """Initialize async x402 MCP client.

        Args:
            mcp_client: Underlying async MCP SDK client
            payment_client: x402 async payment client
            auto_payment: Whether to automatically create and submit payment
            on_payment_requested: Optional async callback for payment approval
        """
        self._mcp_client = mcp_client
        self._payment_client = payment_client
        self._auto_payment = auto_payment
        self._on_payment_requested = on_payment_requested
        self._payment_required_hooks: list[PaymentRequiredHook] = []
        self._before_payment_hooks: list[BeforePaymentHook] = []
        self._after_payment_hooks: list[AfterPaymentHook] = []

        if not auto_payment and on_payment_requested is None:
            warnings.warn(
                "x402MCPClient created with auto_payment=False and no "
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
    def payment_client(self) -> Any:
        """Get underlying x402 payment client."""
        return self._payment_client

    def on_payment_required(self, hook: PaymentRequiredHook) -> x402MCPClient:
        """Register a hook for payment required events.

        Args:
            hook: Async hook function

        Returns:
            Self for chaining
        """
        self._payment_required_hooks.append(hook)
        return self

    def on_before_payment(self, hook: BeforePaymentHook) -> x402MCPClient:
        """Register a hook before payment creation.

        Args:
            hook: Async hook function

        Returns:
            Self for chaining
        """
        self._before_payment_hooks.append(hook)
        return self

    def on_after_payment(self, hook: AfterPaymentHook) -> x402MCPClient:
        """Register a hook after payment submission.

        Args:
            hook: Async hook function

        Returns:
            Self for chaining
        """
        self._after_payment_hooks.append(hook)
        return self

    async def call_tool(
        self,
        name: str,
        args: dict[str, Any],
        **kwargs: Any,
    ) -> MCPToolCallResult:
        """Call a tool with automatic payment handling.

        Args:
            name: Tool name
            args: Tool arguments
            **kwargs: Additional MCP client options

        Returns:
            Tool call result with payment metadata

        Raises:
            PaymentRequiredError: If payment required but auto_payment disabled
        """
        # First attempt without payment
        call_params = {"name": name, "arguments": args}
        result = await self._call_mcp_tool(call_params, **kwargs)

        # Check if this is a payment required response
        payment_required = extract_payment_required_from_result(result)

        if payment_required is None:
            # Free tool - return as-is
            return MCPToolCallResult(
                content=result.content,
                is_error=result.is_error,
                payment_made=False,
            )

        # Payment required - run hooks first
        payment_required_context = PaymentRequiredContext(
            tool_name=name,
            arguments=args,
            payment_required=payment_required,
        )

        # Run payment required hooks
        for hook in self._payment_required_hooks:
            hook_result = hook(payment_required_context)
            if hasattr(hook_result, "__await__"):
                hook_result = await hook_result
            if hook_result:
                if hook_result.abort:
                    raise PaymentRequiredError("Payment aborted by hook", payment_required)
                if hook_result.payment:
                    return await self.call_tool_with_payment(
                        name, args, hook_result.payment, **kwargs
                    )

        # No hook handled it, proceed with normal flow
        if not self._auto_payment:
            raise PaymentRequiredError(
                "Payment required but auto_payment is disabled and no "
                "payment_required hook handled the request. Enable "
                "auto_payment or register a hook via on_payment_required().",
                payment_required,
            )

        # Check if payment is approved
        if self._on_payment_requested:
            approved = self._on_payment_requested(payment_required_context)
            if hasattr(approved, "__await__"):
                approved = await approved
            if not approved:
                raise PaymentRequiredError("Payment request denied", payment_required)

        # Run before payment hooks
        for hook in self._before_payment_hooks:
            result_or_coro = hook(payment_required_context)
            if hasattr(result_or_coro, "__await__"):
                await result_or_coro

        # Create payment payload (async)
        create_method = self._payment_client.create_payment_payload
        payment_payload = create_method(payment_required)
        if hasattr(payment_payload, "__await__"):
            payment_payload = await payment_payload

        # Retry with payment
        return await self.call_tool_with_payment(name, args, payment_payload, **kwargs)

    async def call_tool_with_payment(
        self,
        name: str,
        args: dict[str, Any],
        payload: PaymentPayload,
        **kwargs: Any,
    ) -> MCPToolCallResult:
        """Call a tool with explicit payment payload.

        Args:
            name: Tool name
            args: Tool arguments
            payload: Payment payload
            **kwargs: Additional MCP client options

        Returns:
            Tool call result with payment metadata
        """
        # Build call params with payment in _meta
        call_params = attach_payment_to_meta({"name": name, "arguments": args}, payload)

        # Call with payment
        result = await self._call_mcp_tool(call_params, **kwargs)

        # Extract payment response
        settle_response = extract_payment_response_from_meta(result)

        # Run after payment hooks
        after_context = AfterPaymentContext(
            tool_name=name,
            payment_payload=payload,
            result=result,
            settle_response=settle_response,
        )
        for hook in self._after_payment_hooks:
            result_or_coro = hook(after_context)
            if hasattr(result_or_coro, "__await__"):
                await result_or_coro

        return MCPToolCallResult(
            content=result.content,
            is_error=result.is_error,
            payment_response=settle_response,
            payment_made=True,
        )

    async def get_tool_payment_requirements(
        self,
        name: str,
        args: dict[str, Any],
        **kwargs: Any,
    ) -> PaymentRequired | None:
        """Probe a tool to discover its payment requirements.

        WARNING: This actually calls the tool, so it may have side effects.

        Args:
            name: Tool name
            args: Tool arguments
            **kwargs: Additional MCP client options

        Returns:
            PaymentRequired if found, None otherwise
        """
        call_params = {"name": name, "arguments": args}
        result = await self._call_mcp_tool(call_params, **kwargs)
        return extract_payment_required_from_result(result)

    async def _call_mcp_tool(self, params: dict[str, Any], **kwargs: Any) -> MCPToolResult:
        """Call underlying async MCP client tool method.

        Args:
            params: Tool call parameters
            **kwargs: Additional options

        Returns:
            MCP tool result
        """
        # Call the underlying MCP client's call_tool method (async)
        mcp_result = await self._mcp_client.call_tool(params, **kwargs)

        # Convert to our MCPToolResult format
        return convert_mcp_result(mcp_result)

    # Passthrough methods - forward to underlying async MCP client

    async def connect(self, transport: Any) -> None:
        """Connect to an MCP server transport."""
        if hasattr(self._mcp_client, "connect"):
            await self._mcp_client.connect(transport)

    async def close(self) -> None:
        """Close the MCP connection."""
        if hasattr(self._mcp_client, "close"):
            await self._mcp_client.close()

    async def list_tools(self) -> Any:
        """List available tools from the server."""
        if hasattr(self._mcp_client, "list_tools"):
            return await self._mcp_client.list_tools()
        raise NotImplementedError("MCP client does not support list_tools")

    async def list_resources(self) -> Any:
        """List available resources from the server."""
        if hasattr(self._mcp_client, "list_resources"):
            return await self._mcp_client.list_resources()
        raise NotImplementedError("MCP client does not support list_resources")

    async def read_resource(self, uri: str) -> Any:
        """Read a resource from the server."""
        if hasattr(self._mcp_client, "read_resource"):
            return await self._mcp_client.read_resource(uri)
        raise NotImplementedError("MCP client does not support read_resource")

    async def list_resource_templates(self) -> Any:
        """List resource templates from the server."""
        if hasattr(self._mcp_client, "list_resource_templates"):
            return await self._mcp_client.list_resource_templates()
        raise NotImplementedError("MCP client does not support list_resource_templates")

    async def subscribe_resource(self, uri: str) -> None:
        """Subscribe to resource updates."""
        if hasattr(self._mcp_client, "subscribe_resource"):
            await self._mcp_client.subscribe_resource(uri)
        else:
            raise NotImplementedError("MCP client does not support subscribe_resource")

    async def unsubscribe_resource(self, uri: str) -> None:
        """Unsubscribe from resource updates."""
        if hasattr(self._mcp_client, "unsubscribe_resource"):
            await self._mcp_client.unsubscribe_resource(uri)
        else:
            raise NotImplementedError("MCP client does not support unsubscribe_resource")

    async def list_prompts(self) -> Any:
        """List available prompts from the server."""
        if hasattr(self._mcp_client, "list_prompts"):
            return await self._mcp_client.list_prompts()
        raise NotImplementedError("MCP client does not support list_prompts")

    async def get_prompt(self, name: str) -> Any:
        """Get a specific prompt from the server."""
        if hasattr(self._mcp_client, "get_prompt"):
            return await self._mcp_client.get_prompt(name)
        raise NotImplementedError("MCP client does not support get_prompt")

    async def ping(self) -> None:
        """Ping the server."""
        if hasattr(self._mcp_client, "ping"):
            await self._mcp_client.ping()
        else:
            raise NotImplementedError("MCP client does not support ping")

    async def complete(self, prompt: str, cursor: int) -> Any:
        """Request completion suggestions."""
        if hasattr(self._mcp_client, "complete"):
            return await self._mcp_client.complete(prompt, cursor)
        raise NotImplementedError("MCP client does not support complete")

    async def set_logging_level(self, level: str) -> None:
        """Set the logging level on the server."""
        if hasattr(self._mcp_client, "set_logging_level"):
            await self._mcp_client.set_logging_level(level)
        else:
            raise NotImplementedError("MCP client does not support set_logging_level")

    async def get_server_capabilities(self) -> Any:
        """Get server capabilities after initialization."""
        if hasattr(self._mcp_client, "get_server_capabilities"):
            return await self._mcp_client.get_server_capabilities()
        raise NotImplementedError("MCP client does not support get_server_capabilities")

    async def get_server_version(self) -> Any:
        """Get server version information after initialization."""
        if hasattr(self._mcp_client, "get_server_version"):
            return await self._mcp_client.get_server_version()
        raise NotImplementedError("MCP client does not support get_server_version")

    async def get_instructions(self) -> str:
        """Get server instructions after initialization."""
        if hasattr(self._mcp_client, "get_instructions"):
            return await self._mcp_client.get_instructions()
        raise NotImplementedError("MCP client does not support get_instructions")

    async def send_roots_list_changed(self) -> None:
        """Send notification that roots list has changed."""
        if hasattr(self._mcp_client, "send_roots_list_changed"):
            await self._mcp_client.send_roots_list_changed()
        else:
            raise NotImplementedError("MCP client does not support send_roots_list_changed")


# ============================================================================
# Async Factory Functions
# ============================================================================


def create_x402_mcp_client(
    mcp_client: Any,
    payment_client: Any,
    *,
    auto_payment: bool = True,
    on_payment_requested: (
        Callable[[PaymentRequiredContext], bool | Awaitable[bool]] | None
    ) = None,
) -> x402MCPClient:
    """Create a new async x402MCPClient instance.

    Note: This is a sync factory function -- the returned client has async methods.

    Args:
        mcp_client: Underlying async MCP SDK client
        payment_client: x402 async payment client
        auto_payment: Whether to automatically create and submit payment
        on_payment_requested: Optional async callback for payment approval

    Returns:
        x402MCPClient instance
    """
    return x402MCPClient(
        mcp_client,
        payment_client,
        auto_payment=auto_payment,
        on_payment_requested=on_payment_requested,
    )


def wrap_mcp_client_with_payment(
    mcp_client: Any,
    payment_client: Any,
    *,
    auto_payment: bool = True,
    on_payment_requested: (
        Callable[[PaymentRequiredContext], bool | Awaitable[bool]] | None
    ) = None,
) -> x402MCPClient:
    """Wrap an existing async MCP client with x402 payment handling.

    This is a convenience function that creates an x402MCPClient from an
    existing async MCP client and payment client.

    Args:
        mcp_client: Existing async MCP SDK client
        payment_client: x402 async payment client
        auto_payment: Whether to automatically create and submit payment
        on_payment_requested: Optional async callback for payment approval

    Returns:
        x402MCPClient instance

    Example:
        ```python
        from x402 import x402ClientAsync
        from x402.mcp import wrap_mcp_client_with_payment

        mcp_client = # ... existing async MCP client
        payment_client = x402ClientAsync()
        payment_client.register("eip155:84532", evm_scheme)

        x402_mcp = wrap_mcp_client_with_payment(
            mcp_client,
            payment_client,
            auto_payment=True,
        )
        ```
    """
    return x402MCPClient(
        mcp_client,
        payment_client,
        auto_payment=auto_payment,
        on_payment_requested=on_payment_requested,
    )


def wrap_mcp_client_with_payment_from_config(
    mcp_client: Any,
    schemes: list[dict[str, Any]],
    *,
    auto_payment: bool = True,
    on_payment_requested: (
        Callable[[PaymentRequiredContext], bool | Awaitable[bool]] | None
    ) = None,
) -> x402MCPClient:
    """Wrap an existing async MCP client with x402 payment handling using scheme registrations.

    Similar to wrap_mcp_client_with_payment but uses scheme registrations directly.

    Args:
        mcp_client: Existing async MCP SDK client
        schemes: List of scheme registrations, each with 'network' and 'client' keys
        auto_payment: Whether to automatically create and submit payment
        on_payment_requested: Optional async callback for payment approval

    Returns:
        x402MCPClient instance

    Example:
        ```python
        from x402.mcp import wrap_mcp_client_with_payment_from_config
        from x402.mechanisms.evm.exact import ExactEvmClientScheme

        mcp_client = # ... existing async MCP client

        x402_mcp = wrap_mcp_client_with_payment_from_config(
            mcp_client,
            schemes=[
                {"network": "eip155:84532", "client": ExactEvmClientScheme(signer)},
            ],
            auto_payment=True,
        )
        ```
    """
    from .. import x402Client as x402ClientAsync

    payment_client = x402ClientAsync()
    register_schemes(payment_client, schemes)

    return x402MCPClient(
        mcp_client,
        payment_client,
        auto_payment=auto_payment,
        on_payment_requested=on_payment_requested,
    )


def create_x402_mcp_client_from_config(
    mcp_client: Any,
    config: dict[str, Any],
) -> x402MCPClient:
    """Create a fully configured async x402 MCP client from a config object.

    This factory function provides the simplest way to create an async x402-enabled MCP client.
    It handles creation of the x402Client from scheme registrations.

    Note: This is a sync factory function -- the returned client has async methods.

    Args:
        mcp_client: Underlying async MCP SDK client
        config: Configuration dictionary with:
            - schemes: List of scheme registrations (required)
            - auto_payment: Whether to automatically create and submit payment (default: True)
            - on_payment_requested: Optional callback for payment approval

    Returns:
        x402MCPClient instance

    Example:
        ```python
        from x402.mcp import create_x402_mcp_client_from_config
        from x402.mechanisms.evm.exact import ExactEvmClientScheme

        mcp_client = # ... create async MCP client from SDK

        x402_mcp = create_x402_mcp_client_from_config(
            mcp_client,
            {
                "schemes": [
                    {"network": "eip155:84532", "client": ExactEvmClientScheme(signer)},
                ],
                "auto_payment": True,
            },
        )
        ```
    """
    from .. import x402Client as x402ClientAsync

    schemes = config.get("schemes", [])
    auto_payment = config.get("auto_payment", True)
    on_payment_requested = config.get("on_payment_requested")

    payment_client = x402ClientAsync()
    register_schemes(payment_client, schemes)

    return x402MCPClient(
        mcp_client,
        payment_client,
        auto_payment=auto_payment,
        on_payment_requested=on_payment_requested,
    )
