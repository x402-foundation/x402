"""HTTP client wrappers with automatic x402 payment handling.

Provides wrappers for httpx (async) and requests (sync) that
automatically handle 402 Payment Required responses.

Note: Import specific client modules directly to avoid
requiring all HTTP client dependencies:

    from x402.http.clients.httpx import x402HttpxClient
    from x402.http.clients.requests import x402_requests

Install the appropriate extra:
    uv add x402[httpx]     # For async httpx client
    uv add x402[requests]  # For sync requests client
"""

__all__ = [
    # Errors
    "PaymentError",
    "PaymentAlreadyAttemptedError",
    "MissingRequestConfigError",
    # httpx
    "x402AsyncTransport",
    "x402_httpx_transport",
    "wrapHttpxWithPayment",
    "wrapHttpxWithPaymentFromConfig",
    "x402_httpx_hooks",  # Deprecated
    "x402HttpxClient",
    # requests
    "x402HTTPAdapter",
    "wrapRequestsWithPayment",
    "wrapRequestsWithPaymentFromConfig",
    "x402_http_adapter",
    "x402_requests",
]


def __getattr__(name: str):
    """Lazy import to avoid requiring all HTTP client dependencies."""
    # httpx imports
    if name in (
        "PaymentError",
        "PaymentAlreadyAttemptedError",
        "MissingRequestConfigError",
        "x402AsyncTransport",
        "x402_httpx_transport",
        "wrapHttpxWithPayment",
        "wrapHttpxWithPaymentFromConfig",
        "x402_httpx_hooks",
        "x402HttpxClient",
    ):
        from . import httpx as _httpx

        return getattr(_httpx, name)

    # requests imports
    if name in (
        "x402HTTPAdapter",
        "wrapRequestsWithPayment",
        "wrapRequestsWithPaymentFromConfig",
        "x402_http_adapter",
        "x402_requests",
    ):
        from . import requests as _requests

        return getattr(_requests, name)

    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
