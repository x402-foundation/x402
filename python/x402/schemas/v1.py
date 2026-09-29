"""V1 legacy types for the x402 Python SDK."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

from .base import BaseX402Model, Network

if TYPE_CHECKING:
    from .responses import SupportedKind


class PaymentRequirementsV1(BaseX402Model):
    """V1 payment requirements (legacy).

    Attributes:
        scheme: Payment scheme identifier.
        network: Network identifier (legacy format, e.g., "base-sepolia").
        max_amount_required: Maximum amount in smallest unit.
        resource: Resource URL.
        description: Optional resource description.
        mime_type: Optional MIME type.
        pay_to: Recipient address.
        max_timeout_seconds: Maximum time for payment validity.
        asset: Asset address/identifier.
        output_schema: Optional output schema.
        extra: Additional scheme-specific data.
    """

    scheme: str
    network: Network
    max_amount_required: str
    resource: str
    description: str | None = None
    mime_type: str | None = None
    pay_to: str
    max_timeout_seconds: int
    asset: str
    output_schema: dict[str, Any] | None = None
    extra: dict[str, Any] | None = None

    def get_amount(self) -> str:
        """Get the payment amount (V1 uses 'maxAmountRequired' field)."""
        return self.max_amount_required

    def get_extra(self) -> dict[str, Any] | None:
        """Get extra metadata."""
        return self.extra


class PaymentRequiredV1(BaseX402Model):
    """V1 402 response (legacy).

    Attributes:
        x402_version: Protocol version (always 1 for V1).
        error: Optional error message.
        accepts: List of accepted payment requirements.
    """

    x402_version: Literal[1] = 1
    error: str | None = None
    accepts: list[PaymentRequirementsV1]


class PaymentPayloadV1(BaseX402Model):
    """V1 payment payload (legacy).

    Attributes:
        x402_version: Protocol version (always 1 for V1).
        scheme: Payment scheme identifier (at top level in V1).
        network: Network identifier (at top level in V1).
        payload: Scheme-specific payload data.
    """

    x402_version: Literal[1] = 1
    scheme: str
    network: Network
    payload: dict[str, Any]

    def get_scheme(self) -> str:
        """Get the payment scheme (V1 has it at top level)."""
        return self.scheme

    def get_network(self) -> str:
        """Get the network (V1 has it at top level)."""
        return self.network


class SupportedResponseV1(BaseX402Model):
    """V1 supported response (legacy - no extensions or signers).

    Attributes:
        kinds: List of supported payment kinds.
    """

    kinds: list[SupportedKind]
