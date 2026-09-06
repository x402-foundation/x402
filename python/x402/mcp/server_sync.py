"""MCP server payment wrapper for x402 (sync)."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from ..payment_flow import (
    resolve_failure_path_settlement,
    resolve_payment_flow_phases,
)
from ..schemas.hooks import CompletedSettlement, VerifiedPaymentCancelOptions
from ..server import x402ResourceServerSync
from .types import (
    MCP_PAYMENT_RESPONSE_META_KEY,
    AfterExecutionContext,
    MCPToolContext,
    MCPToolResult,
    ServerHookContext,
    SettlementContext,
    SyncPaymentWrapperConfig,
)
from .utils import (
    build_tool_resource_info,
    extract_payment_from_meta,
    post_enrichment_accepts,
    validate_payment_wrapper_accepts,
)

# Sync tool handler type
SyncToolHandler = Callable[
    [dict[str, Any], MCPToolContext],
    MCPToolResult | dict[str, Any],
]


def create_payment_wrapper_sync(
    resource_server: x402ResourceServerSync,
    config: SyncPaymentWrapperConfig,
) -> Callable[[SyncToolHandler], SyncToolHandler]:
    """Create a sync payment wrapper for MCP tool handlers.

    Returns a function that wraps sync tool handlers with payment logic.
    This is the sync counterpart to create_payment_wrapper in server_async.

    Args:
        resource_server: The sync x402 resource server for payment verification/settlement
        config: Payment configuration with accepts array

    Returns:
        A function that wraps sync tool handlers with payment logic
    """
    if not config.accepts:
        raise ValueError(
            "SyncPaymentWrapperConfig.accepts must have at least one payment requirement"
        )

    validate_payment_wrapper_accepts(resource_server, config.accepts)

    def wrapper(handler: SyncToolHandler) -> SyncToolHandler:
        def wrapped_handler(args: dict[str, Any], extra: dict[str, Any]) -> MCPToolResult:
            handler_threw = False

            def mark_threw() -> None:
                nonlocal handler_threw
                handler_threw = True

            try:
                return _process_paid_tool_call_sync(
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


def _normalize_tool_result_sync(handler_result: Any) -> MCPToolResult:
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


def _settle_meta_sync(settle_result: Any) -> Any:
    if hasattr(settle_result, "model_dump"):
        return settle_result.model_dump(by_alias=True, exclude_none=True)
    return settle_result


def _process_paid_tool_call_sync(
    resource_server: x402ResourceServerSync,
    config: SyncPaymentWrapperConfig,
    handler: SyncToolHandler,
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

    tool_context = MCPToolContext(tool_name=tool_name, arguments=args, meta=meta)
    transport_context = {"toolName": tool_name, "arguments": args, "meta": meta}

    payment_payload = extract_payment_from_meta(
        {"name": tool_name, "arguments": args, "_meta": meta}
    )
    if payment_payload is None:
        return _create_payment_required_result_sync(
            resource_server, tool_name, config, "Payment required to access this tool"
        )

    resource_info = build_tool_resource_info(tool_name, config.resource)
    try:
        payment_required = resource_server.create_payment_required_response(
            config.accepts, resource_info, None, config.extensions, transport_context
        )
    except TypeError:
        payment_required = resource_server.create_payment_required_response(
            config.accepts, resource_info, None, config.extensions
        )
    accepts = post_enrichment_accepts(payment_required, config.accepts)
    payment_requirements = resource_server.find_matching_requirements(accepts, payment_payload)
    if payment_requirements is None:
        return _create_payment_required_result_sync(
            resource_server, tool_name, config, "No matching payment requirements found"
        )

    validate_extensions = getattr(resource_server, "validate_extensions", None)
    if callable(validate_extensions):
        extension_result = validate_extensions(payment_required, payment_payload)
        if not getattr(extension_result, "valid", True):
            return _create_payment_required_result_sync(
                resource_server,
                tool_name,
                config,
                getattr(extension_result, "invalid_reason", None) or "Payment verification failed",
            )

    ext_map = config.extensions or {}
    get_flow = getattr(resource_server, "get_payment_flow", None)
    if callable(get_flow):
        flow = get_flow(payment_payload, payment_requirements)
        try:
            phases = resolve_payment_flow_phases(flow)
        except ValueError:
            flow = "authorization"
            phases = resolve_payment_flow_phases(flow)
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
        verify_result = resource_server.verify_payment(
            payment_payload,
            payment_requirements,
            declared_extensions=ext_map,
            transport_context=transport_context,
        )
    except TypeError:
        verify_result = resource_server.verify_payment(payment_payload, payment_requirements)

    if not verify_result.is_valid:
        reason = verify_result.invalid_reason or "Payment verification failed"
        return _create_payment_required_result_sync(resource_server, tool_name, config, reason)

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
        return _settle_payment_result_sync(
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
            try:
                before_settle = resource_server.settle_payment(
                    payment_payload,
                    payment_requirements,
                    declared_extensions=ext_map,
                    transport_context=transport_context,
                    phase="before-handler",
                )
            except TypeError:
                before_settle = resource_server.settle_payment(
                    payment_payload, payment_requirements
                )
            if not before_settle.success:
                return _create_settlement_failed_result_sync(
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
            return _create_settlement_failed_result_sync(
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
            payment_payload, payment_requirements, ext_map, transport_context
        )

    if config.hooks and config.hooks.on_before_execution:
        proceed = config.hooks.on_before_execution(hook_context)
        if not proceed:
            return _create_payment_required_result_sync(
                resource_server,
                tool_name,
                config,
                "Execution blocked by hook",
            )

    try:
        handler_result = handler(args, tool_context)
    except Exception as error:
        mark_handler_threw()
        cancel_settlement = None
        if dispatcher is not None:
            cancel = getattr(dispatcher, "cancel_sync", None) or getattr(dispatcher, "cancel", None)
            if callable(cancel):
                cancel_settlement = cancel(
                    VerifiedPaymentCancelOptions(reason="handler_threw", error=error)
                )
        failure_receipt = resolve_failure_path_settlement(
            cancel_settlement, before_handler_settlement, payment_payload
        )
        if failure_receipt is None:
            raise
        return MCPToolResult(
            content=[{"type": "text", "text": "Internal Server Error"}],
            is_error=True,
            meta={MCP_PAYMENT_RESPONSE_META_KEY: _settle_meta_sync(failure_receipt)},
        )

    result = _normalize_tool_result_sync(handler_result)

    after_exec_context = AfterExecutionContext(
        tool_name=tool_name,
        arguments=args,
        payment_requirements=payment_requirements,
        payment_payload=payment_payload,
        result=result,
    )
    if config.hooks and config.hooks.on_after_execution:
        try:
            config.hooks.on_after_execution(after_exec_context)
        except Exception:
            pass

    if result.is_error:
        cancel_settlement = None
        if dispatcher is not None:
            cancel = getattr(dispatcher, "cancel_sync", None) or getattr(dispatcher, "cancel", None)
            if callable(cancel):
                cancel_settlement = cancel(VerifiedPaymentCancelOptions(reason="handler_failed"))
        failure_receipt = resolve_failure_path_settlement(
            cancel_settlement, before_handler_settlement, payment_payload
        )
        if failure_receipt is None:
            return result
        if result.meta is None:
            result.meta = {}
        result.meta[MCP_PAYMENT_RESPONSE_META_KEY] = _settle_meta_sync(failure_receipt)
        return result

    return _settle_payment_result_sync(
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


def _settle_payment_result_sync(
    resource_server: x402ResourceServerSync,
    tool_name: str,
    config: SyncPaymentWrapperConfig,
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
                    config.hooks.on_after_settlement(settlement_context)
                except Exception:
                    pass
            if result.meta is None:
                result.meta = {}
            result.meta[MCP_PAYMENT_RESPONSE_META_KEY] = _settle_meta_sync(settle_result)
            return result

        try:
            settle_result = resource_server.settle_payment(
                payment_payload,
                payment_requirements,
                declared_extensions=ext_map,
                transport_context=transport_context,
                phase="after-handler",
            )
        except TypeError:
            settle_result = resource_server.settle_payment(payment_payload, payment_requirements)
    except Exception as e:
        return _create_settlement_failed_result_sync(resource_server, tool_name, config, str(e))

    if not settle_result.success:
        return _create_settlement_failed_result_sync(
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
            config.hooks.on_after_settlement(settlement_context)
        except Exception:
            pass

    if result.meta is None:
        result.meta = {}
    result.meta[MCP_PAYMENT_RESPONSE_META_KEY] = _settle_meta_sync(settle_result)
    return result


def _create_payment_required_result_sync(
    resource_server: x402ResourceServerSync,
    tool_name: str,
    config: SyncPaymentWrapperConfig,
    error_message: str,
) -> MCPToolResult:
    """Create a 402 payment required result (sync)."""
    resource_info = build_tool_resource_info(tool_name, config.resource)

    payment_required = resource_server.create_payment_required_response(
        config.accepts,
        resource_info,
        error_message,
        config.extensions,
    )

    payment_required_dict = (
        payment_required.model_dump(by_alias=True, exclude_none=True)
        if hasattr(payment_required, "model_dump")
        else payment_required
    )

    content_text = json.dumps(payment_required_dict)

    return MCPToolResult(
        structured_content=payment_required_dict,
        content=[{"type": "text", "text": content_text}],
        is_error=True,
    )


def _create_settlement_failed_result_sync(
    resource_server: x402ResourceServerSync,
    tool_name: str,
    config: SyncPaymentWrapperConfig,
    error_message: str,
) -> MCPToolResult:
    """Create a 402 settlement failed result (sync)."""
    resource_info = build_tool_resource_info(tool_name, config.resource)

    payment_required = resource_server.create_payment_required_response(
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
