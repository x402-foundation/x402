"""HTTP-specific types for x402 protocol."""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, Protocol

from ..schemas.hooks import PaymentCancellationDispatcher, ProtectedRequestHookResult

if TYPE_CHECKING:
    from ..schemas import (
        Network,
        PaymentPayload,
        PaymentRequirements,
        Price,
    )


# ============================================================================
# HTTP Adapter Protocol
# ============================================================================


class HTTPAdapter(Protocol):
    """Framework-agnostic HTTP adapter interface.

    Implementations provide framework-specific HTTP operations.
    """

    def get_header(self, name: str) -> str | None:
        """Get a header value by name (case-insensitive)."""
        ...

    def get_method(self) -> str:
        """Get the HTTP method (GET, POST, etc.)."""
        ...

    def get_path(self) -> str:
        """Get the request path."""
        ...

    def get_url(self) -> str:
        """Get the full request URL."""
        ...

    def get_accept_header(self) -> str:
        """Get the Accept header value."""
        ...

    def get_user_agent(self) -> str:
        """Get the User-Agent header value."""
        ...

    def get_query_params(self) -> dict[str, str | list[str]] | None:
        """Get all query parameters (optional)."""
        ...

    def get_query_param(self, name: str) -> str | list[str] | None:
        """Get a single query parameter (optional)."""
        ...

    def get_body(self) -> Any:
        """Get the parsed request body (optional)."""
        ...


# ============================================================================
# Request/Response Types
# ============================================================================


@dataclass
class HTTPRequestContext:
    """Context for HTTP request processing."""

    adapter: HTTPAdapter
    path: str
    method: str
    payment_header: str | None = None
    route_pattern: str | None = None


@dataclass
class HTTPTransportContext:
    """HTTP transport context for verify/settle hooks."""

    request: HTTPRequestContext
    response_body: Any = None
    response_headers: dict[str, str] | None = None


@dataclass
class HTTPResponseInstructions:
    """Instructions for building HTTP response."""

    status: int
    headers: dict[str, str]
    body: Any = None
    is_html: bool = False


# Result types for process_http_request
RESULT_NO_PAYMENT_REQUIRED = "no-payment-required"
RESULT_PAYMENT_VERIFIED = "payment-verified"
RESULT_PAYMENT_ERROR = "payment-error"


@dataclass
class HTTPProcessResult:
    """Result of processing an HTTP request."""

    type: Literal["no-payment-required", "payment-verified", "payment-error"]
    response: HTTPResponseInstructions | None = None
    payment_payload: PaymentPayload | None = None
    payment_requirements: PaymentRequirements | None = None
    declared_extensions: dict[str, Any] | None = None
    cancellation_dispatcher: PaymentCancellationDispatcher | None = None


@dataclass
class ProcessSettleResult:
    """Result of settlement processing."""

    success: bool
    error_reason: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    transaction: str | None = None
    network: str | None = None
    payer: str | None = None
    response: HTTPResponseInstructions | None = None  # Only set when success=False


# ============================================================================
# Configuration Types
# ============================================================================


@dataclass
class PaywallConfig:
    """Configuration for paywall UI customization.

    ``faucet_urls`` is a per-chain override keyed by CAIP-2 network identifier
    (e.g. ``"eip155:84532"``). Wins over the paywall's curated default map for
    the matching chain. Unmapped chains render "No faucet configured." rather
    than a fallback link.
    """

    app_name: str | None = None
    app_logo: str | None = None
    session_token_endpoint: str | None = None
    current_url: str | None = None
    testnet: bool = False
    faucet_urls: dict[str, str] | None = None


# Dynamic function types (supports both sync and async callbacks)
# Keep Awaitable support for Price and PayTo to achieve parity with TS
DynamicPayTo = Callable[[HTTPRequestContext], "str | Awaitable[str]"]
DynamicPrice = Callable[[HTTPRequestContext], "Price | Awaitable[Price]"]


@dataclass
class HTTPResponseBody:
    """Custom response body (used by unpaid and settlement-failed hooks)."""

    content_type: str
    body: Any


UnpaidResponseBody = Callable[[HTTPRequestContext], HTTPResponseBody]


SettlementFailedResponseBody = Callable[
    [HTTPRequestContext, ProcessSettleResult],
    HTTPResponseBody | Awaitable[HTTPResponseBody],
]


@dataclass
class PaymentOption:
    """A payment option for a route."""

    scheme: str
    pay_to: str | DynamicPayTo
    price: Price | DynamicPrice
    network: Network
    max_timeout_seconds: int | None = None
    extra: dict[str, Any] | None = None


@dataclass
class RouteConfig:
    """Configuration for a payment-protected route.

    ``service_name``, ``tags``, and ``icon_url`` are forwarded as-is to
    ``ResourceInfo`` for Bazaar discovery. ``RouteConfig`` itself does not
    enforce indexer-side limits — the stricter ``resource_info`` helper path
    soft-drops values that exceed Bazaar's caps (service_name ≤ 32 chars,
    ≤ 5 tags of ≤ 32 chars each, absolute http(s) icon URLs ≤ 2048 chars).
    Server authors should keep names short, tag sets small, and icon URLs
    absolute http(s) to ensure listings are accepted by indexers.
    """

    accepts: PaymentOption | list[PaymentOption]
    resource: str | None = None
    description: str | None = None
    mime_type: str | None = None
    service_name: str | None = None
    tags: list[str] | None = None
    icon_url: str | None = None
    custom_paywall_html: str | None = None
    unpaid_response_body: UnpaidResponseBody | None = None
    settlement_failed_response_body: SettlementFailedResponseBody | None = None
    extensions: dict[str, Any] | None = None
    hook_timeout_seconds: float | None = None


ProtectedRequestHook = Callable[
    [HTTPRequestContext, RouteConfig],
    ProtectedRequestHookResult | None | Awaitable[ProtectedRequestHookResult | None],
]


RoutesConfig = dict[str, RouteConfig] | RouteConfig


@dataclass
class CompiledRoute:
    """A compiled route with regex pattern."""

    verb: str
    regex: re.Pattern[str]
    config: RouteConfig
    pattern: str = ""


# ============================================================================
# Error Types
# ============================================================================


@dataclass
class RouteValidationError:
    """Validation error for a route configuration."""

    route_pattern: str
    scheme: str
    network: str
    reason: Literal["missing_scheme", "missing_facilitator"]
    message: str


class RouteConfigurationError(Exception):
    """Error raised when route configuration is invalid."""

    def __init__(self, errors: list[RouteValidationError]) -> None:
        messages = "\n".join(f"  - {e.message}" for e in errors)
        super().__init__(f"x402 Route Configuration Errors:\n{messages}")
        self.errors = errors
