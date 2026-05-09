"""Configuration types for the x402 Python SDK."""

from collections.abc import Callable
from typing import Any, TypeAlias, TypedDict

from .base import BaseX402Model, Network, Price


class ResourceConfig(BaseX402Model):
    """Configuration for a protected resource.

    Attributes:
        scheme: Payment scheme identifier (e.g., "exact").
        pay_to: Recipient address.
        price: Price for the resource.
        network: CAIP-2 network identifier.
        max_timeout_seconds: Maximum time for payment validity.
    """

    scheme: str
    pay_to: str
    price: Price
    network: Network
    max_timeout_seconds: int | None = None
    extra: dict[str, Any] | None = None


class FacilitatorConfig(TypedDict, total=False):
    """Configuration for facilitator client (sync).

    Attributes:
        url: Facilitator service URL.
        create_headers: Function to create auth headers.
    """

    url: str
    create_headers: Callable[[], dict[str, str]]


class PaywallConfig(TypedDict, total=False):
    """Configuration for paywall UI customization.

    Attributes:
        app_name: Application name to display.
        app_logo: URL to application logo.
    """

    app_name: str
    app_logo: str


class RouteConfigDict(TypedDict, total=False):
    """Route configuration dictionary.

    Attributes:
        accepts: List of payment options.
        extensions: Optional extension data.
    """

    accepts: list[dict[str, Any]]
    extensions: dict[str, Any]


# Single route or dict of path -> route config
RoutesConfig: TypeAlias = RouteConfigDict | dict[str, RouteConfigDict]
