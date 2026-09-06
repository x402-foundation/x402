"""JSON Schema definitions for the Payment-Identifier Extension."""

from typing import Any

from .types import PAYMENT_ID_MAX_LENGTH, PAYMENT_ID_MIN_LENGTH

# JSON Schema for validating payment identifier info.
# Compliant with JSON Schema Draft 2020-12.
payment_identifier_schema: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
        "required": {
            "type": "boolean",
        },
        "id": {
            "type": "string",
            "minLength": PAYMENT_ID_MIN_LENGTH,
            "maxLength": PAYMENT_ID_MAX_LENGTH,
            "pattern": "^[a-zA-Z0-9_-]+$",
        },
    },
    "required": ["required"],
}
