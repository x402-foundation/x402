"""HTTP-enhanced resource server for x402 protocol.

Provides both async (x402HTTPResourceServer) and sync (x402HTTPResourceServerSync)
implementations for framework-specific middleware integration.
"""

from __future__ import annotations

import asyncio
import inspect
from typing import TYPE_CHECKING, Any

from ..schemas import PaymentPayload, PaymentRequirements, SettleResponse
from ..schemas.errors import SettleError
from ..schemas.v1 import PaymentPayloadV1
from ..server import ResourceConfig
from .types import (
    HTTPProcessResult,
    HTTPRequestContext,
    HTTPResponseInstructions,
    PaymentOption,
    PaywallConfig,
    ProcessSettleResult,
    RoutesConfig,
)
from .x402_http_server_base import PaywallProvider, x402HTTPServerBase

if TYPE_CHECKING:
    from ..server import x402ResourceServerSync

__all__ = [
    "x402HTTPResourceServer",
    "x402HTTPResourceServerSync",
    "PaywallProvider",
]


# ============================================================================
# Async HTTP Resource Server (for FastAPI, Starlette, etc.)
# ============================================================================


class x402HTTPResourceServer(x402HTTPServerBase):
    """Async HTTP resource server for x402 payment handling.

    Use this with async frameworks like FastAPI or Starlette.
    Supports both sync and async callbacks for dynamic price/payTo.

    Example:
        ```python
        from x402.http import x402HTTPResourceServer

        http_server = x402HTTPResourceServer(resource_server, routes)

        # In FastAPI middleware:
        result = await http_server.process_http_request(context)
        ```
    """

    def register_paywall_provider(self, provider: PaywallProvider) -> x402HTTPResourceServer:
        """Register custom paywall provider for HTML generation.

        Args:
            provider: PaywallProvider instance.

        Returns:
            Self for chaining.
        """
        self._paywall_provider = provider
        return self

    async def process_http_request(
        self,
        context: HTTPRequestContext,
        paywall_config: PaywallConfig | None = None,
    ) -> HTTPProcessResult:
        """Process HTTP request asynchronously.

        Main entry point for async framework middleware.

        Args:
            context: HTTP request context.
            paywall_config: Optional paywall configuration.

        Returns:
            HTTPProcessResult indicating:
            - no-payment-required: Route doesn't require payment
            - payment-verified: Payment valid, proceed with request
            - payment-error: Return 402 response
        """
        gen = self._process_request_core(context, paywall_config)
        result = None
        exception = None
        try:
            while True:
                if exception is not None:
                    # Pass exception to generator for handling
                    phase, target, ctx = gen.throw(exception)
                    exception = None
                else:
                    phase, target, ctx = gen.send(result)

                if phase == "resolve_options":
                    # Build requirements from payment options (Resolves dynamic price/pay_to)
                    route_config = target
                    timeout = route_config.hook_timeout_seconds
                    try:
                        result = await self._build_payment_requirements_from_options(
                            route_config.accepts, ctx, timeout=timeout
                        )
                    except asyncio.TimeoutError:
                        exception = TimeoutError("Hook execution timed out")
                        result = None
                    except Exception as e:
                        exception = e
                        result = None
                elif phase == "verify_payment":
                    # Verify payment (await async method)
                    payload, reqs = target
                    result = await self._server.verify_payment(payload, reqs)
                else:
                    result = None
        except StopIteration as e:
            return e.value

    async def process_settlement(
        self,
        payment_payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements,
        context: HTTPRequestContext | None = None,
    ) -> ProcessSettleResult:
        """Process settlement after successful response (async).

        Call this after the protected resource has been served.

        Args:
            payment_payload: The verified payment payload.
            requirements: The matching payment requirements.
            context: Optional HTTP request context for route config lookup and hooks.

        Returns:
            ProcessSettleResult with headers if success, or response if failure.
        """
        try:
            settle_response = await self._server.settle_payment(
                payment_payload,
                requirements,
            )

            if not settle_response.success:
                failure = ProcessSettleResult(
                    success=False,
                    error_reason=settle_response.error_reason or "Settlement failed",
                    headers=self._create_settlement_headers(settle_response, requirements),
                    transaction=settle_response.transaction,
                    network=settle_response.network,
                    payer=settle_response.payer,
                )
                failure.response = await self._build_settlement_failure_response_async(
                    failure, context
                )
                return failure

            return ProcessSettleResult(
                success=True,
                headers=self._create_settlement_headers(settle_response, requirements),
                transaction=settle_response.transaction,
                network=settle_response.network,
                payer=settle_response.payer,
            )

        except SettleError as e:
            settle_response = SettleResponse(
                success=False,
                error_reason=e.error_reason,
                error_message=e.error_message or e.error_reason,
                transaction=e.transaction or "",
                network=requirements.network,
                payer=e.payer,
            )
            failure = ProcessSettleResult(
                success=False,
                error_reason=e.error_reason,
                headers=self._create_settlement_headers(settle_response, requirements),
                transaction=settle_response.transaction,
                network=settle_response.network,
                payer=settle_response.payer,
            )
            failure.response = await self._build_settlement_failure_response_async(failure, context)
            return failure

        except Exception as e:
            settle_response = SettleResponse(
                success=False,
                error_reason=str(e),
                error_message=str(e),
                transaction="",
                network=requirements.network,
            )
            failure = ProcessSettleResult(
                success=False,
                error_reason=str(e),
                headers=self._create_settlement_headers(settle_response, requirements),
                transaction="",
                network=requirements.network,
            )
            failure.response = await self._build_settlement_failure_response_async(failure, context)
            return failure

    async def _build_settlement_failure_response_async(
        self,
        failure: ProcessSettleResult,
        context: HTTPRequestContext | None,
    ) -> HTTPResponseInstructions:
        """Build HTTPResponseInstructions for settlement failure (async).

        Awaits settlement_failed_response_body hook if it returns a coroutine.
        """
        settlement_headers = failure.headers
        route_config = self._get_route_config(context.path, context.method) if context else None

        custom_body = None
        if route_config and route_config.settlement_failed_response_body:
            hook_result = route_config.settlement_failed_response_body(context, failure)
            if asyncio.iscoroutine(hook_result):
                custom_body = await hook_result
            else:
                custom_body = hook_result

        content_type = custom_body.content_type if custom_body else "application/json"
        body = custom_body.body if custom_body else {}

        return HTTPResponseInstructions(
            status=402,
            headers={
                "Content-Type": content_type,
                **settlement_headers,
            },
            body=body,
            is_html=content_type.startswith("text/html"),
        )

    async def _build_payment_requirements_from_options(
        self,
        options: PaymentOption | list[PaymentOption],
        context: HTTPRequestContext,
        timeout: float | None,
    ) -> list[PaymentRequirements]:
        """Build payment requirements from payment options.

        Resolves dynamic payTo/price functions (supports async and sync).
        """
        # Ensure options is a list
        if isinstance(options, PaymentOption):
            options = [options]

        all_requirements = []

        for option in options:
            # Resolve dynamic values for the option
            pay_to = await self._resolve_value(
                option.pay_to, context, timeout=timeout, field_name="pay_to"
            )
            price = await self._resolve_value(
                option.price, context, timeout=timeout, field_name="price"
            )

            # Build requirements using server
            config = ResourceConfig(
                scheme=option.scheme,
                pay_to=pay_to,
                price=price,
                network=option.network,
                max_timeout_seconds=option.max_timeout_seconds,
                extra=option.extra,
            )

            requirements = self._server.build_payment_requirements(config)
            all_requirements.extend(requirements)

        return all_requirements

    async def _resolve_value(
        self,
        value: Any,
        context: HTTPRequestContext,
        timeout: float | None,
        field_name: str = "value",
    ) -> Any:
        """Resolve a value that could be a static value or an async/sync hook."""
        if callable(value):
            result = value(context)
            # Check if the result is a coroutine or future (async)
            if asyncio.iscoroutine(result) or asyncio.isfuture(result):
                return await asyncio.wait_for(result, timeout=timeout)
            # Synchronous function - return result directly
            return result
        return value


