"""Utility functions for the Payment-Identifier Extension."""

from __future__ import annotations

import uuid

from .types import PAYMENT_ID_MAX_LENGTH, PAYMENT_ID_MIN_LENGTH, PAYMENT_ID_PATTERN


def generate_payment_id(prefix: str = "pay_") -> str:
    """Generate a unique payment identifier.

    Args:
        prefix: Optional prefix for the ID (e.g., "pay_"). Defaults to "pay_".

    Returns:
        A unique payment identifier string.

    Example:
        ```python
        # With default prefix
        id = generate_payment_id()  # "pay_7d5d747be160e280504c099d984bcfe0"

        # With custom prefix
        id = generate_payment_id("txn_")  # "txn_7d5d747be160e280504c099d984bcfe0"

        # Without prefix
        id = generate_payment_id("")  # "7d5d747be160e280504c099d984bcfe0"
        ```
    """
    # Generate UUID v4 without hyphens (32 hex chars)
    uuid_str = uuid.uuid4().hex
    return f"{prefix}{uuid_str}"


def is_valid_payment_id(id: str) -> bool:
    """Validate that a payment ID meets the format requirements.

    Args:
        id: The payment ID to validate.

    Returns:
        True if the ID is valid, False otherwise.

    Example:
        ```python
        is_valid_payment_id("pay_7d5d747be160e280")  # True (exactly 16 chars after prefix removal check)
        is_valid_payment_id("abc")  # False (too short)
        is_valid_payment_id("pay_abc!@#")  # False (invalid characters)
        ```
    """
    if not isinstance(id, str):
        return False

    if len(id) < PAYMENT_ID_MIN_LENGTH or len(id) > PAYMENT_ID_MAX_LENGTH:
        return False

    return bool(PAYMENT_ID_PATTERN.match(id))
