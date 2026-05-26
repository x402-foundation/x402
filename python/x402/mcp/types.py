"""Type definitions for MCP transport integration."""

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any, Optional

from ..schemas import PaymentPayload, PaymentRequirements, SettleResponse
from ..schemas.base import Price

if TYPE_CHECKING:
    pass

# Protocol constants for MCP x402 payment integration.
MCP_PAYMENT_REQUIRED_CODE = 402
MCP_PAYMENT_META_KEY = "x402/payment"
MCP_PAYMENT_RESPONSE_META_KEY = "x402/payment-response"


class ResourceInfo:
    """Resource metadata for payment required responses."""

    def __init__(
        self,
        url: str,
        description: str | None = None,
        mime_type: str | None = None,
    ):
        """Initialize resource info.

        Args:
            url: Resource URL
            description: Optional description
            mime_type: Optional MIME type
        """
        self.url = url
        self.description = description
        self.mime_type = mime_type


class PaymentRequiredContext:
    """Context provided to payment required hooks."""

    def __init__(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        payment_required: Any,  # PaymentRequired
    ):
        """Initialize payment required context.

        Args:
            tool_name: Name of the tool
            arguments: Tool arguments
            payment_required: Payment required response
        """
        self.tool_name = tool_name
        self.arguments = arguments
        self.payment_required = payment_required


class PaymentRequiredHookResult:
    """Result from payment required hook."""

    def __init__(
        self,
        payment: PaymentPayload | None = None,
        abort: bool = False,
    ):
        """Initialize hook result.

        Args:
            payment: Optional payment payload to use
            abort: Whether to abort the payment flow
        """
        self.payment = payment
        self.abort = abort


# Sync hook type aliases
SyncPaymentRequiredHook = Callable[[PaymentRequiredContext], PaymentRequiredHookResult]
SyncBeforePaymentHook = Callable[[PaymentRequiredContext], None]
SyncAfterPaymentHook = Callable[["AfterPaymentContext"], None]  # type: ignore


class AfterPaymentContext:
    """Context provided to after payment hooks."""

    def __init__(
        self,
        tool_name: str,
        payment_payload: PaymentPayload,
        result: "MCPToolResult",  # type: ignore
        settle_response: SettleResponse | None = None,
    ):
        """Initialize after payment context.

        Args:
            tool_name: Name of the tool
            payment_payload: Payment payload that was used
            result: Tool result
            settle_response: Optional settlement response
        """
        self.tool_name = tool_name
        self.payment_payload = payment_payload
        self.result = result
        self.settle_response = settle_response


class MCPToolContext:
    """Context provided to tool handlers."""

    def __init__(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        meta: dict[str, Any] | None = None,
    ):
        """Initialize tool context.

        Args:
            tool_name: Name of the tool
            arguments: Tool arguments
            meta: Optional metadata
        """
        self.tool_name = tool_name
        self.arguments = arguments
        self.meta = meta or {}


class MCPToolResult:
    """Result from an MCP tool call."""

    def __init__(
        self,
        content: list[dict[str, Any]],
        is_error: bool = False,
        meta: dict[str, Any] | None = None,
        structured_content: dict[str, Any] | None = None,
    ):
        """Initialize tool result.

        Args:
            content: Content items
            is_error: Whether this is an error result
            meta: Optional metadata
            structured_content: Optional structured content
        """
        self.content = content
        self.is_error = is_error
        self.meta = meta or {}
        self.structured_content = structured_content


class MCPToolCallResult:
    """Result from a tool call with payment metadata."""

    def __init__(
        self,
        content: list[dict[str, Any]],
        is_error: bool = False,
        payment_response: SettleResponse | None = None,
        payment_made: bool = False,
    ):
        """Initialize tool call result.

        Args:
            content: Content items
            is_error: Whether this is an error result
            payment_response: Optional settlement response
            payment_made: Whether payment was made
        """
        self.content = content
        self.is_error = is_error
        self.payment_response = payment_response
        self.payment_made = payment_made


