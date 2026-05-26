"""V1 Facilitator functions for extracting Bazaar discovery information.

In v1, discovery information is stored in the `output_schema` field
of PaymentRequirements, which has a different structure than v2.

This module transforms v1 data into v2 DiscoveryInfo format.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..types import (
    BodyDiscoveryInfo,
    BodyInput,
    BodyType,
    DiscoveryInfo,
    OutputInfo,
    QueryDiscoveryInfo,
    QueryInput,
    is_body_method,
    is_query_method,
)


def _has_v1_output_schema(obj: dict[str, Any]) -> bool:
    """Check if an object has the v1 outputSchema structure.

    Args:
        obj: The object to check.

    Returns:
        True if object has v1 outputSchema structure.
    """
    if not isinstance(obj, dict):
        return False

    input_data = obj.get("input")
    if not isinstance(input_data, dict):
        return False

    return input_data.get("type") == "http" and "method" in input_data


def _extract_query_params(v1_input: dict[str, Any]) -> dict[str, Any] | None:
    """Extract query parameters from v1 input.

    Makes smart assumptions about common field names used in v1.

    Args:
        v1_input: V1 input object from payment requirements.

    Returns:
        Extracted query parameters or None.
    """
    # Check various common field names used in v1 (both camelCase and snake_case)
    for field_name in ["queryParams", "query_params", "query", "params"]:
        value = v1_input.get(field_name)
        if value is not None and isinstance(value, dict):
            return value

    return None


def _extract_body_info(v1_input: dict[str, Any]) -> tuple[dict[str, Any], BodyType]:
    """Extract body information from v1 input.

    Makes smart assumptions about common field names.

    Args:
        v1_input: V1 input object from payment requirements.

    Returns:
        Tuple of (body content, body type).
    """
    # Determine body type (check both camelCase and snake_case)
    body_type: BodyType = "json"
    body_type_field = v1_input.get("bodyType") or v1_input.get("body_type")

    if body_type_field and isinstance(body_type_field, str):
        type_lower = body_type_field.lower()
        if "form" in type_lower or "multipart" in type_lower:
            body_type = "form-data"
        elif "text" in type_lower or "plain" in type_lower:
            body_type = "text"
        else:
            body_type = "json"

    # Extract body content from various possible fields
    body: dict[str, Any] = {}

    for field_name in [
        "bodyFields",
        "body_fields",
        "bodyParams",
        "body",
        "data",
        "properties",
    ]:
        value = v1_input.get(field_name)
        if value is not None and isinstance(value, dict):
            body = value
            break

    return body, body_type


def extract_discovery_info_v1(
    payment_requirements: dict[str, Any],
) -> DiscoveryInfo | None:
    """Extract discovery info from v1 PaymentRequirements and transform to v2 format.

    In v1, the discovery information is stored in the `output_schema` field,
    which contains both input (endpoint shape) and output (response schema) information.

    This function makes smart assumptions to normalize v1 data into v2 DiscoveryInfo format:
    - For GET/HEAD/DELETE: Looks for queryParams, query, or params fields
    - For POST/PUT/PATCH: Looks for bodyFields, body, or data fields and normalizes bodyType
    - Extracts optional headers if present

    Args:
        payment_requirements: V1 payment requirements dictionary.

    Returns:
        Discovery info in v2 format if present and valid, or None if not discoverable.

    Example:
        ```python
        requirements = {
            "scheme": "exact",
            "network": "eip155:8453",
            "maxAmountRequired": "100000",
            "resource": "https://api.example.com/data",
            "description": "Get data",
            "mimeType": "application/json",
            "outputSchema": {
                "input": {
                    "type": "http",
                    "method": "GET",
                    "discoverable": True,
                    "queryParams": {"query": "string"}
                },
                "output": {"type": "object"}
            },
            "payTo": "0x...",
            "maxTimeoutSeconds": 300,
            "asset": "0x..."
        }

        info = extract_discovery_info_v1(requirements)
        if info:
            print("Endpoint method:", info.input.method)
        ```
    """
    output_schema = payment_requirements.get("outputSchema") or payment_requirements.get(
        "output_schema"
    )

    # Check if outputSchema exists and has the expected structure
    if not output_schema or not _has_v1_output_schema(output_schema):
        return None

    v1_input = output_schema["input"]

    # Check if the endpoint is marked as discoverable
    # Default to True if not specified (for backwards compatibility)
    is_discoverable = v1_input.get("discoverable", True)

    if not is_discoverable:
        return None

    method = v1_input.get("method", "")
    if isinstance(method, str):
        method = method.upper()
    else:
        return None

    # Extract headers if present (check both camelCase and snake_case)
    headers_raw = (
        v1_input.get("headerFields") or v1_input.get("header_fields") or v1_input.get("headers")
    )
    headers = headers_raw if isinstance(headers_raw, dict) else None

    # Extract output example/schema if present
    output_data = output_schema.get("output")
    output = OutputInfo(type="json", example=output_data) if output_data else None

    # Transform based on method type
    if is_query_method(method):
        # Query parameter method (GET, HEAD, DELETE)
        query_params = _extract_query_params(v1_input)

        query_input = QueryInput(
            type="http",
            method=method,  # type: ignore[arg-type]
            query_params=query_params,
            headers=headers,
        )

        return QueryDiscoveryInfo(input=query_input, output=output)

    if is_body_method(method):
        # Body method (POST, PUT, PATCH)
        body, body_type = _extract_body_info(v1_input)
        query_params = _extract_query_params(v1_input)  # Some POST requests also have query params

        body_input = BodyInput(
            type="http",
            method=method,  # type: ignore[arg-type]
            body_type=body_type,
            body=body,
            query_params=query_params,
            headers=headers,
        )

        return BodyDiscoveryInfo(input=body_input, output=output)

    # Unsupported method
    return None


def is_discoverable_v1(payment_requirements: dict[str, Any]) -> bool:
    """Check if v1 PaymentRequirements contains discoverable information.

    Args:
        payment_requirements: V1 payment requirements dictionary.

    Returns:
        True if the requirements contain valid discovery info.

    Example:
        ```python
        if is_discoverable_v1(requirements):
            info = extract_discovery_info_v1(requirements)
            # Catalog info in Bazaar
        ```
    """
    return extract_discovery_info_v1(payment_requirements) is not None


@dataclass
class ResourceMetadataV1:
    """Resource metadata extracted from V1 PaymentRequirements."""

    url: str
    description: str
    mime_type: str


def extract_resource_metadata_v1(
    payment_requirements: dict[str, Any],
) -> ResourceMetadataV1:
    """Extract resource metadata from v1 PaymentRequirements.

    In v1, resource information is embedded directly in the payment requirements
    rather than in a separate resource object.

    Args:
        payment_requirements: V1 payment requirements dictionary.

    Returns:
        Resource metadata.

    Example:
        ```python
        metadata = extract_resource_metadata_v1(requirements)
        print("Resource URL:", metadata.url)
        print("Description:", metadata.description)
        ```
    """
    return ResourceMetadataV1(
        url=payment_requirements.get("resource", ""),
        description=payment_requirements.get("description", ""),
        mime_type=payment_requirements.get("mimeType", "")
        or payment_requirements.get("mime_type", ""),
    )
