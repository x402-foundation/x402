"""HTTP middleware for x402 payment handling.

Provides server-side middleware for FastAPI and Flask that
protects endpoints with x402 payment requirements.

Note: Import specific middleware modules directly to avoid
requiring all framework dependencies:

    from x402.http.middleware.fastapi import payment_middleware
    from x402.http.middleware.flask import PaymentMiddleware
"""

# Lazy imports - only import when the module is accessed to avoid
# requiring all framework dependencies

__all__ = [
    # FastAPI
    "FastAPIAdapter",
    "PaymentMiddlewareASGI",
    "fastapi_payment_middleware",
    "fastapi_payment_middleware_from_config",
    # Flask
    "FlaskAdapter",
    "FlaskPaymentMiddleware",
    "ResponseWrapper",
    "flask_payment_middleware",
    "flask_payment_middleware_from_config",
]


def __getattr__(name: str):
    """Lazy import to avoid requiring all framework dependencies."""
    # FastAPI imports
    if name in (
        "FastAPIAdapter",
        "PaymentMiddlewareASGI",
        "fastapi_payment_middleware",
        "fastapi_payment_middleware_from_config",
    ):
        from . import fastapi as _fastapi

        if name == "FastAPIAdapter":
            return _fastapi.FastAPIAdapter
        elif name == "PaymentMiddlewareASGI":
            return _fastapi.PaymentMiddlewareASGI
        elif name == "fastapi_payment_middleware":
            return _fastapi.payment_middleware
        elif name == "fastapi_payment_middleware_from_config":
            return _fastapi.payment_middleware_from_config

    # Flask imports
    if name in (
        "FlaskAdapter",
        "FlaskPaymentMiddleware",
        "ResponseWrapper",
        "flask_payment_middleware",
        "flask_payment_middleware_from_config",
    ):
        from . import flask as _flask

        if name == "FlaskAdapter":
            return _flask.FlaskAdapter
        elif name == "FlaskPaymentMiddleware":
            return _flask.PaymentMiddleware
        elif name == "ResponseWrapper":
            return _flask.ResponseWrapper
        elif name == "flask_payment_middleware":
            return _flask.payment_middleware
        elif name == "flask_payment_middleware_from_config":
            return _flask.payment_middleware_from_config

    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
