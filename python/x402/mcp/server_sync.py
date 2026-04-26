"""MCP server payment wrapper for x402 (sync)."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

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
    create_tool_resource_url,
    extract_payment_from_meta,
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

    def wrapper(handler: SyncToolHandler) -> SyncToolHandler:
        def wrapped_handler(args: dict[str, Any], extra: dict[str, Any]) -> MCPToolResult:
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

            payment_payload = extract_payment_from_meta(
                {"name": tool_name, "arguments": args, "_meta": meta}
            )

            if payment_payload is None:
                return _create_payment_required_result_sync(
                    resource_server,
                    tool_name,
                    config,
                    "Payment required to access this tool",
                )

            payment_requirements = resource_server.find_matching_requirements(
                config.accepts, payment_payload
            )

            if payment_requirements is None:
                return _create_payment_required_result_sync(
                    resource_server,
                    tool_name,
                    config,
                    "No matching payment requirements found",
                )

            verify_result = resource_server.verify_payment(payment_payload, payment_requirements)

            if not verify_result.is_valid:
                reason = verify_result.invalid_reason or "Payment verification failed"
                return _create_payment_required_result_sync(
                    resource_server, tool_name, config, reason
                )

            hook_context = ServerHookContext(
                tool_name=tool_name,
                arguments=args,
                payment_requirements=payment_requirements,
                payment_payload=payment_payload,
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

            handler_result = handler(args, tool_context)

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
                result = MCPToolResult(
                    content=[{"type": "text", "text": str(handler_result)}],
                    is_error=False,
                )

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
                return result

            try:
                settle_result = resource_server.settle_payment(
                    payment_payload, payment_requirements
                )
            except Exception as e:
                return _create_settlement_failed_result_sync(
                    resource_server, tool_name, config, str(e)
                )

            if config.hooks and config.hooks.on_after_settlement:
                settlement_context = SettlementContext(
                    tool_name=tool_name,
                    arguments=args,
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
            result.meta[MCP_PAYMENT_RESPONSE_META_KEY] = (
                settle_result.model_dump(by_alias=True)
                if hasattr(settle_result, "model_dump")
                else settle_result
            )

            return result

        return wrapped_handler

    return wrapper


def _create_payment_required_result_sync(
    resource_server: x402ResourceServerSync,
    tool_name: str,
    config: SyncPaymentWrapperConfig,
    error_message: str,
) -> MCPToolResult:
    """Create a 402 payment required result (sync)."""
    from ..schemas import ResourceInfo as SchemaResourceInfo

    resource_info = SchemaResourceInfo(
        url=create_tool_resource_url(tool_name, config.resource.url if config.resource else None),
        description=(config.resource.description if config.resource else f"Tool: {tool_name}"),
        mime_type=(config.resource.mime_type if config.resource else "application/json"),
    )

    payment_required = resource_server.create_payment_required_response(
        config.accepts,
        resource_info,
        error_message,
        config.extensions,
    )

    payment_required_dict = (
        payment_required.model_dump(by_alias=True)
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
    from ..schemas import ResourceInfo as SchemaResourceInfo

    resource_info = SchemaResourceInfo(
        url=create_tool_resource_url(tool_name, config.resource.url if config.resource else None),
        description=(config.resource.description if config.resource else f"Tool: {tool_name}"),
        mime_type=(config.resource.mime_type if config.resource else "application/json"),
    )

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
