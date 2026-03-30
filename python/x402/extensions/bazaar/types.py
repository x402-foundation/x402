"""Type definitions for the Bazaar Discovery Extension."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from x402.interfaces import FacilitatorExtension

# Extension identifier for the Bazaar discovery extension.
BAZAAR = FacilitatorExtension(key="bazaar")

# HTTP method types
QueryParamMethods = Literal["GET", "HEAD", "DELETE"]
BodyMethods = Literal["POST", "PUT", "PATCH"]
BodyType = Literal["json", "form-data", "text"]


def is_query_method(method: str) -> bool:
    """Check if an HTTP method is a query parameter method.

    Args:
        method: HTTP method string to check.

    Returns:
        True if method is GET, HEAD, or DELETE.
    """
    return method.upper() in ("GET", "HEAD", "DELETE")


def is_body_method(method: str) -> bool:
    """Check if an HTTP method is a body method.

    Args:
        method: HTTP method string to check.

    Returns:
        True if method is POST, PUT, or PATCH.
    """
    return method.upper() in ("POST", "PUT", "PATCH")


class OutputInfo(BaseModel):
    """Output information for discovery."""

    type: str | None = None
    format: str | None = None
    example: Any | None = None

    model_config = {"extra": "allow"}


class QueryInput(BaseModel):
    """Input information for query parameter methods (GET, HEAD, DELETE)."""

    type: Literal["http"] = "http"
    method: QueryParamMethods | None = None
    query_params: dict[str, Any] | None = Field(default=None, alias="queryParams")
    path_params: dict[str, Any] | None = Field(default=None, alias="pathParams")
    headers: dict[str, str] | None = None

    model_config = {"extra": "allow", "populate_by_name": True}


class BodyInput(BaseModel):
    """Input information for body methods (POST, PUT, PATCH)."""

    type: Literal["http"] = "http"
    method: BodyMethods | None = None
    body_type: BodyType = Field(default="json", alias="bodyType")
    body: dict[str, Any] | Any = Field(default_factory=dict)
    query_params: dict[str, Any] | None = Field(default=None, alias="queryParams")
    path_params: dict[str, Any] | None = Field(default=None, alias="pathParams")
    headers: dict[str, str] | None = None

    model_config = {"extra": "allow", "populate_by_name": True}


class QueryDiscoveryInfo(BaseModel):
    """Discovery info for query parameter methods (GET, HEAD, DELETE)."""

    input: QueryInput
    output: OutputInfo | None = None

    model_config = {"extra": "allow"}


class BodyDiscoveryInfo(BaseModel):
    """Discovery info for body methods (POST, PUT, PATCH)."""

    input: BodyInput
    output: OutputInfo | None = None

    model_config = {"extra": "allow"}


# Union type for discovery info
DiscoveryInfo = QueryDiscoveryInfo | BodyDiscoveryInfo


class QueryDiscoveryExtension(BaseModel):
    """Discovery extension for query parameter methods."""

    info: QueryDiscoveryInfo
    schema_: dict[str, Any] = Field(alias="schema")

    model_config = {"extra": "allow", "populate_by_name": True}


class BodyDiscoveryExtension(BaseModel):
    """Discovery extension for body methods."""

    info: BodyDiscoveryInfo
    schema_: dict[str, Any] = Field(alias="schema")

    model_config = {"extra": "allow", "populate_by_name": True}


# Union type for discovery extension
DiscoveryExtension = QueryDiscoveryExtension | BodyDiscoveryExtension


def parse_discovery_extension(data: dict[str, Any]) -> DiscoveryExtension:
    """Parse a discovery extension from a dictionary.

    Automatically determines if it's a query or body extension based on
    the presence of bodyType in the input.

    Args:
        data: Dictionary containing extension data.

    Returns:
        Parsed DiscoveryExtension (Query or Body variant).
    """
    info = data.get("info", {})
    input_data = info.get("input", {})

    # Check if it's a body extension by looking for bodyType
    if "bodyType" in input_data or "body_type" in input_data:
        return BodyDiscoveryExtension.model_validate(data)
    return QueryDiscoveryExtension.model_validate(data)


def parse_discovery_info(data: dict[str, Any]) -> DiscoveryInfo:
    """Parse discovery info from a dictionary.

    Automatically determines if it's query or body info based on
    the presence of bodyType in the input.

    Args:
        data: Dictionary containing discovery info.

    Returns:
        Parsed DiscoveryInfo (Query or Body variant).
    """
    input_data = data.get("input", {})

    # Check if it's body info by looking for bodyType
    if "bodyType" in input_data or "body_type" in input_data:
        return BodyDiscoveryInfo.model_validate(data)
    return QueryDiscoveryInfo.model_validate(data)
