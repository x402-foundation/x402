"""Extension types for the x402 Python SDK."""

from collections.abc import Awaitable
from typing import Any, Protocol

from .hooks import (
    ProtectedRequestHookResult,
    ServerPaymentRequiredContext,
    SettleContext,
    SettleFailureContext,
    SettleResultContext,
    VerifiedPaymentCanceledContext,
    VerifyContext,
    VerifyFailureContext,
    VerifyResultContext,
)


class HTTPResourceServerExtensionHooks(Protocol):
    """HTTP transport hooks for resource server extensions."""

    def on_protected_request(
        self,
        declaration: Any,
        transport_context: Any,
        route_config: Any | None = None,
    ) -> ProtectedRequestHookResult | None | Awaitable[ProtectedRequestHookResult | None]: ...


class ResourceServerTransportExtensionHooks(Protocol):
    """Transport-scoped hooks for resource server extensions."""

    http: HTTPResourceServerExtensionHooks | None


class ResourceServerExtensionHooks(Protocol):
    """Per-extension verify/settle lifecycle hooks."""

    def on_before_verify(
        self,
        declaration: Any,
        context: VerifyContext,
    ) -> None | dict[str, Any] | Awaitable[None | dict[str, Any]]: ...

    def on_after_verify(
        self,
        declaration: Any,
        context: VerifyResultContext,
    ) -> None | Awaitable[None]: ...

    def on_verify_failure(
        self,
        declaration: Any,
        context: VerifyFailureContext,
    ) -> None | dict[str, Any] | Awaitable[None | dict[str, Any]]: ...

    def on_before_settle(
        self,
        declaration: Any,
        context: SettleContext,
    ) -> None | dict[str, Any] | Awaitable[None | dict[str, Any]]: ...

    def on_after_settle(
        self,
        declaration: Any,
        context: SettleResultContext,
    ) -> None | Awaitable[None]: ...

    def on_settle_failure(
        self,
        declaration: Any,
        context: SettleFailureContext,
    ) -> None | dict[str, Any] | Awaitable[None | dict[str, Any]]: ...

    def on_verified_payment_canceled(
        self,
        declaration: Any,
        context: VerifiedPaymentCanceledContext,
    ) -> None | Awaitable[None]: ...


class ResourceServerExtension(Protocol):
    """Interface for resource server extensions (e.g., bazaar).

    Extensions can enrich payment declarations with additional data
    based on the transport context (e.g., HTTP request).
    """

    @property
    def key(self) -> str:
        """Unique extension key (e.g., 'bazaar')."""
        ...

    def enrich_declaration(
        self,
        declaration: Any,
        transport_context: Any,
    ) -> Any:
        """Enrich extension declaration with transport-specific data.

        Args:
            declaration: The extension declaration to enrich.
            transport_context: Framework-specific context (e.g., HTTP request).

        Returns:
            Enriched declaration.
        """
        ...

    def enrich_payment_required_response(
        self,
        declaration: Any,
        context: ServerPaymentRequiredContext,
    ) -> Any | None | Awaitable[Any | None]:
        """Merge extension payload into ``extensions[key]`` on the 402 response."""
        ...

    def enrich_settlement_response(
        self,
        declaration: Any,
        context: SettleResultContext,
    ) -> Any | None | Awaitable[Any | None]:
        """Merge extension payload into ``extensions[key]`` on the settle response."""
        ...

    @property
    def hooks(self) -> ResourceServerExtensionHooks | None:
        """Lifecycle hooks installed via register_extension."""
        ...

    @property
    def transport_hooks(self) -> ResourceServerTransportExtensionHooks | None:
        """Transport-specific hooks scoped to declared extension keys."""
        ...


class HTTPClientExtensionHooks(Protocol):
    """HTTP transport hooks for client extensions."""

    def on_payment_required(
        self,
        declaration: Any,
        context: Any,
    ) -> Any | Awaitable[Any]: ...


class ClientTransportExtensionHooks(Protocol):
    """Transport-scoped hooks for client extensions."""

    http: HTTPClientExtensionHooks | None


class ClientExtensionHooks(Protocol):
    """Per-extension payment creation and response hooks."""

    def on_before_payment_creation(
        self,
        declaration: Any,
        context: Any,
    ) -> None | dict[str, Any] | Awaitable[None | dict[str, Any]]: ...

    def on_after_payment_creation(
        self,
        declaration: Any,
        context: Any,
    ) -> None | Awaitable[None]: ...

    def on_payment_creation_failure(
        self,
        declaration: Any,
        context: Any,
    ) -> None | dict[str, Any] | Awaitable[None | dict[str, Any]]: ...

    def on_payment_response(
        self,
        declaration: Any,
        context: Any,
    ) -> None | dict[str, Any] | Awaitable[None | dict[str, Any]]: ...


class ClientExtension(Protocol):
    """Client-side extension for payload enrichment and lifecycle hooks."""

    @property
    def key(self) -> str:
        """Unique extension key."""
        ...

    def enrich_payment_payload(
        self,
        payment_payload: Any,
        payment_required: Any,
    ) -> Any | Awaitable[Any]:
        """Enrich payload when the extension key is present on the 402 response."""
        ...

    @property
    def hooks(self) -> ClientExtensionHooks | None:
        """Lifecycle hooks installed via register_extension."""
        ...

    @property
    def transport_hooks(self) -> ClientTransportExtensionHooks | None:
        """Transport-specific hooks scoped to declared extension keys."""
        ...
