"""Version-agnostic protocol definitions for the x402 Python SDK.

These Protocol classes allow hooks and policies to work with both V1 and V2 types.
"""

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class PaymentRequirementsView(Protocol):
    """Unified interface for V1 and V2 payment requirements.

    This protocol allows code to work with both PaymentRequirements (V2)
    and PaymentRequirementsV1 (V1) interchangeably.
    """

    @property
    def scheme(self) -> str:
        """Payment scheme identifier."""
        ...

    @property
    def network(self) -> str:
        """Network identifier."""
        ...

    @property
    def asset(self) -> str:
        """Asset address/identifier."""
        ...

    @property
    def pay_to(self) -> str:
        """Recipient address."""
        ...

    @property
    def max_timeout_seconds(self) -> int:
        """Maximum time for payment validity."""
        ...

    def get_amount(self) -> str:
        """Get the payment amount.

        Returns:
            V1: maxAmountRequired
            V2: amount
        """
        ...

    def get_extra(self) -> dict[str, Any] | None:
        """Get extra metadata."""
        ...


@runtime_checkable
class PaymentPayloadView(Protocol):
    """Unified interface for V1 and V2 payment payloads.

    This protocol allows code to work with both PaymentPayload (V2)
    and PaymentPayloadV1 (V1) interchangeably.
    """

    @property
    def x402_version(self) -> int:
        """Protocol version."""
        ...

    @property
    def payload(self) -> dict[str, Any]:
        """Scheme-specific payload data."""
        ...

    def get_scheme(self) -> str:
        """Get the payment scheme.

        Returns:
            V1: top-level scheme
            V2: accepted.scheme
        """
        ...

    def get_network(self) -> str:
        """Get the network.

        Returns:
            V1: top-level network
            V2: accepted.network
        """
        ...
