"""Client-side utilities for the Payment-Identifier Extension."""

from __future__ import annotations

from typing import Any

from .types import PAYMENT_IDENTIFIER, PaymentIdentifierExtension
from .utils import generate_payment_id, is_valid_payment_id
from .validation import is_payment_identifier_extension


def append_payment_identifier_to_extensions(
    extensions: dict[str, Any], id: str | None = None
) -> dict[str, Any]:
    """Append a payment identifier to the extensions object if the server declared support.

    This function reads the server's `payment-identifier` declaration from the extensions,
    and appends the client's ID to it. If the extension is not present (server didn't declare it),
    the extensions are returned unchanged.

    Args:
        extensions: The extensions object from PaymentRequired (will be modified in place).
        id: Optional custom payment ID. If not provided, a new ID will be generated.

    Returns:
        The modified extensions object (same reference as input).

    Raises:
        ValueError: If the provided ID is invalid.

    Example:
        ```python
        from x402.extensions.payment_identifier import append_payment_identifier_to_extensions

        # Get extensions from server's PaymentRequired response
        extensions = {...payment_required.extensions}

        # Append a generated ID (only if server declared payment-identifier)
        append_payment_identifier_to_extensions(extensions)

        # Or use a custom ID
        append_payment_identifier_to_extensions(extensions, "pay_my_custom_id_12345")

        # Include in PaymentPayload
        payment_payload = {
            "x402Version": 2,
            "resource": payment_required.resource,
            "accepted": selected_payment_option,
            "payload": {...},
            "extensions": extensions
        }
        ```
    """
    extension = extensions.get(PAYMENT_IDENTIFIER)

    # Only append if the server declared this extension with valid structure
    if not is_payment_identifier_extension(extension):
        return extensions

    payment_id = id if id is not None else generate_payment_id()

    if not is_valid_payment_id(payment_id):
        raise ValueError(
            f'Invalid payment ID: "{payment_id}". '
            "ID must be 16-128 characters and contain only alphanumeric characters, hyphens, and underscores."
        )

    # Convert extension to dict if it's a Pydantic model
    if isinstance(extension, PaymentIdentifierExtension):
        ext_dict = extension.model_dump(by_alias=True)
    else:
        ext_dict = dict(extension)

    # Get or create info section
    info = ext_dict.get("info", {})
    if isinstance(info, dict):
        info_dict = dict(info)
    else:
        # If it's a Pydantic model, convert to dict
        if hasattr(info, "model_dump"):
            info_dict = info.model_dump(by_alias=True)
        else:
            info_dict = {}

    # Append the ID to the existing extension info
    info_dict["id"] = payment_id
    ext_dict["info"] = info_dict
    extensions[PAYMENT_IDENTIFIER] = ext_dict

    return extensions
