"""requests library wrapper with automatic x402 payment handling.

Provides HTTPAdapter and convenience functions for sync requests.Session.
"""

from __future__ import annotations

import copy
import json
from typing import TYPE_CHECKING, Any

try:
    import requests
    from requests.adapters import HTTPAdapter
except ImportError as e:
    raise ImportError(
        "requests client requires the requests package. Install with: uv add x402[requests]"
    ) from e

if TYPE_CHECKING:
    from ...client import x402ClientConfig, x402ClientSync
    from ..x402_http_client import x402HTTPClientSync


class PaymentError(Exception):
    """Base class for payment-related errors."""

    pass


class PaymentAlreadyAttemptedError(PaymentError):
    """Raised when payment has already been attempted."""

    pass


# ============================================================================
# HTTP Adapter Implementation
# ============================================================================


class x402HTTPAdapter(HTTPAdapter):
    """HTTP adapter that handles 402 Payment Required responses.

    Subclasses requests.HTTPAdapter to intercept 402 responses,
    create payment payloads, and retry with payment headers.

    Note: Uses synchronous payment creation with x402ClientSync.
    """

    RETRY_HEADER = "Payment-Retry"
    RECOVERY_HEADER = "Payment-Recovery"

    def __init__(
        self,
        client: x402ClientSync | x402HTTPClientSync,
        **kwargs: Any,
    ) -> None:
        """Initialize payment adapter.

        Args:
            client: x402ClientSync or x402HTTPClientSync for payments.
            **kwargs: Additional arguments for HTTPAdapter.

        Raises:
            TypeError: If client has async methods (wrong variant).
        """
        super().__init__(**kwargs)

        # Runtime validation - catch mismatched sync/async early
        import inspect

        create_method = getattr(client, "create_payment_payload", None)
        if create_method and inspect.iscoroutinefunction(create_method):
            raise TypeError(
                f"x402HTTPAdapter (requests) requires a sync client, "
                f"but got {type(client).__name__} which has async methods. "
                f"Use x402ClientSync instead of x402Client, "
                f"or use x402AsyncTransport (httpx) with x402Client."
            )

        from ..x402_http_client import x402HTTPClientSync as HTTPClientSync

        if isinstance(client, HTTPClientSync):
            self._http_client = client
        else:
            self._http_client = HTTPClientSync(client)

        self._client = client

    def send(
        self,
        request: requests.PreparedRequest,
        **kwargs: Any,
    ) -> requests.Response:
        """Send request with automatic 402 payment handling.

        Args:
            request: The prepared request.
            **kwargs: Additional send arguments.

        Returns:
            Response (original or retried with payment).

        Raises:
            PaymentError: If payment handling fails.
        """
        # Check if this is already a retry (per-request state via header)
        is_retry = request.headers.get(self.RETRY_HEADER) == "1"
        is_recovery = request.headers.get(self.RECOVERY_HEADER) == "1"

        # Make initial request
        response = super().send(request, **kwargs)

        # Not a 402, return as-is
        if response.status_code != 402:
            return response

        # Already retried with payment, return the 402
        if is_retry or is_recovery:
            return response

        try:
            # Save content before parsing (avoid consuming stream)
            content = copy.deepcopy(response.content)

            # Parse PaymentRequired (try header first for V2, then body for V1)
            def get_header(name: str) -> str | None:
                return response.headers.get(name)

            body = None
            try:
                body = json.loads(content.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                pass

            payment_required = self._http_client.get_payment_required_response(get_header, body)

            hook_headers = self._http_client.handle_payment_required(payment_required)
            if hook_headers:
                hook_request = request.copy()
                hook_request.headers.update(hook_headers)
                hook_response = super().send(hook_request, **kwargs)
                if hook_response.status_code != 402:
                    return hook_response

            # Create payment payload (sync)
            payment_payload = self._client.create_payment_payload(payment_required)

            # Encode payment headers
            payment_headers = self._http_client.encode_payment_signature_header(payment_payload)

            # Create a copy of the request for retry (don't modify original)
            paid_request = request.copy()
            paid_request.headers.update(payment_headers)
            paid_request.headers["Access-Control-Expose-Headers"] = (
                "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE"
            )
            paid_request.headers[self.RETRY_HEADER] = "1"

            # Retry request with payment
            paid_response = super().send(paid_request, **kwargs)

            process_result = self._http_client.process_payment_result(
                payment_payload,
                paid_response.headers.get,
                paid_response.status_code,
            )

            if process_result.recovered:
                # Retry once with a fresh payload after recovery
                fresh_payload = self._client.create_payment_payload(payment_required)
                fresh_headers = self._http_client.encode_payment_signature_header(fresh_payload)
                recovery_request = request.copy()
                recovery_request.headers.update(fresh_headers)
                recovery_request.headers["Access-Control-Expose-Headers"] = (
                    "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE"
                )
                recovery_request.headers[self.RECOVERY_HEADER] = "1"
                recovery_response = super().send(recovery_request, **kwargs)
                # Fire hooks on retry response — no further recovery
                self._http_client.process_payment_result(
                    fresh_payload,
                    recovery_response.headers.get,
                    recovery_response.status_code,
                )
                return recovery_response

            return paid_response

        except PaymentError:
            raise
        except Exception as e:
            raise PaymentError(f"Failed to handle payment: {e}") from e


def x402_http_adapter(
    client: x402ClientSync | x402HTTPClientSync,
    **kwargs: Any,
) -> x402HTTPAdapter:
    """Create an HTTP adapter with 402 payment handling.

    Args:
        client: x402ClientSync or x402HTTPClientSync for payments.
        **kwargs: Additional arguments for HTTPAdapter.

    Returns:
        x402HTTPAdapter that can be mounted to a session.

    Example:
        ```python
        import requests
        from x402 import x402ClientSync
        from x402.http.clients import x402_http_adapter

        x402 = x402ClientSync()
        # ... register schemes ...

        session = requests.Session()
        adapter = x402_http_adapter(x402)
        session.mount("https://", adapter)
        session.mount("http://", adapter)

        response = session.get("https://api.example.com/paid")
        ```
    """
    return x402HTTPAdapter(client, **kwargs)


# ============================================================================
# Wrapper Functions
# ============================================================================


def wrapRequestsWithPayment(
    session: requests.Session,
    client: x402ClientSync | x402HTTPClientSync,
    **adapter_kwargs: Any,
) -> requests.Session:
    """Wrap a requests Session with automatic 402 payment handling.

    Mounts a payment-aware adapter for both HTTP and HTTPS.

    Args:
        session: requests Session to wrap.
        client: x402ClientSync or x402HTTPClientSync for payments.
        **adapter_kwargs: Additional arguments for the adapter.

    Returns:
        The same session with payment adapter mounted.

    Example:
        ```python
        import requests
        from x402 import x402ClientSync
        from x402.http.clients import wrapRequestsWithPayment

        x402 = x402ClientSync()
        # ... register schemes ...

        session = wrapRequestsWithPayment(requests.Session(), x402)
        response = session.get("https://api.example.com/paid")
        ```
    """
    adapter = x402HTTPAdapter(client, **adapter_kwargs)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def wrapRequestsWithPaymentFromConfig(
    session: requests.Session,
    config: x402ClientConfig,
    **adapter_kwargs: Any,
) -> requests.Session:
    """Wrap requests session with payment handling using configuration.

    Creates a new x402ClientSync from the configuration and wraps the
    session with automatic 402 payment handling.

    Args:
        session: requests Session to wrap.
        config: x402ClientConfig with schemes, policies, and selector.
        **adapter_kwargs: Additional arguments for the adapter.

    Returns:
        The same session with payment adapter mounted.

    Example:
        ```python
        import requests
        from x402 import x402ClientConfig, SchemeRegistration
        from x402.http.clients import wrapRequestsWithPaymentFromConfig
        from x402.mechanisms.evm.exact import ExactEvmScheme

        config = x402ClientConfig(
            schemes=[
                SchemeRegistration(
                    network="eip155:8453",
                    client=ExactEvmScheme(signer=my_signer),
                ),
            ],
        )

        session = wrapRequestsWithPaymentFromConfig(requests.Session(), config)
        response = session.get("https://api.example.com/paid")
        ```
    """
    from ...client import x402ClientSync as ClientSync

    client = ClientSync.from_config(config)
    return wrapRequestsWithPayment(session, client, **adapter_kwargs)


# ============================================================================
# Convenience Function (like legacy Python)
# ============================================================================


def x402_requests(
    client: x402ClientSync | x402HTTPClientSync,
    **adapter_kwargs: Any,
) -> requests.Session:
    """Create a requests Session with x402 payment handling.

    Convenience function that creates a new session with payment
    handling pre-configured.

    Args:
        client: x402ClientSync or x402HTTPClientSync for payments.
        **adapter_kwargs: Additional arguments for the adapter.

    Returns:
        New session with payment handling configured.

    Example:
        ```python
        from x402 import x402ClientSync
        from x402.http.clients import x402_requests

        x402 = x402ClientSync()
        # ... register schemes ...

        session = x402_requests(x402)
        response = session.get("https://api.example.com/paid")
        ```
    """
    session = requests.Session()
    return wrapRequestsWithPayment(session, client, **adapter_kwargs)
