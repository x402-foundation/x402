"""MCP server payment wrapper for x402 integration (async, default)."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

from ..schemas import PaymentRequirements, ResourceInfo
from ..server import x402ResourceServer as x402ResourceServerAsync
from .types import (
    MCP_PAYMENT_RESPONSE_META_KEY,
    AfterExecutionContext,
    MCPToolContext,
    MCPToolResult,
    PaymentWrapperHooks,
    ServerHookContext,
    SettlementContext,
)
from .utils import (
    create_tool_resource_url,
    extract_payment_from_meta,
)

# Async tool handler type
AsyncToolHandler = Callable[
    [dict[str, Any], MCPToolContext],
    MCPToolResult | dict[str, Any] | Awaitable[MCPToolResult] | Awaitable[dict[str, Any]],
]


class PaymentWrapperConfig:
    """Configuration for async payment wrapper."""

    def __init__(
        self,
        accepts: list[PaymentRequirements],
        resource: ResourceInfo | None = None,
        hooks: PaymentWrapperHooks | None = None,
        extensions: dict[str, Any] | None = None,
    ):
        """Initialize async payment wrapper config.

        Args:
            accepts: List of payment requirements
            resource: Optional resource info
            hooks: Optional async server-side hooks
            extensions: Optional x402 extensions to include in PaymentRequired responses.
                Use this to attach Bazaar discovery metadata so facilitators can index
                the tool. Example: ``declare_mcp_discovery_extension(config)``
        """
        if not accepts:
            raise ValueError("accepts must have at least one payment requirement")
        self.accepts = accepts
        self.resource = resource
        self.hooks = hooks
        self.extensions = extensions


def wrap_fastmcp_tool(
    payment_wrapper: Callable[[AsyncToolHandler], Any],
    handler: AsyncToolHandler,
    *,
    tool_name: str | None = None,
) -> Callable[[dict[str, Any], Any], Any]:
    """Bridge an async payment-wrapped tool handler to work with FastMCP.

    Async counterpart to ``wrap_fastmcp_tool_sync``. See that function for
    full documentation.

    Args:
        payment_wrapper: The result of ``create_payment_wrapper(resource_server, config)``
        handler: Your async tool handler ``(args, MCPToolContext) -> MCPToolResult``
        tool_name: Optional explicit tool name. Falls back to the handler
            function name, then ``"paid_tool"`` as a last resort.

    Returns:
        An async function ``(args, fastmcp_context) -> CallToolResult``
    """
    from .server import (
        _extract_meta_from_fastmcp_context,
        _mcp_tool_result_to_call_tool_result,
    )

    wrapped = payment_wrapper(handler)
    resolved_name = tool_name or getattr(handler, "__name__", "paid_tool")

    async def fastmcp_bridge(args: dict[str, Any], ctx: Any) -> Any:
        meta = _extract_meta_from_fastmcp_context(ctx)
        extra = {"_meta": meta, "toolName": resolved_name}
        result = wrapped(args, extra)
        if hasattr(result, "__await__"):
            result = await result
        return _mcp_tool_result_to_call_tool_result(result)

    return fastmcp_bridge


def create_payment_wrapper(
    resource_server: x402ResourceServerAsync,
    config: PaymentWrapperConfig,
) -> Callable[[AsyncToolHandler], AsyncToolHandler]:
    """Create an async payment wrapper for MCP tool handlers.

    Returns a function that wraps async tool handlers with payment logic.
    This is the async counterpart to create_payment_wrapper_sync.

    Args:
        resource_server: The async x402 resource server for payment verification/settlement
        config: Payment configuration with accepts array

    Returns:
        A function that wraps async tool handlers with payment logic

    Example:
        ```python
        from x402 import x402ResourceServerAsync
        from x402.mcp import create_payment_wrapper, PaymentWrapperConfig

        # Create async resource server
        resource_server = x402ResourceServerAsync(facilitator_client)
        resource_server.register("eip155:84532", evm_server_scheme)

        # Build payment requirements
        accepts = await resource_server.build_payment_requirements_from_config(config)

        # Create async payment wrapper
        paid = create_payment_wrapper(
            resource_server,
            PaymentWrapperConfig(accepts=accepts),
        )

        # Use with async MCP server
        @mcp_server.tool("get_weather", "Get weather", schema)
        @paid
        async def handler(args, context):
            return {"content": [{"type": "text", "text": "Sunny"}]}
        ```
    """
    if not config.accepts:
        raise ValueError("PaymentWrapperConfig.accepts must have at least one payment requirement")

    # Return wrapper function that takes a handler and returns a wrapped handler
    def wrapper(handler: AsyncToolHandler) -> AsyncToolHandler:
        async def wrapped_handler(args: dict[str, Any], extra: dict[str, Any]) -> MCPToolResult:
            # Extract _meta from extra
            meta = extra.get("_meta", {})
            if not isinstance(meta, dict):
                meta = {}

            # Derive toolName from context or resource URL
            tool_name = extra.get("toolName", "paid_tool")
            if config.resource and config.resource.url:
                # Try to extract from URL
                if config.resource.url.startswith("mcp://tool/"):
                    tool_name = config.resource.url[len("mcp://tool/") :]

            # Build tool context
            tool_context = MCPToolContext(
                tool_name=tool_name,
                arguments=args,
                meta=meta,
            )

            # Extract payment from _meta
            payment_payload = extract_payment_from_meta(
                {"name": tool_name, "arguments": args, "_meta": meta}
            )

            if payment_payload is None:
                return await _create_payment_required_result_async(
                    resource_server,
                    tool_name,
                    config,
                    "Payment required to access this tool",
                )

            # Match the client's chosen payment method against config.accepts
            payment_requirements = resource_server.find_matching_requirements(
                config.accepts, payment_payload
            )

            if payment_requirements is None:
                return await _create_payment_required_result_async(
                    resource_server,
                    tool_name,
                    config,
                    "No matching payment requirements found",
                )

            # Verify payment (async)
            verify_result = await resource_server.verify_payment(
                payment_payload, payment_requirements
            )

            if not verify_result.is_valid:
                reason = verify_result.invalid_reason or "Payment verification failed"
                return await _create_payment_required_result_async(
                    resource_server, tool_name, config, reason
                )

            # Build hook context
            hook_context = ServerHookContext(
                tool_name=tool_name,
                arguments=args,
                payment_requirements=payment_requirements,
                payment_payload=payment_payload,
            )

            # Run onBeforeExecution hook if present
            if config.hooks and config.hooks.on_before_execution:
                proceed = config.hooks.on_before_execution(hook_context)
                if hasattr(proceed, "__await__"):
                    proceed = await proceed
                if not proceed:
                    return await _create_payment_required_result_async(
                        resource_server, tool_name, config, "Execution blocked by hook"
                    )

            # Execute the tool handler
            handler_result = handler(args, tool_context)
            if hasattr(handler_result, "__await__"):
                handler_result = await handler_result

            # Convert handler result to MCPToolResult if needed
            if isinstance(handler_result, dict):
                result = MCPToolResult(
                    content=handler_result.get("content", []),
                    is_error=handler_result.get("isError", False),
                    meta=handler_result.get("_meta", {}),
                    structured_content=handler_result.get("structuredContent"),
                )
            elif isinstance(handler_result, MCPToolResult):
                result = handler_result
            else:
                # Try to convert
                result = MCPToolResult(
                    content=[{"type": "text", "text": str(handler_result)}],
                    is_error=False,
                )

            # Build after execution context
            after_exec_context = AfterExecutionContext(
                tool_name=tool_name,
                arguments=args,
                payment_requirements=payment_requirements,
                payment_payload=payment_payload,
                result=result,
            )

            # Run onAfterExecution hook if present
            if config.hooks and config.hooks.on_after_execution:
                try:
                    coro = config.hooks.on_after_execution(after_exec_context)
                    if hasattr(coro, "__await__"):
                        await coro
                except Exception:
                    # Log but continue
                    pass

            # If tool returned error, don't settle
            if result.is_error:
                return result

            # Settle payment (async)
            try:
                settle_result = await resource_server.settle_payment(
                    payment_payload, payment_requirements
                )
            except Exception as e:
                return await _create_settlement_failed_result_async(
                    resource_server, tool_name, config, str(e)
                )

            # Run onAfterSettlement hook if present
            if config.hooks and config.hooks.on_after_settlement:
                settlement_context = SettlementContext(
                    tool_name=tool_name,
                    arguments=args,
                    payment_requirements=payment_requirements,
                    payment_payload=payment_payload,
                    settlement=settle_result,
                )
                try:
                    coro = config.hooks.on_after_settlement(settlement_context)
                    if hasattr(coro, "__await__"):
                        await coro
                except Exception:
                    # Log but continue
                    pass

            # Return result with settlement in _meta
            if result.meta is None:
                result.meta = {}
            result.meta[MCP_PAYMENT_RESPONSE_META_KEY] = (
                settle_result.model_dump(by_alias=True)
                if hasattr(settle_result, "model_dump")
                else settle_result
            )

            return result

        return wrapped_handler

    return wrapper


async def _create_payment_required_result_async(
    resource_server: x402ResourceServerAsync,
    tool_name: str,
    config: PaymentWrapperConfig,
    error_message: str,
) -> MCPToolResult:
    """Create a 402 payment required result (async).

    Args:
        resource_server: Async resource server for creating payment required response
        tool_name: Name of the tool for resource URL
        config: Payment wrapper configuration
        error_message: Error message describing why payment is required

    Returns:
        Structured 402 error result with payment requirements
    """
    from ..schemas import ResourceInfo as CoreResourceInfo

    resource_info = CoreResourceInfo(
        url=create_tool_resource_url(tool_name, config.resource.url if config.resource else None),
        description=(config.resource.description if config.resource else f"Tool: {tool_name}"),
        mime_type=config.resource.mime_type if config.resource else "application/json",
    )

    payment_required = await resource_server.create_payment_required_response(
        config.accepts,
        resource_info,
        error_message,
        config.extensions,
    )

    # Convert to dict for structuredContent
    payment_required_dict = (
        payment_required.model_dump(by_alias=True)
        if hasattr(payment_required, "model_dump")
        else payment_required
    )

    # Create content text
    content_text = json.dumps(payment_required_dict)

    return MCPToolResult(
        structured_content=payment_required_dict,
        content=[{"type": "text", "text": content_text}],
        is_error=True,
    )


async def _create_settlement_failed_result_async(
    resource_server: x402ResourceServerAsync,
    tool_name: str,
    config: PaymentWrapperConfig,
    error_message: str,
) -> MCPToolResult:
    """Create a 402 settlement failed result (async).

    Args:
        resource_server: Async resource server for creating payment required response
        tool_name: Name of the tool for resource URL
        config: Payment wrapper configuration
        error_message: Error message describing settlement failure

    Returns:
        Structured 402 error result with settlement failure details
    """
    from ..schemas import ResourceInfo as CoreResourceInfo

    resource_info = CoreResourceInfo(
        url=create_tool_resource_url(tool_name, config.resource.url if config.resource else None),
        description=(config.resource.description if config.resource else f"Tool: {tool_name}"),
        mime_type=config.resource.mime_type if config.resource else "application/json",
    )

    payment_required = await resource_server.create_payment_required_response(
        config.accepts,
        resource_info,
        f"Payment settlement failed: {error_message}",
        config.extensions,
    )

    settlement_failure = {
        "success": False,
        "errorReason": error_message,
        "transaction": "",
        "network": config.accepts[0].network,
    }

    # Merge paymentRequired with settlement failure (camelCase for wire format)
    error_data = (
        payment_required.model_dump(by_alias=True)
        if hasattr(payment_required, "model_dump")
        else payment_required
    )
    error_data[MCP_PAYMENT_RESPONSE_META_KEY] = settlement_failure

    content_text = json.dumps(error_data)

    return MCPToolResult(
        structured_content=error_data,
        content=[{"type": "text", "text": content_text}],
        is_error=True,
    )
