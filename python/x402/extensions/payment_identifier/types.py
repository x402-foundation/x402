"""Type definitions for the Payment-Identifier Extension.

Enables clients to provide an idempotency key that resource servers
can use for deduplication of payment requests.
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, Field

# Extension identifier constant for the payment-identifier extension
PAYMENT_IDENTIFIER = "payment-identifier"

# Minimum length for payment identifier
PAYMENT_ID_MIN_LENGTH = 16

# Maximum length for payment identifier
PAYMENT_ID_MAX_LENGTH = 128

# Pattern for valid payment identifier characters (alphanumeric, hyphens, underscores)
PAYMENT_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")


class PaymentIdentifierInfo(BaseModel):
    """Payment identifier info containing the required flag and client-provided ID.

    Attributes:
        required: Whether the server requires clients to include a payment identifier.
            When true, clients must provide an `id` or receive a 400 Bad Request.
        id: Client-provided unique identifier for idempotency.
            Must be 16-128 characters, alphanumeric with hyphens and underscores allowed.
    """

    required: bool
    id: str | None = None

    model_config = {"extra": "allow"}


class PaymentIdentifierExtension(BaseModel):
    """Payment identifier extension with info and schema.

    Used both for server-side declarations (info without id) and
    client-side payloads (info with id).

    Attributes:
        info: The payment identifier info.
            Server declarations have required only, clients add the id.
        schema: JSON Schema validating the info structure.
    """

    info: PaymentIdentifierInfo
    schema_: dict[str, Any] = Field(alias="schema")

    model_config = {"extra": "allow", "populate_by_name": True}


# JSON Schema type for the payment-identifier extension
PaymentIdentifierSchema = dict[str, Any]
