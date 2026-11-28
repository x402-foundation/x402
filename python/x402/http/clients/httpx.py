"""httpx client wrapper with automatic x402 payment handling.

Provides transport wrappers for httpx AsyncClient and Client, and convenience
classes for AsyncClient.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

try:
    import httpx
    from httpx import AsyncBaseTransport, BaseTransport, Request, Response
except ImportError as e:
    raise ImportError(
        "httpx client requires the httpx package. Install with: uv add x402[httpx]"
    ) from e

from ..utils import ResponseBodyTooLargeError, aread_limited_body, read_limited_body

_RETRY_KEY = "_x402_is_retry"
_RECOVERY_KEY = "_x402_is_recovery"


def _bound_request(response: Response, fallback: Request) -> Request:
    """Request attached to a transport response, or the caller's request.

    httpx leaves ``Response.request`` unset until ``AsyncClient`` returns from
    the transport, and the property raises ``RuntimeError`` in that case.
    ``getattr`` does not catch that.
    """
    try:
        req = response.request
    except RuntimeError:
        return fallback
    if not isinstance(req, Request):
        return fallback
    return req


def _rebuild_payment_required(response: Response, request: Request, body: bytes) -> Response:
    """Rebuild a 402 around its already-read, size-bounded body."""
    req = _bound_request(response, request)
    extensions = getattr(response, "extensions", None)
    if not isinstance(extensions, dict):
        extensions = dict(request.extensions)
    # aiter_bytes() is already decoded, so these headers do not describe that body.
    headers = response.headers.copy()
    for name in ("content-encoding", "content-length"):
        if name in headers:
            del headers[name]
    return Response(
        status_code=402,
        headers=headers,
        content=body,
        request=req,
        extensions=extensions,
    )


async def _cap_returned_payment_required(response: Response, request: Request) -> Response:
    """Bound a 402 that will be returned to the caller. Paid payloads are unchanged."""
    if response.status_code != 402:
        return response
    try:
        body = await aread_limited_body(response.aiter_bytes())
    finally:
        await response.aclose()
    return _rebuild_payment_required(response, request, body)


def _cap_returned_payment_required_sync(response: Response, request: Request) -> Response:
    """Sync variant of ``_cap_returned_payment_required``."""
    if response.status_code != 402:
        return response
    try:
        body = read_limited_body(response.iter_bytes())
    finally:
        response.close()
    return _rebuild_payment_required(response, request, body)


def _retry_request(
    request: Request,
    extra_headers: dict[str, str],
    *,
    payment_retry: bool = False,
    recovery_retry: bool = False,
) -> Request:
    """Clone a buffered request with extra headers and x402 retry markers."""
    # The retry sends the buffered body, so httpx sets its own Content-Length.
    new_headers = request.headers.copy()
    for name in ("content-length", "transfer-encoding"):
        if name in new_headers:
            del new_headers[name]
    # Replace case-insensitively so an existing header is not sent twice.
    for name, value in extra_headers.items():
        new_headers[name] = value
    new_extensions = dict(request.extensions)
    if payment_retry:
        new_extensions[_RETRY_KEY] = True
    if recovery_retry:
        new_extensions[_RECOVERY_KEY] = True
    return Request(
        method=request.method,
        url=request.url,
        headers=new_headers,
        content=request.content,
        extensions=new_extensions,
    )


def _is_retry(request: Request) -> bool:
    return bool(request.extensions.get(_RETRY_KEY) or request.extensions.get(_RECOVERY_KEY))


def _parse_json_body(body_bytes: bytes) -> Any:
    try:
        return json.loads(body_bytes)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return None


def _request_url(response: Response, request: Request) -> str:
    try:
        request_url = str(response.url)
    except RuntimeError:
        request_url = ""
    return request_url or str(request.url)


if TYPE_CHECKING:
    from ...client import x402Client, x402ClientConfig, x402ClientSync
    from ..x402_http_client import x402HTTPClient, x402HTTPClientSync


class PaymentError(Exception):
    """Base class for payment-related errors."""

    pass


class PaymentAlreadyAttemptedError(PaymentError):
    """Raised when payment has already been attempted for this request."""

    pass


class MissingRequestConfigError(PaymentError):
    """Raised when request configuration is missing."""

    pass


# ============================================================================
# Transport Implementation (replaces event hooks which can't modify responses)
# ============================================================================


class x402AsyncTransport(AsyncBaseTransport):
    """Async transport that handles 402 Payment Required responses.

    Wraps another transport to intercept 402 responses, create payment
    payloads, and retry with payment headers automatically.

    Unlike event hooks, transports can control the response returned.
    """

    RETRY_KEY = _RETRY_KEY
    RECOVERY_KEY = _RECOVERY_KEY

    def __init__(
        self,
        client: x402Client | x402HTTPClient,
        transport: AsyncBaseTransport | None = None,
    ) -> None:
        """Initialize payment transport.

        Args:
            client: x402Client or x402HTTPClient for payment handling.
            transport: Optional underlying transport. If None, uses httpx default.
        """
        from ..x402_http_client import x402HTTPClient as HTTPClient

        if isinstance(client, HTTPClient):
            self._http_client = client
        else:
            self._http_client = HTTPClient(client)
        self._client = client
        self._transport = transport or httpx.AsyncHTTPTransport()

    async def _send_retry(
        self,
        request: Request,
        extra_headers: dict[str, str],
        *,
        payment_retry: bool = False,
        recovery_retry: bool = False,
    ) -> Response:
        retry_request = _retry_request(
            request,
            extra_headers,
            payment_retry=payment_retry,
            recovery_retry=recovery_retry,
        )
        return await self._transport.handle_async_request(retry_request)

    async def handle_async_request(self, request: Request) -> Response:
        """Handle request with automatic 402 payment retry.

        Args:
            request: The outgoing HTTP request.

        Returns:
            Response (original or retried with payment).
        """
        # A 402 response requires replaying the request with payment headers.
        # Buffer streaming bodies before the first send so retries preserve them.
        await request.aread()

        # Send the initial request
        response = await self._transport.handle_async_request(request)

        # Not a 402, return as-is
        if response.status_code != 402:
            return response

        # Check if already a retry (via request extensions)
        if _is_retry(request):
            return await _cap_returned_payment_required(response, request)

        try:
            # Read response body before parsing
            try:
                body_bytes = await aread_limited_body(response.aiter_bytes())
            finally:
                await response.aclose()

            # Parse PaymentRequired (try header first for V2, then body for V1)
            payment_required = self._http_client.get_payment_required_response(
                response.headers.get, _parse_json_body(body_bytes)
            )

            hook_headers = await self._http_client.handle_payment_required(
                payment_required, _request_url(response, request)
            )
            if hook_headers:
                hook_response = await self._send_retry(request, hook_headers)
                if hook_response.status_code != 402:
                    return hook_response
                try:
                    await aread_limited_body(hook_response.aiter_bytes())
                finally:
                    await hook_response.aclose()

            # Create payment payload
            payment_payload = await self._client.create_payment_payload(payment_required)

            # Encode payment headers
            payment_headers = self._http_client.encode_payment_signature_header(payment_payload)

            # Retry using same transport
            paid_response = await self._send_retry(request, payment_headers, payment_retry=True)

            process_result = await self._http_client.process_payment_result(
                payment_payload,
                paid_response.headers.get,
                paid_response.status_code,
            )

            if process_result.recovered:
                try:
                    if paid_response.status_code == 402:
                        await aread_limited_body(paid_response.aiter_bytes())
                finally:
                    await paid_response.aclose()
                # Retry once with a fresh payload after recovery
                fresh_payload = await self._client.create_payment_payload(payment_required)
                fresh_headers = self._http_client.encode_payment_signature_header(fresh_payload)
                recovery_response = await self._send_retry(
                    request, fresh_headers, recovery_retry=True
                )
                # Fire hooks on retry response — no further recovery
                await self._http_client.process_payment_result(
                    fresh_payload,
                    recovery_response.headers.get,
                    recovery_response.status_code,
                )
                return await _cap_returned_payment_required(recovery_response, request)

            return await _cap_returned_payment_required(paid_response, request)

        except PaymentError:
            raise
        except ResponseBodyTooLargeError:
            raise
        except Exception as e:
            raise PaymentError(f"Failed to handle payment: {e}") from e

    async def aclose(self) -> None:
        """Close the underlying transport."""
        await self._transport.aclose()


class x402SyncTransport(BaseTransport):
    """Sync transport that handles 402 Payment Required responses.

    The ``httpx.Client`` counterpart of ``x402AsyncTransport``, for code that
    is built on a sync ``httpx.Client`` (including SDKs that accept a custom
    ``http_client``). Pair it with ``x402ClientSync``.

    Example:
        ```python
        import httpx
        from x402 import x402ClientSync
        from x402.http.clients import x402SyncTransport

        client = x402ClientSync()
        # ... register schemes ...

        with httpx.Client(transport=x402SyncTransport(client)) as http:
            response = http.get("https://api.example.com/paid")
        ```
    """

    RETRY_KEY = _RETRY_KEY
    RECOVERY_KEY = _RECOVERY_KEY

    def __init__(
        self,
        client: x402ClientSync | x402HTTPClientSync,
        transport: BaseTransport | None = None,
    ) -> None:
        """Initialize payment transport.

        Args:
            client: x402ClientSync or x402HTTPClientSync for payment handling.
            transport: Optional underlying transport. If None, uses httpx default.

        Raises:
            TypeError: If client has async methods (wrong variant).
        """
        import inspect

        create_method = getattr(client, "create_payment_payload", None)
        if create_method and inspect.iscoroutinefunction(create_method):
            raise TypeError(
                f"x402SyncTransport requires a sync client, "
                f"but got {type(client).__name__} which has async methods. "
                f"Use x402ClientSync instead of x402Client, "
                f"or use x402AsyncTransport with x402Client."
            )

        from ..x402_http_client import x402HTTPClientSync as HTTPClientSync

        if isinstance(client, HTTPClientSync):
            self._http_client = client
        else:
            self._http_client = HTTPClientSync(client)
        self._client = client
        self._transport = transport or httpx.HTTPTransport()

    def _send_retry(
        self,
        request: Request,
        extra_headers: dict[str, str],
        *,
        payment_retry: bool = False,
        recovery_retry: bool = False,
    ) -> Response:
        retry_request = _retry_request(
            request,
            extra_headers,
            payment_retry=payment_retry,
            recovery_retry=recovery_retry,
        )
        return self._transport.handle_request(retry_request)

    def handle_request(self, request: Request) -> Response:
        """Handle request with automatic 402 payment retry.

        Args:
            request: The outgoing HTTP request.

        Returns:
            Response (original or retried with payment).
        """
        # Buffer streaming bodies before the first send so retries preserve them.
        request.read()

        response = self._transport.handle_request(request)

        if response.status_code != 402:
            return response

        if _is_retry(request):
            return _cap_returned_payment_required_sync(response, request)

        try:
            try:
                body_bytes = read_limited_body(response.iter_bytes())
            finally:
                response.close()

            payment_required = self._http_client.get_payment_required_response(
                response.headers.get, _parse_json_body(body_bytes)
            )

            hook_headers = self._http_client.handle_payment_required(
                payment_required, _request_url(response, request)
            )
            if hook_headers:
                hook_response = self._send_retry(request, hook_headers)
                if hook_response.status_code != 402:
                    return hook_response
                try:
                    read_limited_body(hook_response.iter_bytes())
                finally:
                    hook_response.close()

            payment_payload = self._client.create_payment_payload(payment_required)
            payment_headers = self._http_client.encode_payment_signature_header(payment_payload)
            paid_response = self._send_retry(request, payment_headers, payment_retry=True)

            process_result = self._http_client.process_payment_result(
                payment_payload,
                paid_response.headers.get,
                paid_response.status_code,
            )

            if process_result.recovered:
                try:
                    if paid_response.status_code == 402:
                        read_limited_body(paid_response.iter_bytes())
                finally:
                    paid_response.close()
                # Retry once with a fresh payload after recovery
                fresh_payload = self._client.create_payment_payload(payment_required)
                fresh_headers = self._http_client.encode_payment_signature_header(fresh_payload)
                recovery_response = self._send_retry(request, fresh_headers, recovery_retry=True)
                # Fire hooks on retry response — no further recovery
                self._http_client.process_payment_result(
                    fresh_payload,
                    recovery_response.headers.get,
                    recovery_response.status_code,
                )
                return _cap_returned_payment_required_sync(recovery_response, request)

            return _cap_returned_payment_required_sync(paid_response, request)

        except PaymentError:
            raise
        except ResponseBodyTooLargeError:
            raise
        except Exception as e:
            raise PaymentError(f"Failed to handle payment: {e}") from e

    def close(self) -> None:
        """Close the underlying transport."""
        self._transport.close()


def x402_httpx_transport(
    client: x402Client | x402HTTPClient,
    transport: AsyncBaseTransport | None = None,
) -> x402AsyncTransport:
    """Create an httpx transport with 402 payment handling.

    Args:
        client: x402Client or x402HTTPClient for payment handling.
        transport: Optional underlying transport. If None, uses httpx default.

    Returns:
        Transport that handles 402 responses with automatic payment retry.

    Example:
        ```python
        from x402 import x402Client
        from x402.http.clients import x402_httpx_transport
        import httpx

        client = x402Client()
        # ... register schemes ...

        async with httpx.AsyncClient(
            transport=x402_httpx_transport(client)
        ) as http:
            response = await http.get("https://api.example.com/paid")
        ```
    """
    return x402AsyncTransport(client, transport)


# Legacy alias for backwards compatibility (event hooks don't work correctly)
def x402_httpx_hooks(
    client: x402Client | x402HTTPClient,
) -> dict[str, list[Callable[..., Any]]]:
    """DEPRECATED: Event hooks cannot modify responses in httpx.

    Use x402_httpx_transport() instead, or x402HttpxClient class.

    This function is kept for API compatibility but logs a warning.
    """
    import warnings

    warnings.warn(
        "x402_httpx_hooks is deprecated because httpx event hooks cannot modify "
        "responses. Use x402_httpx_transport() or x402HttpxClient instead.",
        DeprecationWarning,
        stacklevel=2,
    )

    # Return empty hooks - the transport approach should be used
    return {"request": [], "response": []}


# ============================================================================
# Wrapper Functions
# ============================================================================


def wrapHttpxWithPayment(
    x402_client: x402Client | x402HTTPClient,
    **httpx_kwargs: Any,
) -> httpx.AsyncClient:
    """Create an httpx AsyncClient with automatic 402 payment handling.

    Creates a new client with payment transport configured.

    Note: Unlike the old API, this creates a new client rather than
    wrapping an existing one, because httpx doesn't allow replacing
    the transport of an existing client.

    Args:
        x402_client: x402Client or x402HTTPClient for payments.
        **httpx_kwargs: Additional arguments for httpx.AsyncClient.

    Returns:
        New AsyncClient with payment handling configured.

    Example:
        ```python
        import httpx
        from x402 import x402Client
        from x402.http.clients import wrapHttpxWithPayment

        x402 = x402Client()
        # ... register schemes ...

        async with wrapHttpxWithPayment(x402) as client:
            response = await client.get("https://api.example.com/paid")
        ```
    """
    transport = x402AsyncTransport(x402_client)
    return httpx.AsyncClient(transport=transport, **httpx_kwargs)


def wrapHttpxWithPaymentFromConfig(
    config: x402ClientConfig,
    **httpx_kwargs: Any,
) -> httpx.AsyncClient:
    """Create httpx client with payment handling using configuration.

    Creates a new x402Client from the configuration and wraps it
    in an httpx AsyncClient with automatic 402 payment handling.

    Args:
        config: x402ClientConfig with schemes, policies, and selector.
        **httpx_kwargs: Additional arguments for httpx.AsyncClient.

    Returns:
        New AsyncClient with payment handling configured.

    Example:
        ```python
        import httpx
        from x402 import x402ClientConfig, SchemeRegistration
        from x402.http.clients import wrapHttpxWithPaymentFromConfig
        from x402.mechanisms.evm.exact import ExactEvmScheme

        config = x402ClientConfig(
            schemes=[
                SchemeRegistration(
                    network="eip155:8453",
                    client=ExactEvmScheme(signer=my_signer),
                ),
            ],
        )

        async with wrapHttpxWithPaymentFromConfig(config) as client:
            response = await client.get("https://api.example.com/paid")
        ```
    """
    from ...client import x402Client as Client

    client = Client.from_config(config)
    return wrapHttpxWithPayment(client, **httpx_kwargs)


# ============================================================================
# Convenience Class (like legacy Python)
# ============================================================================


class x402HttpxClient(httpx.AsyncClient):
    """AsyncClient with built-in x402 payment handling.

    Convenience class that wraps httpx.AsyncClient with automatic
    402 payment handling using a custom transport.

    Example:
        ```python
        from x402 import x402Client
        from x402.http.clients import x402HttpxClient

        x402 = x402Client()
        # ... register schemes ...

        async with x402HttpxClient(x402) as client:
            response = await client.get("https://api.example.com/paid")
        ```
    """

    def __init__(
        self,
        x402_client: x402Client | x402HTTPClient,
        **kwargs: Any,
    ) -> None:
        """Initialize payment-enabled httpx client.

        Args:
            x402_client: x402Client or x402HTTPClient for payments.
            **kwargs: Additional arguments for httpx.AsyncClient.
        """
        # Create payment transport
        transport = x402AsyncTransport(x402_client)
        super().__init__(transport=transport, **kwargs)
