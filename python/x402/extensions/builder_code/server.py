"""Resource Server utilities for the Builder Code Extension."""

from __future__ import annotations

from typing import Any

from .types import (
    BUILDER_CODE,
    BUILDER_CODE_PATTERN,
    MAX_SERVER_SERVICE_CODES,
    MAX_SERVICE_CODES,
)

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
            "maxItems": MAX_SERVICE_CODES,
            "items": {
                "type": "string",
                "pattern": "^[a-z0-9_]{1,32}$",
            },
            "description": "Service builder codes",
        },
    },
    "additionalProperties": False,
}


def declare_builder_code_extension(
    app_code: str, service_codes: str | list[str] | None = None
) -> dict[str, Any]:
    """Declare the builder-code extension for inclusion in PaymentRequired.extensions.

    Args:
        app_code: The service's builder code (e.g. ``"bc_weather_svc"``).
        service_codes: Optional service code(s) (e.g. attribution for a
            server-side SDK the service depends on). Client-provided service
            codes are merged with these by the core client, client entries first.

    Returns:
        Extension declaration with ``info`` and ``schema`` keyed under BUILDER_CODE.

    Raises:
        ValueError: If ``app_code`` or any service code is not a valid builder
            code, or if more than ``MAX_SERVER_SERVICE_CODES`` are given.
    """
    if not BUILDER_CODE_PATTERN.match(app_code):
        raise ValueError(
            f'Invalid builder code: "{app_code}". '
            "Must be 1-32 characters, lowercase alphanumeric and underscores only."
        )

    info: dict[str, Any] = {"a": app_code}
    if service_codes is not None:
        codes = [service_codes] if isinstance(service_codes, str) else list(service_codes)
        if len(codes) > MAX_SERVER_SERVICE_CODES:
            raise ValueError(
                f"Too many service codes: {len(codes)} exceeds the maximum of "
                f"{MAX_SERVER_SERVICE_CODES}."
            )
        for code in codes:
            if not BUILDER_CODE_PATTERN.match(code):
                raise ValueError(
                    f'Invalid builder code: "{code}". '
                    "Must be 1-32 characters, lowercase alphanumeric and underscores only."
                )
        if codes:
            info["s"] = codes

    return {
        "info": info,
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
