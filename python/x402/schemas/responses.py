"""Facilitator response types for the x402 Python SDK."""

from typing import Any

from pydantic import Field

from .base import BaseX402Model, Network
from .payments import PaymentPayload, PaymentRequirements


class VerifyRequest(BaseX402Model):
    """Request to verify a payment.

    Attributes:
        x402_version: Protocol version (1 or 2).
        payment_payload: The payment payload to verify.
        payment_requirements: The requirements to verify against.
    """

    x402_version: int
    payment_payload: PaymentPayload
    payment_requirements: PaymentRequirements


class VerifyResponse(BaseX402Model):
    """Response from payment verification.

    Attributes:
        is_valid: Whether the payment is valid.
        invalid_reason: Reason for invalidity (if is_valid is False).
        invalid_message: Human-readable message for invalidity.
        payer: The payer's address.
    """

    is_valid: bool
    invalid_reason: str | None = None
    invalid_message: str | None = None
    payer: str | None = None


class SettleRequest(BaseX402Model):
    """Request to settle a payment.

    Attributes:
        x402_version: Protocol version (1 or 2).
        payment_payload: The payment payload to settle.
        payment_requirements: The requirements for settlement.
    """

    x402_version: int
    payment_payload: PaymentPayload
    payment_requirements: PaymentRequirements


class SettleResponse(BaseX402Model):
    """Response from payment settlement.

    Attributes:
        success: Whether settlement was successful.
        error_reason: Reason for failure (if success is False).
        error_message: Human-readable message for failure.
        payer: The payer's address.
        transaction: Transaction hash/identifier.
        network: Network where settlement occurred.
    """

    success: bool
    error_reason: str | None = None
    error_message: str | None = None
    payer: str | None = None
    transaction: str
    network: Network


class SupportedKind(BaseX402Model):
    """A supported payment configuration.

    Attributes:
        x402_version: Protocol version for this kind.
        scheme: Payment scheme identifier.
        network: CAIP-2 network identifier.
        extra: Additional scheme-specific data.
    """

    x402_version: int
    scheme: str
    network: Network
    extra: dict[str, Any] | None = None


class SupportedResponse(BaseX402Model):
    """Describes what payment kinds a facilitator supports.

    Attributes:
        kinds: List of supported payment kinds.
        extensions: List of supported extension keys.
        signers: Map of CAIP family to signer addresses.
    """

    kinds: list[SupportedKind]
    extensions: list[str] = Field(default_factory=list)
    signers: dict[str, list[str]] = Field(default_factory=dict)
