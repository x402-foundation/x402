"""MCP server payment wrapper for x402 integration (async, default)."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

from ..payment_flow import (
    resolve_failure_path_settlement,
    resolve_payment_flow_phases,
)
from ..schemas import PaymentRequirements, ResourceInfo
from ..schemas.hooks import CompletedSettlement, VerifiedPaymentCancelOptions
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
    build_tool_resource_info,
    extract_payment_from_meta,
    post_enrichment_accepts,
    validate_payment_wrapper_accepts,
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

    validate_payment_wrapper_accepts(resource_server, config.accepts)

    def wrapper(handler: AsyncToolHandler) -> AsyncToolHandler:
        async def wrapped_handler(args: dict[str, Any], extra: dict[str, Any]) -> MCPToolResult:
            handler_threw = False

            def mark_threw() -> None:
                nonlocal handler_threw
                handler_threw = True

            try:
                return await _process_paid_tool_call_async(
                    resource_server, config, handler, args, extra, mark_threw
                )
            except Exception:
                if handler_threw:
                    raise
                return MCPToolResult(
                    content=[{"type": "text", "text": "Internal Server Error"}],
                    is_error=True,
                )

        return wrapped_handler

    return wrapper


def _normalize_tool_result(handler_result: Any) -> MCPToolResult:
    if isinstance(handler_result, dict):
        return MCPToolResult(
            content=handler_result.get("content", []),
            is_error=handler_result.get("isError", False),
            meta=handler_result.get("_meta", {}),
            structured_content=handler_result.get("structuredContent"),
        )
    if isinstance(handler_result, MCPToolResult):
        return handler_result
    return MCPToolResult(
        content=[{"type": "text", "text": str(handler_result)}],
        is_error=False,
    )


def _settle_meta(settle_result: Any) -> Any:
    if hasattr(settle_result, "model_dump"):
        return settle_result.model_dump(by_alias=True, exclude_none=True)
    return settle_result


async def _process_paid_tool_call_async(
    resource_server: x402ResourceServerAsync,
    config: PaymentWrapperConfig,
    handler: AsyncToolHandler,
    args: dict[str, Any],
    extra: dict[str, Any],
    mark_handler_threw: Callable[[], None],
) -> MCPToolResult:
    meta = extra.get("_meta", {})
    if not isinstance(meta, dict):
        meta = {}

    tool_name = extra.get("toolName", "paid_tool")
    if config.resource and config.resource.url:
        if config.resource.url.startswith("mcp://tool/"):
            tool_name = config.resource.url[len("mcp://tool/") :]

    tool_context = MCPToolContext(
        tool_name=tool_name,
        arguments=args,
        meta=meta,
    )
    transport_context = {
        "toolName": tool_name,
        "arguments": args,
        "meta": meta,
    }

    payment_payload = extract_payment_from_meta(
        {"name": tool_name, "arguments": args, "_meta": meta}
    )
    if payment_payload is None:
        return await _create_payment_required_result_async(
            resource_server,
            tool_name,
            config,
            "Payment required to access this tool",
            transport_context=transport_context,
        )

    resource_info = build_tool_resource_info(tool_name, config.resource)
    try:
        payment_required = await resource_server.create_payment_required_response(
            config.accepts,
            resource_info,
            None,
            config.extensions,
            transport_context,
        )
    except TypeError:
        payment_required = await resource_server.create_payment_required_response(
            config.accepts,
            resource_info,
            None,
            config.extensions,
        )
    accepts = post_enrichment_accepts(payment_required, config.accepts)
    payment_requirements = resource_server.find_matching_requirements(accepts, payment_payload)
    if payment_requirements is None:
        return await _create_payment_required_result_async(
            resource_server,
            tool_name,
            config,
            "No matching payment requirements found",
            transport_context=transport_context,
        )

    validate_extensions = getattr(resource_server, "validate_extensions", None)
    if callable(validate_extensions):
        extension_result = validate_extensions(payment_required, payment_payload)
        if not getattr(extension_result, "valid", True):
            return await _create_payment_required_result_async(
                resource_server,
                tool_name,
                config,
                getattr(extension_result, "invalid_reason", None) or "Payment verification failed",
                transport_context=transport_context,
                payment_payload=payment_payload,
            )

    ext_map = config.extensions or {}
    get_flow = getattr(resource_server, "get_payment_flow", None)
    if callable(get_flow):
        flow = get_flow(payment_payload, payment_requirements)
        try:
            phases = resolve_payment_flow_phases(flow)
        except ValueError:
            phases = resolve_payment_flow_phases("authorization")
            flow = "authorization"
    else:
        flow = "authorization"
        phases = resolve_payment_flow_phases(flow)

    hook_context = ServerHookContext(
        tool_name=tool_name,
        arguments=args,
        payment_requirements=payment_requirements,
        payment_payload=payment_payload,
    )

    try:
        verify_result = await resource_server.verify_payment(
            payment_payload,
            payment_requirements,
            declared_extensions=ext_map,
            transport_context=transport_context,
        )
    except TypeError:
        verify_result = await resource_server.verify_payment(payment_payload, payment_requirements)
    if not verify_result.is_valid:
        reason = verify_result.invalid_reason or "Payment verification failed"
        return await _create_payment_required_result_async(
            resource_server,
            tool_name,
            config,
            reason,
            transport_context=transport_context,
            payment_payload=payment_payload,
        )

    skip_handler = getattr(verify_result, "skip_handler", None)
    if skip_handler is not None:
        body = getattr(skip_handler, "body", None)
        skip_result = MCPToolResult(
            content=[
                {
                    "type": "text",
                    "text": body if isinstance(body, str) else json.dumps(body or {}),
                }
            ],
            structured_content=body if isinstance(body, dict) else None,
        )
        return await _settle_payment_result_async(
            resource_server,
            tool_name,
            config,
            hook_context,
            payment_payload,
            payment_requirements,
            ext_map,
            transport_context,
            skip_result,
        )

    before_handler_settlement = None
    if phases.settle_before_handler:
        try:
            before_settle = await resource_server.settle_payment(
                payment_payload,
                payment_requirements,
                declared_extensions=ext_map,
                transport_context=transport_context,
                phase="before-handler",
            )
            if not before_settle.success:
                return await _create_settlement_failed_result_async(
                    resource_server,
                    tool_name,
                    config,
                    before_settle.error_reason
                    or before_settle.error_message
                    or "Settlement failed",
                )
            before_handler_settlement = CompletedSettlement(
                phase="before-handler",
                flow=flow,
                result=before_settle,
                requirements=payment_requirements,
            )
        except TypeError:
            before_settle = await resource_server.settle_payment(
                payment_payload, payment_requirements
            )
            if not before_settle.success:
                return await _create_settlement_failed_result_async(
                    resource_server,
                    tool_name,
                    config,
                    before_settle.error_reason or "Settlement failed",
                )
            before_handler_settlement = CompletedSettlement(
                phase="before-handler",
                flow=flow,
                result=before_settle,
                requirements=payment_requirements,
            )
        except Exception:
            return await _create_settlement_failed_result_async(
                resource_server, tool_name, config, "Settlement failed"
            )

    try:
        dispatcher = resource_server.create_payment_cancellation_dispatcher(
            payment_payload,
            payment_requirements,
            ext_map,
            transport_context,
            ["before-handler"] if before_handler_settlement is not None else [],
        )
    except TypeError:
        dispatcher = resource_server.create_payment_cancellation_dispatcher(
            payment_payload,
            payment_requirements,
            ext_map,
            transport_context,
        )

    if config.hooks and config.hooks.on_before_execution:
        proceed = config.hooks.on_before_execution(hook_context)
        if hasattr(proceed, "__await__"):
            proceed = await proceed
        if not proceed:
            return await _create_payment_required_result_async(
                resource_server,
                tool_name,
                config,
                "Execution blocked by hook",
                transport_context=transport_context,
            )

    try:
        handler_result = handler(args, tool_context)
        if hasattr(handler_result, "__await__"):
            handler_result = await handler_result
    except Exception as error:
        mark_handler_threw()
        cancel_settlement = None
        if dispatcher is not None:
            cancel_settlement = dispatcher.cancel(
                VerifiedPaymentCancelOptions(reason="handler_threw", error=error)
            )
            if hasattr(cancel_settlement, "__await__"):
                cancel_settlement = await cancel_settlement
        failure_receipt = resolve_failure_path_settlement(
            cancel_settlement, before_handler_settlement, payment_payload
        )
        if failure_receipt is None:
            raise
        return MCPToolResult(
            content=[{"type": "text", "text": "Internal Server Error"}],
            is_error=True,
            meta={MCP_PAYMENT_RESPONSE_META_KEY: _settle_meta(failure_receipt)},
        )

    result = _normalize_tool_result(handler_result)
    transport_context["result"] = result

    after_exec_context = AfterExecutionContext(
        tool_name=tool_name,
        arguments=args,
        payment_requirements=payment_requirements,
        payment_payload=payment_payload,
        result=result,
    )
    if config.hooks and config.hooks.on_after_execution:
        try:
            coro = config.hooks.on_after_execution(after_exec_context)
            if hasattr(coro, "__await__"):
                await coro
        except Exception:
            pass

    if result.is_error:
        cancel_settlement = None
        if dispatcher is not None:
            cancel_settlement = dispatcher.cancel(
                VerifiedPaymentCancelOptions(reason="handler_failed")
            )
            if hasattr(cancel_settlement, "__await__"):
                cancel_settlement = await cancel_settlement
        failure_receipt = resolve_failure_path_settlement(
            cancel_settlement, before_handler_settlement, payment_payload
        )
        if failure_receipt is None:
            return result
        if result.meta is None:
            result.meta = {}
        result.meta[MCP_PAYMENT_RESPONSE_META_KEY] = _settle_meta(failure_receipt)
        return result

    return await _settle_payment_result_async(
        resource_server,
        tool_name,
        config,
        hook_context,
        payment_payload,
        payment_requirements,
        ext_map,
        transport_context,
        result,
        before_handler_settlement,
    )


async def _settle_payment_result_async(
    resource_server: x402ResourceServerAsync,
    tool_name: str,
    config: PaymentWrapperConfig,
    hook_context: ServerHookContext,
    payment_payload: Any,
    payment_requirements: Any,
    ext_map: dict[str, Any],
    transport_context: Any,
    result: MCPToolResult,
    before_handler_settlement: CompletedSettlement | None = None,
) -> MCPToolResult:
    try:
        if before_handler_settlement is not None:
            flow = before_handler_settlement.flow
        else:
            get_flow = getattr(resource_server, "get_payment_flow", None)
            flow = (
                get_flow(payment_payload, payment_requirements)
                if callable(get_flow)
                else "authorization"
            )
        try:
            phases = resolve_payment_flow_phases(flow)
        except ValueError:
            phases = resolve_payment_flow_phases("authorization")

        if not phases.settle_after_handler:
            settle_result = (
                before_handler_settlement.result if before_handler_settlement is not None else None
            )
            if settle_result is None:
                return result
            if config.hooks and config.hooks.on_after_settlement:
                settlement_context = SettlementContext(
                    tool_name=hook_context.tool_name,
                    arguments=hook_context.arguments,
                    payment_requirements=payment_requirements,
                    payment_payload=payment_payload,
                    settlement=settle_result,
                )
                try:
                    coro = config.hooks.on_after_settlement(settlement_context)
                    if hasattr(coro, "__await__"):
                        await coro
                except Exception:
                    pass
            if result.meta is None:
                result.meta = {}
            result.meta[MCP_PAYMENT_RESPONSE_META_KEY] = _settle_meta(settle_result)
            return result

        try:
            settle_result = await resource_server.settle_payment(
                payment_payload,
                payment_requirements,
                declared_extensions=ext_map,
                transport_context=transport_context,
                phase="after-handler",
            )
        except TypeError:
            settle_result = await resource_server.settle_payment(
                payment_payload, payment_requirements
            )
    except Exception as e:
        return await _create_settlement_failed_result_async(
            resource_server, tool_name, config, str(e)
        )

    if not settle_result.success:
        return await _create_settlement_failed_result_async(
            resource_server,
            tool_name,
            config,
            settle_result.error_reason or "Unknown settlement failure",
        )

    if config.hooks and config.hooks.on_after_settlement:
        settlement_context = SettlementContext(
            tool_name=hook_context.tool_name,
            arguments=hook_context.arguments,
            payment_requirements=payment_requirements,
            payment_payload=payment_payload,
            settlement=settle_result,
        )
        try:
            coro = config.hooks.on_after_settlement(settlement_context)
            if hasattr(coro, "__await__"):
                await coro
        except Exception:
            pass

    if result.meta is None:
        result.meta = {}
    result.meta[MCP_PAYMENT_RESPONSE_META_KEY] = _settle_meta(settle_result)
    return result


async def _create_payment_required_result_async(
    resource_server: x402ResourceServerAsync,
    tool_name: str,
    config: PaymentWrapperConfig,
    error_message: str,
    *,
    transport_context: Any = None,
    payment_payload: Any = None,
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
    resource_info = build_tool_resource_info(tool_name, config.resource)

    try:
        payment_required = await resource_server.create_payment_required_response(
            config.accepts,
            resource_info,
            error_message,
            config.extensions,
            transport_context,
            payment_payload,
        )
    except TypeError:
        payment_required = await resource_server.create_payment_required_response(
            config.accepts,
            resource_info,
            error_message,
            config.extensions,
        )

    # Convert to dict for structuredContent
    payment_required_dict = (
        payment_required.model_dump(by_alias=True, exclude_none=True)
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
    resource_info = build_tool_resource_info(tool_name, config.resource)

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
        payment_required.model_dump(by_alias=True, exclude_none=True)
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
