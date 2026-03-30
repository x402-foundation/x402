"""Flask middleware for x402 payment handling.

Provides payment-gated route protection for Flask applications.
Uses x402HTTPResourceServerSync for synchronous request processing without asyncio overhead.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Callable, Iterator
from typing import TYPE_CHECKING, Any

try:
    from flask import Flask, Request, g, request
except ImportError as e:
    raise ImportError(
        "Flask middleware requires the flask package. Install with: uv add x402[flask]"
    ) from e

from ..facilitator_client_base import FacilitatorResponseError
from ..types import (
    HTTPAdapter,
    HTTPRequestContext,
    PaywallConfig,
    RouteConfig,
    RoutesConfig,
)
from ..x402_http_server import PaywallProvider, x402HTTPResourceServerSync

if TYPE_CHECKING:
    from ...server import x402ResourceServerSync


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


def _register_bazaar_extension(server: x402ResourceServerSync) -> None:
    """Register bazaar extension with server if available.

    Args:
        server: x402ResourceServerSync to register extension with.
    """
    try:
        from ...extensions.bazaar import bazaar_resource_server_extension

        server.register_extension(bazaar_resource_server_extension)
    except ImportError:
        # Bazaar extension not available, skip silently
        pass


# ============================================================================
# Flask Adapter
# ============================================================================


class FlaskAdapter(HTTPAdapter):
    """Adapter for Flask Request.

    Implements HTTPAdapter protocol for Flask framework.
    """

    def __init__(self, request: Request) -> None:
        """Create adapter from Flask request.

        Args:
            request: Flask request object.
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
        return self._request.path

    def get_url(self) -> str:
        """Get full request URL.

        Returns:
            Full URL string.
        """
        return self._request.url

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
        return dict(self._request.args)

    def get_query_param(self, name: str) -> str | None:
        """Get single query parameter.

        Args:
            name: Parameter name.

        Returns:
            Parameter value or None.
        """
        return self._request.args.get(name)

    def get_body(self) -> Any:
        """Get request body.

        Returns:
            Parsed JSON body or None.
        """
        return self._request.get_json(silent=True)


# ============================================================================
# Response Wrapper for Settlement
# ============================================================================


def _facilitator_error_wsgi_response(
    start_response: Callable[..., Any],
    error: FacilitatorResponseError,
) -> list[bytes]:
    """Map invalid facilitator responses to a stable HTTP error."""
    body = json.dumps({"error": str(error)}).encode("utf-8")
    start_response(
        "502 Bad Gateway",
        [("Content-Type", "application/json")],
    )
    return [body]


class ResponseWrapper:
    """Wrapper to capture and buffer WSGI response for settlement.

    Captures status, headers, and body from the WSGI response so we can
    process settlement before releasing to the client.
    """

    def __init__(self, start_response: Callable[..., Any]) -> None:
        """Create response wrapper.

        Args:
            start_response: Original WSGI start_response callable.
        """
        self._original_start_response = start_response
        self.status: str | None = None
        self.status_code: int | None = None
        self.headers: list[tuple[str, str]] = []
        self._write_chunks: list[bytes] = []

    def __call__(
        self,
        status: str,
        headers: list[tuple[str, str]],
        exc_info: Any = None,
    ) -> Callable[[bytes], None]:
        """Capture status and headers, return buffered write function.

        Args:
            status: HTTP status string.
            headers: Response headers.
            exc_info: Exception info (if any).

        Returns:
            Buffered write function.
        """
        self.status = status
        self.status_code = int(status.split()[0])
        self.headers = list(headers)

        def buffered_write(data: bytes) -> None:
            if data:
                self._write_chunks.append(data)

        return buffered_write

    def add_header(self, name: str, value: str) -> None:
        """Add header to response.

        Args:
            name: Header name.
            value: Header value.
        """
        self.headers.append((name, value))

    def send_response(self, body_chunks: list[bytes]) -> None:
        """Send buffered response to client.

        Args:
            body_chunks: Response body chunks.
        """
        write = self._original_start_response(self.status, self.headers)

        # Send write() chunks first
        for chunk in self._write_chunks:
            if chunk:
                write(chunk)

        # Then body iterator chunks
        for chunk in body_chunks:
            if chunk:
                write(chunk)


