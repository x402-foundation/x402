"""Facilitator functions for validating and extracting Bazaar discovery extensions.

These functions help facilitators validate extension data against schemas
and extract the discovery information for cataloging in the Bazaar.

Supports both v2 (extensions in PaymentRequired) and v1 (output_schema in PaymentRequirements).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from urllib.parse import unquote, urlparse, urlunparse

from .types import (
    BAZAAR,
    BodyDiscoveryInfo,
    BodyInput,
    DiscoveryExtension,
    DiscoveryInfo,
    QueryDiscoveryInfo,
    QueryInput,
    parse_discovery_extension,
)

try:
    import jsonschema
except ImportError as e:
    raise ImportError(
        "Extensions validation requires jsonschema. Install with: pip install x402[extensions]"
    ) from e

if TYPE_CHECKING:
    from x402.schemas import PaymentPayload, PaymentRequirements
    from x402.schemas.v1 import PaymentRequirementsV1

logger = logging.getLogger(__name__)


# Valid routeTemplate pattern: must start with "/", contain only safe URL path characters
# and :param identifiers. Expected format: "/users/:userId", "/weather/:country/:city".
_ROUTE_TEMPLATE_RE = re.compile(r"^/[a-zA-Z0-9_/:.\-~%]+$")


def _is_valid_route_template(value: str | None) -> bool:
    """Check whether a routeTemplate value is structurally valid.

    Expected format: ":param" segments using colon-prefixed identifiers
    (e.g. "/users/:userId", "/weather/:country/:city").

    The facilitator is a trust boundary: clients control the payment payload and can
    modify routeTemplate before submission. A malicious value could cause the facilitator
    to catalog the payment under an arbitrary URL (catalog poisoning).

    Enforces:
    - Must be a non-empty string starting with "/"
    - Must match the safe URL path character set (alphanumeric, _, :, /, ., -, ~, %)
    - Must not contain ".." (path traversal)
    - Must not contain "://" (URL injection)

    Args:
        value: The raw routeTemplate string from the client payload.

    Returns:
        True if the value is a valid routeTemplate, False otherwise.
    """
    if not value:
        return False
    if not _ROUTE_TEMPLATE_RE.match(value):
        return False
    # Decode percent-encoding before traversal checks so that %2e%2e is caught.
    decoded = unquote(value)
    if ".." in decoded:
        return False
    if "://" in decoded:
        return False
    return True


@dataclass
class ValidationResult:
    """Result of validating a discovery extension."""

    valid: bool
    errors: list[str] = field(default_factory=list)


@dataclass
class DiscoveredResource:
    """A discovered x402 resource with its metadata."""

    resource_url: str
    method: str
    x402_version: int
    discovery_info: DiscoveryInfo
    description: str | None = None
    mime_type: str | None = None
    route_template: str | None = None


@dataclass
class ValidationExtractResult:
    """Result of validating and extracting discovery info."""

    valid: bool
    info: DiscoveryInfo | None = None
    errors: list[str] = field(default_factory=list)


def validate_discovery_extension(extension: DiscoveryExtension) -> ValidationResult:
    """Validate a discovery extension's info against its schema.

    Args:
        extension: The discovery extension containing info and schema.

    Returns:
        ValidationResult indicating if the info matches the schema.

    Example:
        ```python
        extension = declare_discovery_extension(...)
        result = validate_discovery_extension(extension["bazaar"])

        if result.valid:
            print("Extension is valid")
        else:
            print("Validation errors:", result.errors)
        ```
    """
    try:
        # Get schema from extension
        if isinstance(extension, dict):
            schema = extension.get("schema", {})
            info = extension.get("info", {})
        else:
            schema = extension.schema_ if hasattr(extension, "schema_") else {}
            info = extension.info

        # Convert info to dict if it's a Pydantic model
        if hasattr(info, "model_dump"):
            info_dict = info.model_dump(by_alias=True, exclude_none=True)
        else:
            info_dict = info

        # Validate
        jsonschema.validate(instance=info_dict, schema=schema)
        return ValidationResult(valid=True)

    except jsonschema.ValidationError as e:
        path = "/".join(str(p) for p in e.absolute_path) if e.absolute_path else "(root)"
        return ValidationResult(valid=False, errors=[f"{path}: {e.message}"])

    except Exception as e:
        return ValidationResult(valid=False, errors=[f"Schema validation failed: {e!s}"])


def _get_method_from_info(info: DiscoveryInfo | dict[str, Any]) -> str:
    """Extract HTTP method from discovery info.

    Args:
        info: Discovery info object or dictionary.

    Returns:
        HTTP method string or "UNKNOWN" if not found.
    """
    if isinstance(info, dict):
        input_data = info.get("input", {})
        return input_data.get("method", "UNKNOWN")

    if isinstance(info, QueryDiscoveryInfo | BodyDiscoveryInfo):
        if isinstance(info.input, QueryInput | BodyInput):
            return info.input.method or "UNKNOWN"

    return "UNKNOWN"


def extract_discovery_info(
    payment_payload: PaymentPayload | dict[str, Any],
    payment_requirements: PaymentRequirements | PaymentRequirementsV1 | dict[str, Any],
    validate: bool = True,
) -> DiscoveredResource | None:
    """Extract discovery information from a payment request.

    This function handles both v2 (extensions) and v1 (output_schema) formats.

    For v2: Discovery info is in PaymentPayload.extensions (client copied it from PaymentRequired)
    For v1: Discovery info is in PaymentRequirements.output_schema

    Args:
        payment_payload: The payment payload containing extensions (v2) and version info.
        payment_requirements: The payment requirements (contains output_schema for v1).
        validate: Whether to validate v2 extensions before extracting (default: True).

    Returns:
        DiscoveredResource if found, or None if not discoverable.

    Example:
        ```python
        # V2 - extensions are in PaymentPayload
        info = extract_discovery_info(payment_payload, payment_requirements)

        if info:
            print(f"Resource: {info.resource_url}")
            print(f"Method: {info.method}")
        ```
    """
    # Convert to dict if needed
    if hasattr(payment_payload, "model_dump"):
        payload_dict = payment_payload.model_dump(by_alias=True)
    else:
        payload_dict = payment_payload

    if hasattr(payment_requirements, "model_dump"):
        requirements_dict = payment_requirements.model_dump(by_alias=True)
    else:
        requirements_dict = payment_requirements

    discovery_info: DiscoveryInfo | None = None
    resource_url: str = ""
    route_template: str | None = None
    version = payload_dict.get("x402Version", 1)

    if version == 2:
        # V2: Extract from payload.extensions
        resource = payload_dict.get("resource", {})
        resource_url = resource.get("url", "") if isinstance(resource, dict) else ""

        extensions = payload_dict.get("extensions", {})
        if extensions and BAZAAR.key in extensions:
            bazaar_ext = extensions[BAZAAR.key]

            if bazaar_ext and isinstance(bazaar_ext, dict):
                # routeTemplate uses :param syntax (e.g. "/users/:userId", "/weather/:country/:city").
                # Must start with "/", must not contain ".." or "://".
                raw_template = bazaar_ext.get("routeTemplate")
                if _is_valid_route_template(raw_template):
                    route_template = raw_template
                try:
                    extension = parse_discovery_extension(bazaar_ext)

                    if validate:
                        result = validate_discovery_extension(extension)
                        if not result.valid:
                            logger.warning(
                                "V2 discovery extension validation failed: %s",
                                ", ".join(result.errors),
                            )
                        else:
                            discovery_info = extension.info
                    else:
                        discovery_info = extension.info

                except Exception as e:
                    logger.warning("V2 discovery extension extraction failed: %s", e)

    elif version == 1:
        # V1: Extract from requirements.output_schema
        from .v1 import extract_discovery_info_v1

        resource_url = requirements_dict.get("resource", "")
        discovery_info = extract_discovery_info_v1(requirements_dict)

    else:
        return None

    if discovery_info is None:
        return None

    method = _get_method_from_info(discovery_info)
    # Strip query params (?) and hash sections (#) for discovery cataloging
    parsed = urlparse(resource_url)
    # If a routeTemplate is present (dynamic route), use it as the canonical path
    if route_template:
        normalized_url = urlunparse((parsed.scheme, parsed.netloc, route_template, "", "", ""))
    else:
        normalized_url = urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))

    # Extract description and mime_type from resource info (V2) or requirements (V1)
    description: str | None = None
    mime_type: str | None = None

    if version == 2:
        # V2: description and mime_type are in PaymentPayload.resource
        resource = payload_dict.get("resource", {})
        if isinstance(resource, dict):
            description = resource.get("description") or None
            mime_type = resource.get("mimeType") or resource.get("mime_type") or None
    else:
        # V1: description and mime_type are in PaymentRequirements
        description = requirements_dict.get("description") or None
        mime_type = requirements_dict.get("mimeType") or requirements_dict.get("mime_type") or None

    return DiscoveredResource(
        resource_url=normalized_url,
        method=method,
        x402_version=version,
        discovery_info=discovery_info,
        description=description,
        mime_type=mime_type,
        route_template=route_template,
    )


def extract_discovery_info_from_extension(
    extension: DiscoveryExtension | dict[str, Any],
    validate: bool = True,
) -> DiscoveryInfo:
    """Extract discovery info from a v2 extension directly.

    This is a lower-level function for when you already have the extension object.
    For general use, prefer the main extract_discovery_info function.

    Args:
        extension: The discovery extension to extract info from.
        validate: Whether to validate before extracting (default: True).

    Returns:
        The discovery info if valid.

    Raises:
        ValueError: If validation fails and validate is True.
    """
    if isinstance(extension, dict):
        ext = parse_discovery_extension(extension)
    else:
        ext = extension

    if validate:
        result = validate_discovery_extension(ext)
        if not result.valid:
            error_msg = ", ".join(result.errors) if result.errors else "Unknown error"
            raise ValueError(f"Invalid discovery extension: {error_msg}")

    return ext.info


def validate_and_extract(
    extension: DiscoveryExtension | dict[str, Any],
) -> ValidationExtractResult:
    """Validate and extract discovery info in one step.

    This is a convenience function that combines validation and extraction,
    returning both the validation result and the info if valid.

    Args:
        extension: The discovery extension to validate and extract.

    Returns:
        ValidationExtractResult containing validation result and info if valid.

    Example:
        ```python
        extension = declare_discovery_extension(...)
        result = validate_and_extract(extension["bazaar"])

        if result.valid and result.info:
            # Use result.info
            pass
        else:
            print("Validation errors:", result.errors)
        ```
    """
    if isinstance(extension, dict):
        ext = parse_discovery_extension(extension)
    else:
        ext = extension

    result = validate_discovery_extension(ext)

    if result.valid:
        return ValidationExtractResult(valid=True, info=ext.info)

    return ValidationExtractResult(valid=False, errors=result.errors)
