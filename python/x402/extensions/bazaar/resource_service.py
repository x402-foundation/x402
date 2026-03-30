"""Resource Service functions for creating Bazaar discovery extensions.

These functions help servers declare the shape of their endpoints
for facilitator discovery and cataloging in the Bazaar.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .types import (
    BAZAAR,
    BodyDiscoveryExtension,
    BodyDiscoveryInfo,
    BodyInput,
    BodyType,
    OutputInfo,
    QueryDiscoveryExtension,
    QueryDiscoveryInfo,
    QueryInput,
)


@dataclass
class OutputConfig:
    """Configuration for output specification."""

    example: Any | None = None
    schema: dict[str, Any] | None = None


@dataclass
class DeclareQueryDiscoveryConfig:
    """Configuration for declaring a query discovery extension."""

    input: dict[str, Any] | None = None
    input_schema: dict[str, Any] | None = None
    path_params_schema: dict[str, Any] | None = None
    output: OutputConfig | None = None


@dataclass
class DeclareBodyDiscoveryConfig:
    """Configuration for declaring a body discovery extension."""

    input: dict[str, Any] | None = None
    input_schema: dict[str, Any] | None = None
    path_params_schema: dict[str, Any] | None = None
    body_type: BodyType = "json"
    output: OutputConfig | None = None


def _create_query_discovery_extension(
    input_data: dict[str, Any] | None = None,
    input_schema: dict[str, Any] | None = None,
    path_params_schema: dict[str, Any] | None = None,
    output: OutputConfig | None = None,
) -> QueryDiscoveryExtension:
    """Create a query discovery extension.

    Args:
        input_data: Example query parameters.
        input_schema: JSON schema for query parameters.
        path_params_schema: JSON schema for URL path parameters.
        output: Output specification with example.

    Returns:
        QueryDiscoveryExtension with info and schema.
    """
    if input_schema is None:
        input_schema = {"properties": {}}

    # Build the info
    query_input = QueryInput(
        type="http",
        query_params=input_data if input_data else None,
    )

    output_info = None
    if output and output.example is not None:
        output_info = OutputInfo(type="json", example=output.example)

    query_info = QueryDiscoveryInfo(input=query_input, output=output_info)

    # Build the schema
    schema_properties: dict[str, Any] = {
        "input": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "const": "http"},
                "method": {"type": "string", "enum": ["GET", "HEAD", "DELETE"]},
            },
            "required": ["type", "method"],
            # pathParams are not declared here at schema build time —
            # the server extension's enrich_declaration adds pathParams to both info and schema
            # atomically at request time, keeping data and schema consistent.
            "additionalProperties": False,
        }
    }

    # Add queryParams schema if provided
    if input_schema:
        schema_properties["input"]["properties"]["queryParams"] = {
            "type": "object",
            **input_schema,
        }

    if path_params_schema:
        schema_properties["input"]["properties"]["pathParams"] = {
            "type": "object",
            **path_params_schema,
        }

    # Add output schema if provided
    if output and output.example is not None:
        output_schema: dict[str, Any] = {
            "type": "object",
            "properties": {
                "type": {"type": "string"},
                "example": {"type": "object"},
            },
            "required": ["type"],
        }

        if output.schema:
            output_schema["properties"]["example"].update(output.schema)

        schema_properties["output"] = output_schema

    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": schema_properties,
        "required": ["input"],
    }

    return QueryDiscoveryExtension(info=query_info, schema=schema)


def _create_body_discovery_extension(
    input_data: dict[str, Any] | None = None,
    input_schema: dict[str, Any] | None = None,
    path_params_schema: dict[str, Any] | None = None,
    body_type: BodyType = "json",
    output: OutputConfig | None = None,
) -> BodyDiscoveryExtension:
    """Create a body discovery extension.

    Args:
        input_data: Example request body.
        input_schema: JSON schema for request body.
        path_params_schema: JSON schema for URL path parameters.
        body_type: Content type of body (json, form-data, text).
        output: Output specification with example.

    Returns:
        BodyDiscoveryExtension with info and schema.
    """
    if input_schema is None:
        input_schema = {"properties": {}}

    # Build the info
    body_input = BodyInput(
        type="http",
        body_type=body_type,
        body=input_data if input_data else {},
    )

    output_info = None
    if output and output.example is not None:
        output_info = OutputInfo(type="json", example=output.example)

    body_info = BodyDiscoveryInfo(input=body_input, output=output_info)

    # Build the schema
    schema_properties: dict[str, Any] = {
        "input": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "const": "http"},
                "method": {"type": "string", "enum": ["POST", "PUT", "PATCH"]},
                "bodyType": {"type": "string", "enum": ["json", "form-data", "text"]},
                "body": input_schema,
            },
            "required": ["type", "method", "bodyType", "body"],
            # pathParams are not declared here at schema build time —
            # the server extension's enrich_declaration adds pathParams to both info and schema
            # atomically at request time, keeping data and schema consistent.
            "additionalProperties": False,
        }
    }

    if path_params_schema:
        schema_properties["input"]["properties"]["pathParams"] = {
            "type": "object",
            **path_params_schema,
        }

    # Add output schema if provided
    if output and output.example is not None:
        output_schema: dict[str, Any] = {
            "type": "object",
            "properties": {
                "type": {"type": "string"},
                "example": {"type": "object"},
            },
            "required": ["type"],
        }

        if output.schema:
            output_schema["properties"]["example"].update(output.schema)

        schema_properties["output"] = output_schema

    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": schema_properties,
        "required": ["input"],
    }

    return BodyDiscoveryExtension(info=body_info, schema=schema)


def declare_discovery_extension(
    input: dict[str, Any] | None = None,  # noqa: A002
    input_schema: dict[str, Any] | None = None,
    path_params_schema: dict[str, Any] | None = None,
    body_type: BodyType | None = None,
    output: OutputConfig | None = None,
) -> dict[str, Any]:
    """Create a discovery extension for any HTTP method.

    This function helps servers declare how their endpoint should be called,
    including the expected input parameters/body and output format.

    The HTTP method is NOT passed to this function. It is automatically inferred
    from the route key (e.g., "GET /weather") or enriched by
    bazaar_resource_server_extension at runtime.

    Args:
        input: Example input data (query params for GET/HEAD/DELETE,
            body for POST/PUT/PATCH).
        input_schema: JSON Schema for the input.
        path_params_schema: JSON Schema for URL path parameters (e.g. :city slugs).
        body_type: For POST/PUT/PATCH, specify "json", "form-data", or "text".
            When provided, creates a body extension. When None, creates a query extension.
        output: Output configuration with example and optional schema.

    Returns:
        A dict with "bazaar" key containing the discovery extension.

    Example:
        ```python
        # For a GET endpoint with query params
        extension = declare_discovery_extension(
            input={"query": "example"},
            input_schema={
                "properties": {"query": {"type": "string"}},
                "required": ["query"]
            }
        )

        # For a GET endpoint with path params
        extension = declare_discovery_extension(
            path_params_schema={
                "properties": {"city": {"type": "string"}},
                "required": ["city"]
            },
            output=OutputConfig(example={"city": "sf", "weather": "foggy"})
        )

        # For a POST endpoint with JSON body
        extension = declare_discovery_extension(
            input={"name": "John", "age": 30},
            input_schema={
                "properties": {
                    "name": {"type": "string"},
                    "age": {"type": "number"}
                },
                "required": ["name"]
            },
            body_type="json",
            output=OutputConfig(example={"success": True, "id": "123"})
        )
        ```
    """
    is_body_method = body_type is not None

    if is_body_method:
        extension = _create_body_discovery_extension(
            input_data=input,
            input_schema=input_schema,
            path_params_schema=path_params_schema,
            body_type=body_type,  # type: ignore[arg-type]
            output=output,
        )
    else:
        extension = _create_query_discovery_extension(
            input_data=input,
            input_schema=input_schema,
            path_params_schema=path_params_schema,
            output=output,
        )

    # Convert to dict excluding None values
    return {BAZAAR.key: extension.model_dump(by_alias=True, exclude_none=True)}
