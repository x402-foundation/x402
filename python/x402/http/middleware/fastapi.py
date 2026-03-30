"""FastAPI/Starlette middleware for x402 payment handling.

Provides payment-gated route protection for FastAPI applications.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

try:
    from fastapi import Request, Response
    from fastapi.responses import HTMLResponse, JSONResponse
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.types import ASGIApp
except ImportError as e:
    raise ImportError(
        "FastAPI middleware requires fastapi and starlette. Install with: uv add x402[fastapi]"
    ) from e

from ..facilitator_client_base import FacilitatorResponseError
from ..types import (
    HTTPAdapter,
    HTTPRequestContext,
    PaywallConfig,
    RouteConfig,
    RoutesConfig,
)
from ..x402_http_server import PaywallProvider, x402HTTPResourceServer

if TYPE_CHECKING:
    from ...server import x402ResourceServer


# ============================================================================
# Extension Auto-Registration
# ============================================================================


def _check_if_bazaar_needed(routes: RoutesConfig) -> bool:
    """Check if any routes in the configuration declare bazaar extensions.

    Args:
        routes: Route configuration.

    Returns:
        True if any route has extensions.bazaar defined.
    """
    # Handle single RouteConfig instance
    if isinstance(routes, RouteConfig):
        return bool(routes.extensions and "bazaar" in routes.extensions)

    # Handle dict of routes
    if isinstance(routes, dict):
        # Check if it's a single route config dict (has "accepts" key)
        if "accepts" in routes:
            extensions = routes.get("extensions", {})
            return bool(extensions and "bazaar" in extensions)

        # Handle multiple routes
        for route_config in routes.values():
            if isinstance(route_config, RouteConfig):
                if route_config.extensions and "bazaar" in route_config.extensions:
                    return True
            elif isinstance(route_config, dict):
                extensions = route_config.get("extensions", {})
                if extensions and "bazaar" in extensions:
                    return True

    return False


def _register_bazaar_extension(server: x402ResourceServer) -> None:
    """Register bazaar extension with server if available.

    Args:
        server: x402ResourceServer to register extension with.
    """
    try:
        from ...extensions.bazaar import bazaar_resource_server_extension

        server.register_extension(bazaar_resource_server_extension)
    except ImportError:
        # Bazaar extension not available, skip silently
        pass


# ============================================================================
# FastAPI Adapter
# ============================================================================


class FastAPIAdapter(HTTPAdapter):
    """Adapter for FastAPI/Starlette Request.

    Implements HTTPAdapter protocol for FastAPI framework.
    """

    def __init__(self, request: Request) -> None:
        """Create adapter from FastAPI request.

        Args:
            request: FastAPI/Starlette request object.
        """
        self._request = request

    def get_header(self, name: str) -> str | None:
        """Get header value (case-insensitive).

        Args:
            name: Header name.

        Returns:
            Header value or None.
        """
        return self._request.headers.get(name)

    def get_method(self) -> str:
        """Get HTTP method.

        Returns:
            HTTP method (GET, POST, etc.).
        """
        return self._request.method

    def get_path(self) -> str:
        """Get request path.

        Returns:
            Request path.
        """
        return self._request.url.path

    def get_url(self) -> str:
        """Get full request URL.

        Returns:
            Full URL string.
        """
        return str(self._request.url)

    def get_accept_header(self) -> str:
        """Get Accept header.

        Returns:
            Accept header value.
        """
        return self._request.headers.get("accept", "")

    def get_user_agent(self) -> str:
        """Get User-Agent header.

        Returns:
            User-Agent header value.
        """
        return self._request.headers.get("user-agent", "")

    def get_query_params(self) -> dict[str, str | list[str]]:
        """Get query parameters.

        Returns:
            Dict of query parameters.
        """
        return dict(self._request.query_params)

    def get_query_param(self, name: str) -> str | None:
        """Get single query parameter.

        Args:
            name: Parameter name.

        Returns:
            Parameter value or None.
        """
        return self._request.query_params.get(name)

    def get_body(self) -> Any:
        """Get request body (requires async read in actual impl).

        Returns:
            None (body requires async access).
        """
        return None  # Body requires async access


# ============================================================================
# Middleware Implementation
# ============================================================================


def _facilitator_error_response(error: FacilitatorResponseError) -> JSONResponse:
    """Map invalid facilitator responses to a stable HTTP error."""
    return JSONResponse(
        content={"error": str(error)},
        status_code=502,
    )


def payment_middleware(
    routes: RoutesConfig,
    server: x402ResourceServer,
    paywall_config: PaywallConfig | None = None,
    paywall_provider: PaywallProvider | None = None,
    sync_facilitator_on_start: bool = True,
) -> Callable[[Request, Callable[[Request], Awaitable[Response]]], Awaitable[Response]]:
    """Create FastAPI payment middleware with pre-configured server.

    Args:
        routes: Route configuration for protected endpoints.
        server: Pre-configured x402ResourceServer.
        paywall_config: Optional paywall UI configuration.
        paywall_provider: Optional custom paywall provider.
        sync_facilitator_on_start: Fetch facilitator support on first request.

    Returns:
        FastAPI middleware function.

    Example:
        ```python
        from fastapi import FastAPI
        from x402 import x402ResourceServer
        from x402.http import HTTPFacilitatorClient
        from x402.http.middleware import fastapi_payment_middleware

        app = FastAPI()

        # Configure server
        facilitator = HTTPFacilitatorClient()
        server = x402ResourceServer(facilitator)
        # ... register schemes ...

        # Define routes
        routes = {
            "GET /api/weather/*": {
                "accepts": {
                    "scheme": "exact",
                    "payTo": "0x...",
                    "price": "$0.01",
                    "network": "eip155:84532",
                }
            }
        }

        # Add middleware
        @app.middleware("http")
        async def x402_middleware(request, call_next):
            return await fastapi_payment_middleware(routes, server)(request, call_next)
        ```
    """
    # Auto-register bazaar extension if routes declare it
    if _check_if_bazaar_needed(routes):
        _register_bazaar_extension(server)

    # Create HTTP server wrapper
    http_server = x402HTTPResourceServer(server, routes)

    if paywall_provider:
        http_server.register_paywall_provider(paywall_provider)

    # Lazy initialization state with async lock for concurrency safety
    init_done = False
    init_lock = asyncio.Lock()

    async def middleware(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        nonlocal init_done

        # Create adapter and context
        adapter = FastAPIAdapter(request)
        context = HTTPRequestContext(
            adapter=adapter,
            path=request.url.path,
            method=request.method,
            payment_header=(
                adapter.get_header("payment-signature") or adapter.get_header("x-payment")
            ),
        )

        # Check if route requires payment (before initialization)
        if not http_server.requires_payment(context):
            return await call_next(request)

        # Initialize on first protected request (double-checked locking)
        if sync_facilitator_on_start and not init_done:
            async with init_lock:
                if not init_done:
                    try:
                        http_server.initialize()
                    except FacilitatorResponseError as error:
                        return _facilitator_error_response(error)
                    init_done = True

        # Process payment request
        try:
            result = await http_server.process_http_request(context, paywall_config)
        except FacilitatorResponseError as error:
            return _facilitator_error_response(error)

        if result.type == "no-payment-required":
            return await call_next(request)

        if result.type == "payment-error":
            # Return 402 response
            response = result.response
            if response is None:
                return JSONResponse(
                    content={"error": "Payment required"},
                    status_code=402,
                )

            if response.is_html:
                return HTMLResponse(
                    content=response.body,
                    status_code=response.status,
                    headers=response.headers,
                )
            else:
                return JSONResponse(
                    content=response.body or {},
                    status_code=response.status,
                    headers=response.headers,
                )

        if result.type == "payment-verified":
            # Store payment info in request state
            request.state.payment_payload = result.payment_payload
            request.state.payment_requirements = result.payment_requirements

            # Call protected route
            response = await call_next(request)

            # Don't settle on error responses
            if response.status_code >= 400:
                return response

            # Read response body for potential buffering
            body = b""
            async for chunk in response.body_iterator:
                body += chunk

            # Process settlement (await async method)
            try:
                settle_result = await http_server.process_settlement(
                    result.payment_payload,
                    result.payment_requirements,
                    context=context,
                )

                if not settle_result.success:
                    # Use response from process_settlement (includes PAYMENT-RESPONSE
                    # header and empty body by default)
                    resp = settle_result.response
                    if resp is None:
                        return JSONResponse(content={}, status_code=402)
                    if resp.is_html:
                        return Response(
                            content=resp.body,
                            status_code=resp.status,
                            headers=resp.headers,
                            media_type="text/html",
                        )
                    return JSONResponse(
                        content=resp.body or {},
                        status_code=resp.status,
                        headers=resp.headers,
                    )

                # Add settlement headers
                headers = dict(response.headers)
                headers.update(settle_result.headers)

                return Response(
                    content=body,
                    status_code=response.status_code,
                    headers=headers,
                    media_type=response.media_type,
                )

            except FacilitatorResponseError as error:
                return _facilitator_error_response(error)
            except Exception:
                return JSONResponse(content={}, status_code=402)

        # Fallthrough - should not happen
        return await call_next(request)

    return middleware


def payment_middleware_from_config(
    routes: RoutesConfig,
    facilitator_client: Any = None,
    schemes: list[dict[str, Any]] | None = None,
    paywall_config: PaywallConfig | None = None,
    paywall_provider: PaywallProvider | None = None,
    sync_facilitator_on_start: bool = True,
) -> Callable[[Request, Callable[[Request], Awaitable[Response]]], Awaitable[Response]]:
    """Create FastAPI payment middleware from configuration.

    Convenience function that creates x402ResourceServer internally.

    Args:
        routes: Route configuration for protected endpoints.
        facilitator_client: Facilitator client(s) for payment processing.
        schemes: Scheme registrations for server-side processing.
        paywall_config: Optional paywall UI configuration.
        paywall_provider: Optional custom paywall provider.
        sync_facilitator_on_start: Fetch facilitator support on first request.

    Returns:
        FastAPI middleware function.
    """
    from ...server import x402ResourceServer

    server = x402ResourceServer(facilitator_client)

    if schemes:
        for registration in schemes:
            server.register(registration["network"], registration["server"])

    return payment_middleware(
        routes,
        server,
        paywall_config,
        paywall_provider,
        sync_facilitator_on_start,
    )


# ============================================================================
# Alternative: Starlette Middleware Class
# ============================================================================


class PaymentMiddlewareASGI(BaseHTTPMiddleware):
    """ASGI middleware class for payment handling.

    Alternative to the function-based middleware for use with
    app.add_middleware().

    Example:
        ```python
        app.add_middleware(
            PaymentMiddlewareASGI,
            routes=routes,
            server=server,
        )
        ```
    """

    def __init__(
        self,
        app: ASGIApp,
        routes: RoutesConfig,
        server: x402ResourceServer,
        paywall_config: PaywallConfig | None = None,
        paywall_provider: PaywallProvider | None = None,
    ) -> None:
        """Initialize ASGI middleware.

        Args:
            app: ASGI application.
            routes: Route configuration.
            server: x402ResourceServer instance.
            paywall_config: Optional paywall config.
            paywall_provider: Optional custom paywall provider.
        """
        super().__init__(app)
        self._middleware = payment_middleware(routes, server, paywall_config, paywall_provider)

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        """Dispatch request through payment middleware.

        Args:
            request: Incoming request.
            call_next: Next handler in chain.

        Returns:
            Response.
        """
        return await self._middleware(request, call_next)