class SyncPaymentWrapperConfig:
    """Configuration for payment wrapper."""

    def __init__(
        self,
        accepts: list[PaymentRequirements],
        resource: ResourceInfo | None = None,
        hooks: Optional["SyncPaymentWrapperHooks"] = None,  # type: ignore
        extensions: dict[str, Any] | None = None,
    ):
        """Initialize payment wrapper config.

        Args:
            accepts: List of payment requirements
            resource: Optional resource info
            hooks: Optional server-side hooks
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


class ServerHookContext:
    """Context provided to server-side hooks."""

    def __init__(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        payment_requirements: PaymentRequirements,
        payment_payload: PaymentPayload,
    ):
        """Initialize server hook context.

        Args:
            tool_name: Name of the tool
            arguments: Tool arguments
            payment_requirements: Payment requirements
            payment_payload: Payment payload
        """
        self.tool_name = tool_name
        self.arguments = arguments
        self.payment_requirements = payment_requirements
        self.payment_payload = payment_payload


class AfterExecutionContext(ServerHookContext):
    """Context provided to after execution hooks."""

    def __init__(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        payment_requirements: PaymentRequirements,
        payment_payload: PaymentPayload,
        result: MCPToolResult,
    ):
        """Initialize after execution context.

        Args:
            tool_name: Name of the tool
            arguments: Tool arguments
            payment_requirements: Payment requirements
            payment_payload: Payment payload
            result: Tool result
        """
        super().__init__(tool_name, arguments, payment_requirements, payment_payload)
        self.result = result


class SettlementContext(ServerHookContext):
    """Context provided to after settlement hooks."""

    def __init__(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        payment_requirements: PaymentRequirements,
        payment_payload: PaymentPayload,
        settlement: SettleResponse,
    ):
        """Initialize settlement context.

        Args:
            tool_name: Name of the tool
            arguments: Tool arguments
            payment_requirements: Payment requirements
            payment_payload: Payment payload
            settlement: Settlement response
        """
        super().__init__(tool_name, arguments, payment_requirements, payment_payload)
        self.settlement = settlement


class SyncPaymentWrapperHooks:
    """Server-side hooks for payment wrapper."""

    def __init__(
        self,
        on_before_execution: Callable[[ServerHookContext], bool] | None = None,
        on_after_execution: Callable[[AfterExecutionContext], None] | None = None,
        on_after_settlement: Callable[[SettlementContext], None] | None = None,
    ):
        """Initialize payment wrapper hooks.

        Args:
            on_before_execution: Hook called before execution (can abort)
            on_after_execution: Hook called after execution
            on_after_settlement: Hook called after settlement
        """
        self.on_before_execution = on_before_execution
        self.on_after_execution = on_after_execution
        self.on_after_settlement = on_after_settlement


# Sync server hook type aliases
SyncBeforeExecutionHook = Callable[[ServerHookContext], bool]
SyncAfterExecutionHook = Callable[[AfterExecutionContext], None]
SyncAfterSettlementHook = Callable[[SettlementContext], None]

# Async-capable server hooks (for use in async wrappers; callables may return awaitables)
AsyncBeforeExecutionHook = Callable[[ServerHookContext], bool | Awaitable[bool]]
AsyncAfterExecutionHook = Callable[[AfterExecutionContext], None | Awaitable[None]]
AsyncAfterSettlementHook = Callable[[SettlementContext], None | Awaitable[None]]


class PaymentWrapperHooks:
    """Server-side hooks for payment wrapper (supports sync or async hooks)."""

    def __init__(
        self,
        on_before_execution: AsyncBeforeExecutionHook | None = None,
        on_after_execution: AsyncAfterExecutionHook | None = None,
        on_after_settlement: AsyncAfterSettlementHook | None = None,
    ):
        """Initialize payment wrapper hooks.

        Args:
            on_before_execution: Hook called before execution (can abort). May be sync or async.
            on_after_execution: Hook called after execution. May be sync or async.
            on_after_settlement: Hook called after settlement. May be sync or async.
        """
        self.on_before_execution = on_before_execution
        self.on_after_execution = on_after_execution
        self.on_after_settlement = on_after_settlement


# ============================================================================
# Dynamic Pricing Types
# ============================================================================

DynamicPayTo = Callable[[MCPToolContext], str]
"""Function type that resolves a payTo address dynamically based on tool call context."""

DynamicPrice = Callable[[MCPToolContext], Price]
"""Function type that resolves a price dynamically based on tool call context."""


class PaymentRequiredError(Exception):
    """Error indicating payment is required."""

    def __init__(
        self,
        message: str,
        payment_required: Any | None = None,  # PaymentRequired
    ):
        """Initialize payment required error.

        Args:
            message: Error message
            payment_required: Optional payment required response
        """
        super().__init__(message)
        self.code = MCP_PAYMENT_REQUIRED_CODE
        self.payment_required = payment_required
