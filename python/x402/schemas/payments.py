"""V2 payment types for the x402 Python SDK."""

from typing import Any

from pydantic import Field

from .base import BaseX402Model, Network


class ResourceInfo(BaseX402Model):
    """Describes the resource being accessed.

    Attributes:
        url: The URL of the resource.
        description: Optional human-readable description.
        mime_type: Optional MIME type of the resource.
        service_name: Optional human-readable service name (≤ 32 chars).
        tags: Optional topical tags for the service (≤ 5 entries, each ≤ 32 chars).
        icon_url: Optional absolute http(s) URL to a service icon (≤ 2048 chars).

    See `specs/extensions/bazaar.md` "Service Metadata on `resource`" for
    facilitator-side validation rules applied to service_name / tags / icon_url.
    """

    url: str
    description: str | None = None
    mime_type: str | None = None
    service_name: str | None = None
    tags: list[str] | None = None
    icon_url: str | None = None


class PaymentRequirements(BaseX402Model):
    """V2 payment requirements structure.

    Attributes:
        scheme: Payment scheme identifier (e.g., "exact").
        network: CAIP-2 network identifier (e.g., "eip155:8453").
        asset: Asset address/identifier.
        amount: Amount in smallest unit.
        pay_to: Recipient address.
        max_timeout_seconds: Maximum time for payment validity.
        extra: Additional scheme-specific data.
    """

    scheme: str
    network: Network
    asset: str
    amount: str
    pay_to: str
    max_timeout_seconds: int
    extra: dict[str, Any] = Field(default_factory=dict)

    def get_amount(self) -> str:
        """Get the payment amount (V2 uses 'amount' field)."""
        return self.amount

    def get_extra(self) -> dict[str, Any] | None:
        """Get extra metadata."""
        return self.extra


class PaymentRequired(BaseX402Model):
    """V2 402 response structure.

    Attributes:
        x402_version: Protocol version (always 2 for V2).
        error: Optional error message.
        resource: Optional resource information.
        accepts: List of accepted payment requirements.
        extensions: Optional extension data.
    """

    x402_version: int = 2
    error: str | None = None
    resource: ResourceInfo | None = None
    accepts: list[PaymentRequirements]
    extensions: dict[str, Any] | None = None


class PaymentPayload(BaseX402Model):
    """V2 payment payload structure.

    Attributes:
        x402_version: Protocol version (always 2 for V2).
        payload: Scheme-specific payload data.
        accepted: The payment requirements being fulfilled.
        resource: Optional resource information.
        extensions: Optional extension data.
    """

    x402_version: int = 2
    payload: dict[str, Any]
    accepted: PaymentRequirements
    resource: ResourceInfo | None = None
    extensions: dict[str, Any] | None = None

    def get_scheme(self) -> str:
        """Get the payment scheme (V2 uses accepted.scheme)."""
        return self.accepted.scheme

    def get_network(self) -> str:
        """Get the network (V2 uses accepted.network)."""
        return self.accepted.network