# ============================================================================
# Sync HTTP Resource Server (for Flask, Django, etc.)
# ============================================================================


class x402HTTPResourceServerSync(x402HTTPServerBase):
    """Sync HTTP resource server for x402 payment handling.

    Use this with sync frameworks like Flask or Django.
    Only supports sync callbacks for dynamic price/payTo.

    IMPORTANT: Use with x402ResourceServerSync (not x402ResourceServer).
    The async x402ResourceServer has async verify/settle methods that
    cannot be called from sync code.

    Example:
        ```python
        from x402 import x402ResourceServerSync
        from x402.http import x402HTTPResourceServerSync

        # Use sync resource server with sync HTTP server
        server = x402ResourceServerSync(facilitator)
        server.register("eip155:8453", ExactEvmServerScheme())
        http_server = x402HTTPResourceServerSync(server, routes)

        # In Flask middleware:
        result = http_server.process_http_request(context)
        ```
    """

    def __init__(
        self,
        server: x402ResourceServerSync,  # type: ignore[override]
        routes: RoutesConfig,
    ) -> None:
        """Create sync HTTP resource server.

        Args:
            server: Core x402ResourceServerSync instance (must be sync variant).
            routes: Route configuration for payment-protected endpoints.

        Raises:
            TypeError: If server is not x402ResourceServerSync.
        """
        # Runtime validation - catch mismatched sync/async early
        verify_method = getattr(server, "verify_payment", None)
        if verify_method and inspect.iscoroutinefunction(verify_method):
            raise TypeError(
                f"x402HTTPResourceServerSync requires a sync server, "
                f"but got {type(server).__name__} which has async methods. "
                f"Use x402ResourceServerSync instead of x402ResourceServer, "
                f"or use x402HTTPResourceServer (async) with x402ResourceServer."
            )

        super().__init__(server, routes)  # type: ignore[arg-type]

    def register_paywall_provider(self, provider: PaywallProvider) -> x402HTTPResourceServerSync:
        """Register custom paywall provider for HTML generation.

        Args:
            provider: PaywallProvider instance.

        Returns:
            Self for chaining.
        """
        self._paywall_provider = provider
        return self

    def process_http_request(
        self,
        context: HTTPRequestContext,
        paywall_config: PaywallConfig | None = None,
    ) -> HTTPProcessResult:
        """Process HTTP request synchronously.

        Main entry point for sync framework middleware.

        Args:
            context: HTTP request context.
            paywall_config: Optional paywall configuration.

        Returns:
            HTTPProcessResult indicating:
            - no-payment-required: Route doesn't require payment
            - payment-verified: Payment valid, proceed with request
            - payment-error: Return 402 response
        """
        gen = self._process_request_core(context, paywall_config)
        result = None
        try:
            while True:
                phase, target, ctx = gen.send(result)
                if phase == "resolve_options":
                    # Build requirements from payment options (Resolves dynamic price/pay_to)
                    route_config = target
                    result = self._build_payment_requirements_from_options_sync(
                        route_config.accepts, ctx
                    )
                elif phase == "verify_payment":
                    # Verify payment
                    payload, reqs = target
                    result = self._server.verify_payment(payload, reqs)
                else:
                    result = None
        except StopIteration as e:
            return e.value

    def _build_payment_requirements_from_options_sync(
        self,
        options: PaymentOption | list[PaymentOption],
        context: HTTPRequestContext,
    ) -> list[PaymentRequirements]:
        """Build payment requirements from payment options.

        Resolves dynamic payTo/price functions (sync only).
        """
        # Ensure options is a list
        if isinstance(options, PaymentOption):
            options = [options]

        all_requirements = []

        for option in options:
            # Resolve dynamic values for the option (sync only)
            pay_to = self._resolve_value_sync(option.pay_to, context)
            price = self._resolve_value_sync(option.price, context)

            # Build requirements using server
            config = ResourceConfig(
                scheme=option.scheme,
                pay_to=pay_to,
                price=price,
                network=option.network,
                max_timeout_seconds=option.max_timeout_seconds,
                extra=option.extra,
            )

            requirements = self._server.build_payment_requirements(config)
            all_requirements.extend(requirements)

        return all_requirements

    def _resolve_value_sync(
        self,
        value: Any,
        context: HTTPRequestContext,
    ) -> Any:
        """Resolve a value that could be a static value or a sync hook.

        Note: Async callbacks are NOT supported in sync server.
        If an async callback is passed, it will raise an error.
        """
        if callable(value):
            result = value(context)
            # Check if the result is a coroutine (async) - not supported
            if asyncio.iscoroutine(result):
                # Close the coroutine to avoid warning
                result.close()
                raise TypeError(
                    "Async callbacks are not supported in x402HTTPResourceServerSync. "
                    "Use x402HTTPResourceServer for async callback support, or provide "
                    "a synchronous callback function."
                )
            return result
        return value
