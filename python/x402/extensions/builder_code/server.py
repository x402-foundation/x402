"""Resource Server utilities for the Builder Code Extension."""

from __future__ import annotations

from typing import Any

from .types import BUILDER_CODE, BUILDER_CODE_PATTERN

BUILDER_CODE_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
        "a": {
            "type": "string",
            "pattern": "^[a-z0-9_]{1,32}$",
            "description": "App builder code",
        },
        "w": {
            "type": "string",
            "pattern": "^[a-z0-9_]{1,32}$",
            "description": "Wallet builder code",
        },
        "s": {
            "type": "array",
            "maxItems": 5,
            "items": {
                "type": "string",
                "pattern": "^[a-z0-9_]{1,32}$",
            },
            "description": "Service builder codes",
        },
    },
    "additionalProperties": False,
}


def declare_builder_code_extension(app_code: str) -> dict[str, Any]:
    """Declare the builder-code extension for inclusion in PaymentRequired.extensions.

    Args:
        app_code: The service's builder code (e.g. ``"bc_weather_svc"``).

    Returns:
        Extension declaration with ``info`` and ``schema`` keyed under BUILDER_CODE.

    Raises:
        ValueError: If ``app_code`` is not a valid builder code.
    """
    if not BUILDER_CODE_PATTERN.match(app_code):
        raise ValueError(
            f'Invalid builder code: "{app_code}". '
            "Must be 1-32 characters, lowercase alphanumeric and underscores only."
        )

    return {
        "info": {"a": app_code},
        "schema": BUILDER_CODE_SCHEMA,
    }


class BuilderCodeResourceServerExtension:
    """ResourceServerExtension implementation for builder-code.

    The declaration is static, so no enrichment is needed. Provided for consistency
    with other extensions and for use with the extension registration system.
    """

    @property
    def key(self) -> str:
        """Extension key."""
        return BUILDER_CODE

    def enrich_declaration(
        self,
        declaration: Any,
        transport_context: Any,
    ) -> Any:
        """Return the declaration unchanged (no enrichment needed)."""
        return declaration


# Singleton instance for convenience
builder_code_resource_server_extension = BuilderCodeResourceServerExtension()