# ============================================================================
# Flask Middleware Class
# ============================================================================


class PaymentMiddleware:
    """Flask WSGI middleware for x402 payment handling.

    Example:
        ```python
        from flask import Flask
        from x402 import x402ResourceServer
        from x402.http import HTTPFacilitatorClient
        from x402.http.middleware import FlaskPaymentMiddleware

        app = Flask(__name__)

        # Configure server
        facilitator = HTTPFacilitatorClient()
        server = x402ResourceServer(facilitator)

        # Define routes
        routes = {
            "GET /api/weather/*": {
                "accepts": {...}
            }
        }

        # Add middleware
        middleware = FlaskPaymentMiddleware(app, routes, server)
        ```
    """

    def __init__(
        self,
        app: Flask,
        routes: RoutesConfig,
        server: x402ResourceServerSync,
        paywall_config: PaywallConfig | None = None,
        paywall_provider: PaywallProvider | None = None,
        sync_facilitator_on_start: bool = True,
    ) -> None:
        """Initialize Flask payment middleware.

        Args:
            app: Flask application.
            routes: Route configuration.
            server: x402ResourceServerSync instance (must be sync variant).
            paywall_config: Optional paywall configuration.
            paywall_provider: Optional custom paywall provider.
            sync_facilitator_on_start: Initialize on first protected request.
        """
        # Auto-register bazaar extension if routes declare it
        if _check_if_bazaar_needed(routes):
            _register_bazaar_extension(server)

        self._app = app
        self._http_server = x402HTTPResourceServerSync(server, routes)
        self._paywall_config = paywall_config
        self._sync_on_start = sync_facilitator_on_start
        self._init_done = False
        self._init_lock = threading.Lock()
        self._original_wsgi = app.wsgi_app

        if paywall_provider:
            self._http_server.register_paywall_provider(paywall_provider)

        # Replace WSGI app
        app.wsgi_app = self._wsgi_middleware  # type: ignore

    def _wsgi_middleware(
        self,
        environ: dict[str, Any],
        start_response: Callable[..., Any],
    ) -> Iterator[bytes]:
        """WSGI middleware entry point.

        Args:
            environ: WSGI environment.
            start_response: WSGI start_response callable.

        Returns:
            Response body iterator.
        """
        with self._app.request_context(environ):
            # Create adapter and context
            adapter = FlaskAdapter(request)
            context = HTTPRequestContext(
                adapter=adapter,
                path=request.path,
                method=request.method,
                payment_header=(
                    adapter.get_header("payment-signature") or adapter.get_header("x-payment")
                ),
            )

            # Check if route requires payment
            if not self._http_server.requires_payment(context):
                return self._original_wsgi(environ, start_response)

            # Initialize on first protected request (double-checked locking)
            if self._sync_on_start and not self._init_done:
                with self._init_lock:
                    if not self._init_done:
                        try:
                            self._http_server.initialize()
                        except FacilitatorResponseError as error:
                            return _facilitator_error_wsgi_response(start_response, error)
                        self._init_done = True

            # Process payment request synchronously (no asyncio overhead)
            try:
                result = self._http_server.process_http_request(context, self._paywall_config)
            except FacilitatorResponseError as error:
                return _facilitator_error_wsgi_response(start_response, error)

            if result.type == "no-payment-required":
                return self._original_wsgi(environ, start_response)

            if result.type == "payment-error":
                # Return 402 response
                response = result.response
                if response is None:
                    status = "402 Payment Required"
                    headers = [("Content-Type", "application/json")]
                    body = json.dumps({"error": "Payment required"}).encode("utf-8")
                    start_response(status, headers)
                    return [body]

                status = f"{response.status} Payment Required"
                headers = list(response.headers.items())

                if response.is_html:
                    headers.append(("Content-Type", "text/html; charset=utf-8"))
                    body = (
                        response.body.encode("utf-8")
                        if isinstance(response.body, str)
                        else response.body
                    )
                else:
                    headers.append(("Content-Type", "application/json"))
                    body = json.dumps(response.body or {}).encode("utf-8")

                start_response(status, headers)
                return [body]

            if result.type == "payment-verified":
                # Store in Flask g object
                g.payment_payload = result.payment_payload
                g.payment_requirements = result.payment_requirements

                # Capture response
                response_wrapper = ResponseWrapper(start_response)
                body_chunks: list[bytes] = []

                for chunk in self._original_wsgi(environ, response_wrapper):
                    body_chunks.append(chunk)

                # Check if successful response
                if (
                    response_wrapper.status_code is not None
                    and 200 <= response_wrapper.status_code < 300
                ):
                    # Settle payment
                    try:
                        settle_result = self._http_server.process_settlement(
                            result.payment_payload,
                            result.payment_requirements,
                            context=context,
                        )

                        if settle_result.success:
                            # Add settlement headers
                            for key, value in settle_result.headers.items():
                                response_wrapper.add_header(key, value)
                        else:
                            # Settlement failed - use response from process_settlement
                            # (includes PAYMENT-RESPONSE header and empty body by default)
                            response = settle_result.response
                            if response is None:
                                status = "402 Payment Required"
                                headers = [("Content-Type", "application/json")]
                                body = json.dumps({}).encode("utf-8")
                            else:
                                status = f"{response.status} Payment Required"
                                headers = list(response.headers.items())
                                if response.is_html:
                                    body = (
                                        response.body.encode("utf-8")
                                        if isinstance(response.body, str)
                                        else response.body
                                    )
                                else:
                                    body = json.dumps(response.body or {}).encode("utf-8")
                            start_response(status, headers)
                            return [body]

                    except FacilitatorResponseError as error:
                        return _facilitator_error_wsgi_response(start_response, error)

                    except Exception:
                        # Settlement error - return empty body with 402
                        start_response(
                            "402 Payment Required",
                            [("Content-Type", "application/json")],
                        )
                        return [json.dumps({}).encode("utf-8")]

                # Send buffered response
                response_wrapper.send_response(body_chunks)
                return []

        # Fallthrough
        return self._original_wsgi(environ, start_response)


