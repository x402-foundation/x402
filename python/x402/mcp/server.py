"""MCP server-side payment wrapper for x402.

Provides create_payment_wrapper() to add x402 payment verification
and settlement to FastMCP tool handlers.

Example:
    ```python
    from mcp.server.fastmcp import FastMCP
    from x402.mcp import create_payment_wrapper

    mcp = FastMCP("my-server")
    wrapper = create_payment_wrapper(
        resource_server,
        accepts=weather_accepts,
        resource=ResourceInfo(url="mcp://tool/get_weather", description="Get weather"),
    )

    @mcp.tool(name="get_weather", description="Get current weather")
    @wrapper
    async def get_weather(city: str) -> str:
        return json.dumps({"city": city, "weather": "sunny", "temperature": 72})
    ```
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import json
import logging
from collections.abc import Callable
from typing import Any

from ..schemas.payments import PaymentPayload, PaymentRequirements, ResourceInfo
from .constants import MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY
from .types import (
    AfterExecutionContext,
    PaymentWrapperHooks,
    ServerHookContext,
    SettlementContext,
)

logger = logging.getLogger(__name__)

__all__ = ["create_payment_wrapper"]


def create_payment_wrapper(
    resource_server: Any,
    *,
    accepts: list[PaymentRequirements],
    resource: ResourceInfo | None = None,
    hooks: PaymentWrapperHooks | None = None,
    extensions: dict[str, Any] | None = None,
) -> Callable:
    """Create a decorator that wraps a FastMCP tool handler with x402 payment logic.

    The decorated handler automatically:
    - Returns 402 payment required when no payment is provided
    - Verifies payment payloads against the facilitator
    - Executes the tool handler on successful verification
    - Settles payments after successful execution
    - Returns settlement info in response ``_meta``

    The original handler should return either a ``str`` (JSON text) or a ``dict``
    (automatically serialized to JSON). The wrapper handles conversion to
    ``CallToolResult`` and attaches payment metadata.

    Note: The wrapper automatically adds a ``ctx: Context`` parameter to the
    function signature so FastMCP injects the request context. Your handler
    does NOT need to include ``ctx`` in its parameters.

    Args:
        resource_server: An async ``x402ResourceServer`` instance configured
            with facilitator client and scheme registrations.
        accepts: List of accepted ``PaymentRequirements``. The first entry is
            used for verification and settlement.
        resource: Optional ``ResourceInfo`` metadata (url, description, mimeType).
            Defaults to ``mcp://tool/{function_name}``.
        hooks: Optional ``PaymentWrapperHooks`` for on_before_execution,
            on_after_execution, on_after_settlement (matches server_async).
        extensions: Optional x402 extensions to include in PaymentRequired responses.
            Use this to attach Bazaar discovery metadata so facilitators can index
            the tool. Example: ``declare_mcp_discovery_extension(config)``

    Returns:
        A decorator to apply to a FastMCP tool handler function.
    """
    # Lazy import mcp types so the module can be imported without mcp installed
    from mcp.server.fastmcp import Context

    from mcp.types import CallToolResult, TextContent

    if not accepts:
        raise ValueError("accepts must have at least one payment requirement")

    def decorator(handler: Callable) -> Callable:
        is_async = asyncio.iscoroutinefunction(handler)
        tool_name = handler.__name__

        # Build resource info, defaulting to tool name
        tool_resource = resource or ResourceInfo(
            url=f"mcp://tool/{tool_name}",
            description=f"Tool: {tool_name}",
            mime_type="application/json",
        )

        # Track whether we've warned about missing context injection
        _ctx_warning_issued = False

        @functools.wraps(handler)
        async def wrapped(**kwargs: Any) -> CallToolResult:
            nonlocal _ctx_warning_issued
            # Extract context injected by FastMCP
            ctx = kwargs.pop("ctx", None)

            # Validate context injection -- if ctx is None on every call,
            # it means FastMCP's find_context_parameter() didn't detect
            # our signature, and payment will never succeed.
            if ctx is None and not _ctx_warning_issued:
                _ctx_warning_issued = True
                logger.warning(
                    "x402 payment wrapper for '%s': FastMCP did not inject Context. "
                    "Payment metadata will be unavailable. This may indicate a "
                    "compatibility issue with the mcp SDK version.",
                    tool_name,
                )

            # Extract payment from meta
            payment_data = _extract_payment_from_context(ctx)

            if not payment_data:
                return _create_payment_required_result(
                    accepts, tool_resource, "Payment Required", extensions
                )

            # Parse payment payload
            try:
                if isinstance(payment_data, str):
                    payment_data = json.loads(payment_data)
                payload = PaymentPayload.model_validate(payment_data)
            except Exception as e:
                return _create_payment_required_result(
                    accepts, tool_resource, f"Invalid payment payload: {e}", extensions
                )

            if asyncio.iscoroutinefunction(resource_server.verify_payment):
                verify_result = await resource_server.verify_payment(payload, accepts[0])
            else:
                verify_result = await asyncio.to_thread(
                    resource_server.verify_payment, payload, accepts[0]
                )
            if not verify_result.is_valid:
                return _create_payment_required_result(
                    accepts,
                    tool_resource,
                    f"Payment verification failed: {verify_result.invalid_reason}",
                    extensions,
                )

            # OnBeforeExecution hook
            if hooks and hooks.on_before_execution:
                hook_ctx = ServerHookContext(
                    tool_name=tool_name,
                    arguments=kwargs,
                    payment_requirements=accepts[0],
                    payment_payload=payload,
                )
                proceed = hooks.on_before_execution(hook_ctx)
                if asyncio.iscoroutine(proceed):
                    proceed = await proceed
                if not proceed:
                    return _create_payment_required_result(
                        accepts,
                        tool_resource,
                        "Execution blocked by on_before_execution hook",
                        extensions,
                    )

            # Execute the original handler
            try:
                if is_async:
                    result = await handler(**kwargs)
                else:
                    result = handler(**kwargs)
            except Exception as e:
                return CallToolResult(
                    content=[TextContent(type="text", text=f"Tool execution error: {e}")],
                    isError=True,
                )

            # Convert handler result to text content
            if isinstance(result, dict):
                result_text = json.dumps(result)
            elif isinstance(result, str):
                result_text = result
            elif isinstance(result, CallToolResult):
                if result.isError:
                    return result
                result_text = result.content[0].text if result.content else ""
            else:
                result_text = str(result)

            # Build MCPToolResult for hooks
            from .types import MCPToolResult as MCPToolResultType

            mcp_result = MCPToolResultType(
                content=(
                    [{"type": "text", "text": result_text}] if isinstance(result_text, str) else []
                ),
                is_error=False,
                meta={},
                structured_content=None,
            )

            # OnAfterExecution hook
            if hooks and hooks.on_after_execution:
                after_ctx = AfterExecutionContext(
                    tool_name=tool_name,
                    arguments=kwargs,
                    payment_requirements=accepts[0],
                    payment_payload=payload,
                    result=mcp_result,
                )
                try:
                    coro = hooks.on_after_execution(after_ctx)
                    if asyncio.iscoroutine(coro):
                        await coro
                except Exception:
                    pass

            try:
                if asyncio.iscoroutinefunction(resource_server.settle_payment):
                    settle_result = await resource_server.settle_payment(payload, accepts[0])
                else:
                    settle_result = await asyncio.to_thread(
                        resource_server.settle_payment, payload, accepts[0]
                    )
                if not settle_result.success:
                    return _create_settlement_failed_result(
                        accepts,
                        tool_resource,
                        settle_result.error_reason or "Unknown settlement failure",
                        extensions,
                    )
            except Exception as e:
                return _create_settlement_failed_result(
                    accepts,
                    tool_resource,
                    str(e),
                    extensions,
                )

            # OnAfterSettlement hook
            if hooks and hooks.on_after_settlement:
                settlement_ctx = SettlementContext(
                    tool_name=tool_name,
                    arguments=kwargs,
                    payment_requirements=accepts[0],
                    payment_payload=payload,
                    settlement=settle_result,
                )
                try:
                    coro = hooks.on_after_settlement(settlement_ctx)
                    if asyncio.iscoroutine(coro):
                        await coro
                except Exception:
                    pass

            # Return result with payment response in _meta
            payment_response = settle_result.model_dump(by_alias=True)
            return CallToolResult(
                content=[TextContent(type="text", text=result_text)],
                isError=False,
                _meta={MCP_PAYMENT_RESPONSE_META_KEY: payment_response},
            )

        # --- Signature manipulation for FastMCP context injection ---
        #
        # FastMCP's Tool.from_function() uses inspect.signature() and
        # issubclass(annotation, Context) to discover which parameter
        # should receive the request Context.  We add a synthetic
        # ``ctx: Context`` parameter to the wrapped function so FastMCP
        # will inject it automatically.  The wrapper pops ``ctx`` from
        # kwargs before calling the original handler.
        #
        # Why not alternatives?
        #   - context_kwarg: requires accessing FastMCP's Tool class directly,
        #     incompatible with the @mcp.tool() decorator pattern.
        #   - Requiring users to declare ctx: available but leaks transport
        #     details into handler signatures.
        #
        # Risk: if FastMCP changes how it inspects signatures, ctx may
        # not be injected.  The runtime warning above detects this.
        orig_sig = inspect.signature(handler)
        params = list(orig_sig.parameters.values())
        ctx_param = inspect.Parameter(
            "ctx",
            inspect.Parameter.KEYWORD_ONLY,
            default=None,
            annotation=Context,
        )
        params.append(ctx_param)
        wrapped.__signature__ = orig_sig.replace(
            parameters=params, return_annotation=CallToolResult
        )
        wrapped.__annotations__ = {
            **handler.__annotations__,
            "ctx": Context,
            "return": CallToolResult,
        }

        return wrapped

    return decorator


def _extract_payment_from_context(ctx: Any) -> dict | None:
    """Extract x402/payment data from FastMCP Context.

    FastMCP stores extra ``_meta`` fields in ``request_context.meta.model_extra``.
    """
    if ctx is None:
        return None
    try:
        request_meta = ctx.request_context.meta
        if request_meta is not None and request_meta.model_extra:
            return request_meta.model_extra.get(MCP_PAYMENT_META_KEY)
    except (ValueError, AttributeError):
        pass
    return None


def _create_payment_required_result(
    accepts: list[PaymentRequirements],
    resource: ResourceInfo,
    error_message: str,
    extensions: dict[str, Any] | None = None,
) -> Any:
    """Create a payment required CallToolResult."""
    from mcp.types import CallToolResult, TextContent

    accepts_dicts = [req.model_dump(by_alias=True) for req in accepts]
    payment_required: dict[str, Any] = {
        "x402Version": 2,
        "accepts": accepts_dicts,
        "error": error_message,
        "resource": resource.model_dump(by_alias=True),
    }
    if extensions:
        payment_required["extensions"] = extensions
    return CallToolResult(
        content=[TextContent(type="text", text=json.dumps(payment_required))],
        structuredContent=payment_required,
        isError=True,
    )


def _create_settlement_failed_result(
    accepts: list[PaymentRequirements],
    resource: ResourceInfo,
    error_message: str,
    extensions: dict[str, Any] | None = None,
) -> Any:
    """Create a settlement failed CallToolResult."""
    from mcp.types import CallToolResult, TextContent

    accepts_dicts = [req.model_dump(by_alias=True) for req in accepts]
    error_data: dict[str, Any] = {
        "x402Version": 2,
        "accepts": accepts_dicts,
        "error": f"Payment settlement failed: {error_message}",
        "resource": resource.model_dump(by_alias=True),
        MCP_PAYMENT_RESPONSE_META_KEY: {
            "success": False,
            "errorReason": error_message,
            "transaction": "",
            "network": accepts[0].network,
        },
    }
    if extensions:
        error_data["extensions"] = extensions
    return CallToolResult(
        content=[TextContent(type="text", text=json.dumps(error_data))],
        structuredContent=error_data,
        isError=True,
    )
