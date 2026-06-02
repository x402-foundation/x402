"""Facilitator functions for validating and extracting Bazaar discovery extensions.

These functions help facilitators validate extension data against schemas
and extract the discovery information for cataloging in the Bazaar.

Supports both v2 (extensions in PaymentRequired) and v1 (output_schema in PaymentRequirements).
"""

from __future__ import annotations

import ipaddress
import logging
import re
import unicodedata
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from urllib.parse import unquote, urlparse, urlunparse

try:
    import idna
except ImportError as e:
    raise ImportError(
        "Extensions validation requires idna. Install with: pip install x402[extensions]"
    ) from e

from .types import (
    BAZAAR,
    BodyDiscoveryInfo,
    BodyInput,
    DiscoveryExtension,
    DiscoveryInfo,
    McpDiscoveryInfo,
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


# Maximum lengths for resource service metadata fields. Spec: see
# specs/extensions/bazaar.md "Service Metadata on `resource`".
_MAX_SERVICE_NAME_LEN = 32
_MAX_TAG_LEN = 32
_MAX_TAGS = 5
_MAX_ICON_URL_LEN = 2048

# Matches ASCII control characters: C0 range (U+0000–U+001F) plus DEL (U+007F).
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")
# Printable ASCII range (U+0020–U+007E). `service_name` and `tags` are
# constrained to this range so that String.length (UTF-16 code units) in TS,
# len() (code points) here, and len() (UTF-8 bytes) in Go all agree on the
# character count. Same convention as paymentidentifier.id.
_PRINTABLE_ASCII_RE = re.compile(r"^[\x20-\x7e]+$")

# Loopback hostnames that must be rejected for SSRF defense. Includes the
# common /etc/hosts aliases on Linux/macOS (`localhost.localdomain`,
# `ip6-localhost`, `ip6-loopback`) — without these, a hostile provider could
# route the facilitator's image fetcher to its own loopback interface.
_LOOPBACK_HOSTNAMES = frozenset(
    {
        "localhost",
        "localhost.localdomain",
        "ip6-localhost",
        "ip6-loopback",
    }
)


def _contains_control_char(s: str) -> bool:
    """Report whether s contains any Unicode control character (category Cc).

    Defense-in-depth: the printable-ASCII regex used by
    ``_is_valid_service_name`` / ``_sanitize_tags`` already rejects every
    control character, but this explicit check documents intent and would
    survive any future relaxation of the ASCII restriction.
    """
    return any(unicodedata.category(c) == "Cc" for c in s)


# SSRF defense: any all-digit hostname is suspect because no legitimate DNS name
# is purely numeric. Catches decimal-encoded IPs (`http://2130706433/` → 127.0.0.1)
# and short-form IPs (`http://0/` → 0.0.0.0, treated as loopback on Linux).
_ALL_DIGITS_RE = re.compile(r"^\d+$")
# SSRF defense: hex-encoded IPs (`http://0x7f000001/` → 127.0.0.1) — same family
# of bypasses as the decimal form above.
_HEX_LITERAL_RE = re.compile(r"^0x[0-9a-f]+$", re.IGNORECASE)


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


def _is_valid_service_name(value: Any) -> bool:
    """Check whether a serviceName value is structurally valid.

    Non-empty string of printable ASCII (U+0020–U+007E), length ≤ 32.

    The ASCII restriction matches the ``paymentidentifier.id`` convention
    and keeps ``len()`` semantics identical across TS / Python / Go.

    Mirrors `isValidServiceName` (TypeScript, Go).
    All three implementations must stay in sync.
    """
    if not isinstance(value, str):
        return False
    if len(value) == 0 or len(value) > _MAX_SERVICE_NAME_LEN:
        return False
    if _contains_control_char(value):
        return False
    if not _PRINTABLE_ASCII_RE.match(value):
        return False
    return True


def _sanitize_tags(value: Any) -> list[str] | None:
    """Sanitize a tags array.

    Drops entries that are not non-empty printable-ASCII strings of at most
    32 characters, then truncates to the first 5 valid entries. Returns None
    when nothing survives so the field can be omitted from the catalog.

    The ASCII restriction matches the ``paymentidentifier.id`` convention
    and keeps ``len()`` semantics identical across TS / Python / Go.

    Mirrors `sanitizeTags` (TypeScript, Go).
    All three implementations must stay in sync.
    """
    if not isinstance(value, list):
        return None
    out: list[str] = []
    # Case-insensitive dedup: keeps the first occurrence's casing.
    # Prevents catalog noise like ["Weather", "weather", "WEATHER"].
    seen: set[str] = set()
    for entry in value:
        if not isinstance(entry, str):
            continue
        if len(entry) == 0 or len(entry) > _MAX_TAG_LEN:
            continue
        if _contains_control_char(entry):
            continue
        if not _PRINTABLE_ASCII_RE.match(entry):
            continue
        key = entry.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(entry)
        if len(out) == _MAX_TAGS:
            break
    return out if out else None


def _is_valid_icon_url(value: Any) -> bool:
    """Check whether an iconUrl value is structurally safe.

    Rules (see specs/extensions/bazaar.md "Service Metadata on `resource`"):
      - String of length ≤ 2048
      - No ASCII control characters
      - Parses as an absolute http:// or https:// URL
      - No userinfo (user@host)
      - Host is IDN-normalized (UTS #46) before checks, so confusable
        full-width / Unicode forms (e.g. ``ｌｏｃａｌｈｏｓｔ``) collapse to
        their ASCII canonical and get caught by the loopback check
      - Host is not an IP literal (v4 or v6), not in the loopback set
        (``localhost``, ``localhost.localdomain``, ``ip6-localhost``,
        ``ip6-loopback``)
      - Host is not a decimal IP encoding (e.g. ``2130706433`` → 127.0.0.1) or
        hex literal (e.g. ``0x7f000001``) — common SSRF bypass forms

    Percent-decoding is applied to the hostname before IDN normalization, and
    IDN normalization runs before the IP / loopback checks (parallel to the
    routeTemplate decoder).

    Mirrors `isValidIconUrl` (TypeScript, Go).
    All three implementations must stay in sync.
    """
    if not isinstance(value, str):
        return False
    if len(value) == 0 or len(value) > _MAX_ICON_URL_LEN:
        return False
    if _CONTROL_CHAR_RE.search(value):
        return False
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    if parsed.username or parsed.password:
        return False
    raw_host = parsed.hostname
    if not raw_host:
        return False
    try:
        decoded = unquote(raw_host)
    except ValueError:
        return False
    # IDN/full-width normalization: e.g. "ｌｏｃａｌｈｏｓｔ" (full-width Latin)
    # → "localhost". Without this the loopback alias check would miss
    # confusable Unicode hostnames. uts46=True applies the same UTS #46
    # mapping that idna.Lookup.ToASCII (Go) and domainToASCII (Node) use.
    try:
        host = idna.encode(decoded, uts46=True).decode("ascii").lower()
    except idna.IDNAError:
        return False
    if host == "":
        return False
    if host in _LOOPBACK_HOSTNAMES:
        return False
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        return False
    # urlparse strips IPv6 brackets from .hostname; if the original netloc had
    # brackets but the bare host failed ip_address parsing (e.g. "::1"), still
    # reject any colon-bearing host as an IPv6 literal candidate.
    if ":" in host:
        return False
    if _ALL_DIGITS_RE.match(host):
        return False
    if _HEX_LITERAL_RE.match(host):
        return False
    return True


@dataclass
class SanitizedResourceServiceMetadata:
    """Sanitized service metadata extracted from a ``resource`` object."""

    service_name: str | None = None
    tags: list[str] | None = None
    icon_url: str | None = None


def _sanitize_resource_service_metadata(
    resource: dict[str, Any] | None,
) -> SanitizedResourceServiceMetadata:
    """Apply the bazaar service-metadata validation rules to a ``resource`` object.

    Returns only the fields that survive. Missing or invalid fields are dropped
    silently (soft-drop semantics — see spec).

    Accepts both camelCase (``serviceName`` / ``iconUrl``) and snake_case
    (``service_name`` / ``icon_url``) keys, matching the dual-naming convention
    used elsewhere when extracting from raw payload dicts.
    """
    out = SanitizedResourceServiceMetadata()
    if not isinstance(resource, dict):
        return out
    raw_name = resource.get("serviceName")
    if raw_name is None:
        raw_name = resource.get("service_name")
    if _is_valid_service_name(raw_name):
        out.service_name = raw_name
    out.tags = _sanitize_tags(resource.get("tags"))
    raw_icon = resource.get("iconUrl")
    if raw_icon is None:
        raw_icon = resource.get("icon_url")
    if _is_valid_icon_url(raw_icon):
        out.icon_url = raw_icon
    return out


@dataclass
class ValidationResult:
    """Result of validating a discovery extension."""

    valid: bool
    errors: list[str] = field(default_factory=list)


@dataclass
class DiscoveredResource:
    """A discovered x402 resource with its metadata."""

    resource_url: str
    x402_version: int
    discovery_info: DiscoveryInfo
    method: str = ""
    tool_name: str | None = None
    description: str | None = None
    mime_type: str | None = None
    route_template: str | None = None
    # Sanitized service metadata. See `_sanitize_resource_service_metadata`.
    service_name: str | None = None
    tags: list[str] | None = None
    icon_url: str | None = None
    extensions: dict[str, Any] | None = None


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


_VALID_QUERY_METHODS = frozenset({"GET", "HEAD", "DELETE"})
_VALID_BODY_METHODS = frozenset({"POST", "PUT", "PATCH"})
_VALID_METHODS = _VALID_QUERY_METHODS | _VALID_BODY_METHODS
_VALID_BODY_TYPES = frozenset({"json", "form-data", "text"})
_VALID_MCP_TRANSPORTS = frozenset({"streamable-http", "sse"})


def validate_discovery_extension_spec(extension: dict[str, Any] | object) -> ValidationResult:
    """Validate a discovery extension against the Bazaar protocol specification.

    Unlike ``validate_discovery_extension`` which checks internal consistency
    (info vs schema), this function enforces protocol-level invariants:

    - ``info.input.type`` must be ``"http"`` or ``"mcp"``
    - HTTP: if ``method`` is present it must be GET/POST/PUT/PATCH/DELETE/HEAD
    - HTTP body methods: ``bodyType`` must be ``"json"`` | ``"form-data"`` | ``"text"``
    - MCP: ``toolName`` (string) and ``inputSchema`` (object) are required
    - MCP: if ``transport`` is present it must be ``"streamable-http"`` | ``"sse"``

    Safe for pre-enrichment HTTP extensions where ``method`` may be absent.

    Args:
        extension: The discovery extension to validate (dict or object).

    Returns:
        ValidationResult with spec-level errors.
    """
    errors: list[str] = []

    if isinstance(extension, dict):
        info = extension.get("info")
    elif hasattr(extension, "info"):
        info = extension.info  # type: ignore[union-attr]
    else:
        return ValidationResult(valid=False, errors=["Missing or invalid 'info' field"])

    if not info or not isinstance(info, dict | object):
        return ValidationResult(valid=False, errors=["Missing or invalid 'info' field"])

    if isinstance(info, dict):
        input_data = info.get("input")
    elif hasattr(info, "input"):
        input_data = info.input  # type: ignore[union-attr]
    else:
        return ValidationResult(valid=False, errors=["Missing or invalid 'info.input' field"])

    if not input_data:
        return ValidationResult(valid=False, errors=["Missing or invalid 'info.input' field"])

    if isinstance(input_data, dict):
        input_type = input_data.get("type")
    elif hasattr(input_data, "type"):
        input_type = input_data.type  # type: ignore[union-attr]
    else:
        input_type = None

    if input_type not in ("http", "mcp"):
        errors.append(f'info.input.type must be "http" or "mcp", got "{input_type}"')
        return ValidationResult(valid=False, errors=errors)

    if input_type == "http":
        method = (
            input_data.get("method")
            if isinstance(input_data, dict)
            else getattr(input_data, "method", None)
        )
        if method is not None and method not in _VALID_METHODS:
            errors.append(
                f'info.input.method must be one of {", ".join(sorted(_VALID_METHODS))}, got "{method}"'
            )

        body_type = (
            input_data.get("bodyType")
            if isinstance(input_data, dict)
            else getattr(input_data, "body_type", None)
        )
        if body_type is not None:
            if body_type not in _VALID_BODY_TYPES:
                errors.append(
                    f'info.input.bodyType must be one of {", ".join(sorted(_VALID_BODY_TYPES))}, got "{body_type}"'
                )
            if method is not None and method not in _VALID_BODY_METHODS:
                errors.append(
                    f'info.input.bodyType is set but method "{method}" is not a body method (POST, PUT, PATCH)'
                )

    if input_type == "mcp":
        tool_name = (
            input_data.get("toolName")
            if isinstance(input_data, dict)
            else getattr(input_data, "tool_name", None)
        )
        if not isinstance(tool_name, str) or len(tool_name) == 0:
            errors.append(
                "info.input.toolName is required and must be a non-empty string for MCP extensions"
            )

        input_schema = (
            input_data.get("inputSchema")
            if isinstance(input_data, dict)
            else getattr(input_data, "input_schema", None)
        )
        if not input_schema or not isinstance(input_schema, dict):
            errors.append(
                "info.input.inputSchema is required and must be an object for MCP extensions"
            )

        transport = (
            input_data.get("transport")
            if isinstance(input_data, dict)
            else getattr(input_data, "transport", None)
        )
        if transport is not None and transport not in _VALID_MCP_TRANSPORTS:
            errors.append(
                f'info.input.transport must be one of {", ".join(sorted(_VALID_MCP_TRANSPORTS))}, got "{transport}"'
            )

    return (
        ValidationResult(valid=True) if not errors else ValidationResult(valid=False, errors=errors)
    )


def _get_method_from_info(info: DiscoveryInfo | dict[str, Any]) -> str:
    """Extract HTTP method from discovery info. Returns empty string for MCP resources."""
    if isinstance(info, McpDiscoveryInfo):
        return ""

    if isinstance(info, dict):
        input_data = info.get("input", {})
        if input_data.get("type") == "mcp":
            return ""
        return input_data.get("method", "")

    if isinstance(info, QueryDiscoveryInfo | BodyDiscoveryInfo):
        if isinstance(info.input, QueryInput | BodyInput):
            return info.input.method or ""

    return ""


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
        from .v1 import build_v1_catalog_extensions, extract_discovery_info_v1

        resource_url = requirements_dict.get("resource", "")
        discovery_info = extract_discovery_info_v1(requirements_dict)

    else:
        return None

    if discovery_info is None:
        return None

    method = _get_method_from_info(discovery_info)
    tool_name: str | None = None
    if isinstance(discovery_info, McpDiscoveryInfo):
        tool_name = discovery_info.input.tool_name

    if not method and not tool_name:
        logger.warning("Failed to extract method or tool_name from discovery info")
        return None

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
    service_metadata = SanitizedResourceServiceMetadata()

    if version == 2:
        # V2: description, mime_type, and service metadata are in PaymentPayload.resource
        resource = payload_dict.get("resource", {})
        if isinstance(resource, dict):
            description = resource.get("description") or None
            mime_type = resource.get("mimeType") or resource.get("mime_type") or None
            service_metadata = _sanitize_resource_service_metadata(resource)
    else:
        # V1: description and mime_type are in PaymentRequirements; no service metadata.
        description = requirements_dict.get("description") or None
        mime_type = requirements_dict.get("mimeType") or requirements_dict.get("mime_type") or None

    extensions: dict[str, Any] | None = None
    if version == 2:
        raw_extensions = payload_dict.get("extensions")
        if isinstance(raw_extensions, dict):
            extensions = raw_extensions
    elif discovery_info is not None:
        payload_extensions = payload_dict.get("extensions")
        existing_extensions = payload_extensions if isinstance(payload_extensions, dict) else None
        extensions = build_v1_catalog_extensions(existing_extensions, discovery_info)

    return DiscoveredResource(
        resource_url=normalized_url,
        x402_version=version,
        discovery_info=discovery_info,
        method=method,
        tool_name=tool_name,
        description=description,
        mime_type=mime_type,
        route_template=route_template,
        service_name=service_metadata.service_name,
        tags=service_metadata.tags,
        icon_url=service_metadata.icon_url,
        extensions=extensions,
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