# ============================================================================
# Convenience Functions
# ============================================================================


def payment_middleware(
    app: Flask,
    routes: RoutesConfig,
    server: x402ResourceServerSync,
    paywall_config: PaywallConfig | None = None,
    paywall_provider: PaywallProvider | None = None,
    sync_facilitator_on_start: bool = True,
) -> PaymentMiddleware:
    """Create Flask payment middleware with pre-configured server.

    Args:
        app: Flask application.
        routes: Route configuration for protected endpoints.
        server: Pre-configured x402ResourceServerSync (must be sync variant).
        paywall_config: Optional paywall UI configuration.
        paywall_provider: Optional custom paywall provider.
        sync_facilitator_on_start: Fetch facilitator support on first request.

    Returns:
        PaymentMiddleware instance.
    """
    return PaymentMiddleware(
        app, routes, server, paywall_config, paywall_provider, sync_facilitator_on_start
    )


def payment_middleware_from_config(
    app: Flask,
    routes: RoutesConfig,
    facilitator_client: Any = None,
    schemes: list[dict[str, Any]] | None = None,
    paywall_config: PaywallConfig | None = None,
    paywall_provider: PaywallProvider | None = None,
    sync_facilitator_on_start: bool = True,
) -> PaymentMiddleware:
    """Create Flask payment middleware from configuration.

    Args:
        app: Flask application.
        routes: Route configuration for protected endpoints.
        facilitator_client: Facilitator client(s) for payment processing.
        schemes: Scheme registrations for server-side processing.
        paywall_config: Optional paywall UI configuration.
        paywall_provider: Optional custom paywall provider.
        sync_facilitator_on_start: Fetch facilitator support on first request.

    Returns:
        PaymentMiddleware instance.
    """
    from ...server import x402ResourceServer

    server = x402ResourceServer(facilitator_client)

    if schemes:
        for registration in schemes:
            server.register(registration["network"], registration["server"])

    return PaymentMiddleware(
        app, routes, server, paywall_config, paywall_provider, sync_facilitator_on_start
    )
