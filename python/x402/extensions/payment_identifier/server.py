"""Resource Server utilities for the Payment-Identifier Extension."""

from __future__ import annotations

from typing import Any

from .schema import payment_identifier_schema
from .types import PAYMENT_IDENTIFIER


def declare_payment_identifier_extension(required: bool = False) -> dict[str, Any]:
    """Declare the payment-identifier extension for inclusion in PaymentRequired.extensions.

    Resource servers call this function to advertise support for payment identifiers.
    The declaration indicates whether a payment identifier is required and includes
    the schema that clients must follow.

    Args:
        required: Whether clients must provide a payment identifier. Defaults to False.

    Returns:
        A dictionary ready for PaymentRequired.extensions with the key PAYMENT_IDENTIFIER.

    Example:
        ```python
        from x402.extensions.payment_identifier import (
            declare_payment_identifier_extension,
            PAYMENT_IDENTIFIER,
        )

        # Include in PaymentRequired response (optional identifier)
        payment_required = {
            "x402Version": 2,
            "resource": {...},
            "accepts": [...],
            "extensions": {
                PAYMENT_IDENTIFIER: declare_payment_identifier_extension()
            }
        }

        # Require payment identifier
        payment_required_strict = {
            "x402Version": 2,
            "resource": {...},
            "accepts": [...],
            "extensions": {
                PAYMENT_IDENTIFIER: declare_payment_identifier_extension(required=True)
            }
        }
        ```
    """
    return {
        "info": {"required": required},
        "schema": payment_identifier_schema,
    }


class PaymentIdentifierResourceServerExtension:
    """ResourceServerExtension implementation for payment-identifier.

    This extension doesn't require any enrichment hooks since the declaration
    is static. It's provided for consistency with other extensions and for
    potential future use with the extension registration system.

    Example:
        ```python
        from x402 import x402ResourceServer
        from x402.extensions.payment_identifier import (
            payment_identifier_resource_server_extension,
        )

        server = x402ResourceServer(facilitator_client)
        server.register_extension(payment_identifier_resource_server_extension)
        ```
    """

    @property
    def key(self) -> str:
        """Extension key."""
        return PAYMENT_IDENTIFIER

    def enrich_declaration(
        self,
        declaration: Any,
        transport_context: Any,
    ) -> Any:
        """Enrich extension declaration with transport-specific data.

        For payment-identifier, no enrichment is needed since the declaration is static.

        Args:
            declaration: The extension declaration to enrich.
            transport_context: Framework-specific context (e.g., HTTP request).

        Returns:
            Unchanged declaration (no enrichment needed).
        """
        return declaration


# Singleton instance for convenience
payment_identifier_resource_server_extension = PaymentIdentifierResourceServerExtension()
