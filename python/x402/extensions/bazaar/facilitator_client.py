"""Client extensions for querying Bazaar discovery resources.

This module provides the `with_bazaar` function that extends a facilitator
client with discovery query functionality.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from x402.http.facilitator_client import HTTPFacilitatorClient


@dataclass
class ListDiscoveryResourcesParams:
    """Parameters for listing discovery resources.

    All parameters are optional and used for filtering/pagination.
    """

    type: str | None = None
    """Filter by protocol type (e.g., "http", "mcp")."""

    pay_to: str | None = None
    """Filter by payment recipient address."""

    scheme: str | None = None
    """Filter by payment scheme (e.g., "exact")."""

    network: str | None = None
    """Filter by payment network (e.g., "eip155:8453")."""

    extensions: str | None = None
    """Filter by extension key present on the discovered resource."""

    limit: int | None = None
    """The number of discovered x402 resources to return per page."""

    offset: int | None = None
    """The offset of the first discovered x402 resource to return."""


@dataclass
class SearchDiscoveryResourcesParams:
    """Parameters for searching discovery resources."""

    query: str = ""
    """Natural-language search query (required)."""

    type: str | None = None
    """Filter by protocol type (e.g., "http", "mcp")."""

    pay_to: str | None = None
    """Filter by payment recipient address."""

    scheme: str | None = None
    """Filter by payment scheme (e.g., "exact")."""

    network: str | None = None
    """Filter by payment network (e.g., "eip155:8453")."""

    extensions: str | None = None
    """Filter by extension key present on the discovered resource."""

    limit: int | None = None
    """Advisory maximum number of results. The server may return fewer or ignore this."""

    cursor: str | None = None
    """Advisory continuation token from a previous response. The server may ignore this."""


@dataclass
class DiscoveryResource:
    """A discovered x402 resource from the bazaar."""

    resource: str
    """The URL or identifier of the discovered resource."""

    type: str
    """The protocol type of the resource."""

    x402_version: int = 0
    """The x402 protocol version supported by this resource."""

    accepts: list[Any] | None = None
    """Array of accepted payment methods for this resource."""

    last_updated: str | None = None
    """ISO 8601 timestamp of when the resource was last updated."""

    description: str | None = None
    """Human-readable description of the resource."""

    mime_type: str | None = None
    """MIME type of the resource response."""

    service_name: str | None = None
    """Human-readable name for the service hosting the resource."""

    tags: list[str] | None = None
    """Short topical tags for discovery search."""

    icon_url: str | None = None
    """Absolute http(s) URL to a service icon."""

    extensions: dict[str, Any] | None = None
    """Extension payloads echoed from discovery (e.g. bazaar info/schema)."""

    def to_dict(self) -> dict[str, Any]:
        """Serialize to the bazaar discovery API wire format (camelCase keys)."""
        result: dict[str, Any] = {
            "resource": self.resource,
            "type": self.type,
            "x402Version": self.x402_version,
            "accepts": self.accepts or [],
            "lastUpdated": self.last_updated or "",
        }
        if self.description is not None:
            result["description"] = self.description
        if self.mime_type is not None:
            result["mimeType"] = self.mime_type
        if self.service_name is not None:
            result["serviceName"] = self.service_name
        if self.tags is not None:
            result["tags"] = self.tags
        if self.icon_url is not None:
            result["iconUrl"] = self.icon_url
        if self.extensions is not None:
            result["extensions"] = self.extensions
        return result


@dataclass
class Pagination:
    """Pagination information for a list response."""

    limit: int = 0
    offset: int = 0
    total: int = 0


@dataclass
class DiscoveryResourcesResponse:
    """Response from listing discovery resources."""

    x402_version: int
    """The x402 protocol version of this response."""

    items: list[DiscoveryResource]
    """The list of discovered resources."""

    pagination: Pagination
    """Pagination information for the response."""


@dataclass
class SearchPagination:
    """Pagination details for a paginated search response."""

    limit: int
    """Number of results in this page."""

    cursor: str | None
    """Continuation cursor for the next page; may be None."""


@dataclass
class SearchDiscoveryResourcesResponse:
    """Response from searching discovery resources."""

    x402_version: int
    """The x402 protocol version of this response."""

    resources: list[DiscoveryResource]
    """The list of matching discovered resources."""

    partial_results: bool | None = None
    """Whether additional matches were truncated by the facilitator."""

    pagination: SearchPagination | None = None
    """Optional pagination details for paginated responses."""


class BazaarExtension:
    """Bazaar extension providing discovery list and search functionality.

    This extension is attached to a facilitator client via `with_bazaar()`
    and provides methods to query discovery resources from the facilitator.
    """

    def __init__(self, client: HTTPFacilitatorClient) -> None:
        """Initialize the bazaar extension.

        Args:
            client: The facilitator client to use for requests.
        """
        self._client = client

    def list_resources(
        self,
        params: ListDiscoveryResourcesParams | None = None,
    ) -> DiscoveryResourcesResponse:
        """List x402 discovery resources from the bazaar.

        Args:
            params: Optional filtering and pagination parameters.

        Returns:
            A response containing the discovery resources.

        Raises:
            ValueError: If the request fails.

        Example:
            ```python
            from x402.http import HTTPFacilitatorClient
            from x402.extensions.bazaar import with_bazaar

            client = with_bazaar(HTTPFacilitatorClient())
            resources = client.extensions.bazaar.list_resources(
                ListDiscoveryResourcesParams(type="http", limit=10)
            )
            for resource in resources.items:
                print(f"Resource: {resource.resource}")
            ```
        """
        params = params or ListDiscoveryResourcesParams()

        headers: dict[str, str] = {"Content-Type": "application/json"}

        if self._client._auth_provider:
            auth = self._client._auth_provider.get_auth_headers()
            headers.update(auth.bazaar)

        query_params: dict[str, str] = {}
        if params.type is not None:
            query_params["type"] = params.type
        if params.pay_to is not None:
            query_params["payTo"] = params.pay_to
        if params.scheme is not None:
            query_params["scheme"] = params.scheme
        if params.network is not None:
            query_params["network"] = params.network
        if params.extensions is not None:
            query_params["extensions"] = params.extensions
        if params.limit is not None:
            query_params["limit"] = str(params.limit)
        if params.offset is not None:
            query_params["offset"] = str(params.offset)

        endpoint = f"{self._client.url}/discovery/resources"

        http_client = self._client._get_client()  # type: ignore[attr-defined]

        response = http_client.get(
            endpoint,
            headers=headers,
            params=query_params if query_params else None,
        )

        if response.status_code != 200:
            raise ValueError(
                f"Facilitator listDiscoveryResources failed ({response.status_code}): {response.text}"
            )

        data = response.json()
        return _parse_list_response(data)

    def search(
        self,
        params: SearchDiscoveryResourcesParams,
    ) -> SearchDiscoveryResourcesResponse:
        """Search x402 discovery resources from the bazaar using a natural-language query.

        Pagination is optional: facilitators may ignore `limit` and `cursor`, or include
        `response.pagination` when pagination is used.

        Args:
            params: Search parameters including the required query string.

        Returns:
            A response containing matched discovery resources and optional pagination hints.

        Raises:
            ValueError: If query is empty or the request fails.

        Example:
            ```python
            from x402.http import HTTPFacilitatorClient
            from x402.extensions.bazaar import with_bazaar, SearchDiscoveryResourcesParams

            client = with_bazaar(HTTPFacilitatorClient())
            results = client.extensions.bazaar.search(
                SearchDiscoveryResourcesParams(query="weather APIs", type="http")
            )
            if results.cursor is not None:
                # facilitator returned continuation cursor for the next page
                pass
            ```
        """
        if not params.query:
            raise ValueError("search query is required")

        headers: dict[str, str] = {"Content-Type": "application/json"}

        if self._client._auth_provider:
            auth = self._client._auth_provider.get_auth_headers()
            headers.update(auth.bazaar)

        query_params: dict[str, str] = {"query": params.query}
        if params.type is not None:
            query_params["type"] = params.type
        if params.pay_to is not None:
            query_params["payTo"] = params.pay_to
        if params.scheme is not None:
            query_params["scheme"] = params.scheme
        if params.network is not None:
            query_params["network"] = params.network
        if params.extensions is not None:
            query_params["extensions"] = params.extensions
        if params.limit is not None:
            query_params["limit"] = str(params.limit)
        if params.cursor is not None:
            query_params["cursor"] = params.cursor

        endpoint = f"{self._client.url}/discovery/search"

        http_client = self._client._get_client()  # type: ignore[attr-defined]

        response = http_client.get(
            endpoint,
            headers=headers,
            params=query_params,
        )

        if response.status_code != 200:
            raise ValueError(
                f"Facilitator searchDiscoveryResources failed ({response.status_code}): {response.text}"
            )

        data = response.json()
        return _parse_search_response(data)


class BazaarClientExtension:
    """Bazaar client extension interface providing discovery query functionality."""

    def __init__(self, client: HTTPFacilitatorClient) -> None:
        """Initialize the bazaar client extension.

        Args:
            client: The facilitator client to use.
        """
        self.bazaar = BazaarExtension(client)


class BazaarExtendedClient:
    """A facilitator client extended with bazaar discovery capabilities.

    This class wraps an HTTPFacilitatorClient and adds an `extensions`
    attribute containing bazaar functionality.
    """

    def __init__(self, client: HTTPFacilitatorClient) -> None:
        """Initialize the extended client.

        Args:
            client: The base facilitator client to extend.
        """
        self._client = client
        self.extensions = BazaarClientExtension(client)

    def __getattr__(self, name: str) -> Any:
        """Delegate attribute access to the wrapped client."""
        return getattr(self._client, name)

    def __enter__(self) -> BazaarExtendedClient:
        self._client.__enter__()  # type: ignore[attr-defined]
        return self

    def __exit__(self, *args: Any) -> None:
        self._client.__exit__(*args)  # type: ignore[attr-defined]


def with_bazaar(client: HTTPFacilitatorClient) -> BazaarExtendedClient:
    """Extend a facilitator client with Bazaar discovery query functionality.

    Args:
        client: The facilitator client to extend.

    Returns:
        The client extended with bazaar discovery capabilities.

    Example:
        ```python
        from x402.http import HTTPFacilitatorClient, FacilitatorConfig
        from x402.extensions.bazaar import with_bazaar, ListDiscoveryResourcesParams

        # List resources
        client = with_bazaar(HTTPFacilitatorClient())
        resources = client.extensions.bazaar.list_resources()

        # Search resources
        results = client.extensions.bazaar.search(
            SearchDiscoveryResourcesParams(query="weather APIs", limit=10)
        )

        # Access wrapped client methods
        supported = client.get_supported()
        ```
    """
    return BazaarExtendedClient(client)


def _parse_discovery_resource_item(item: dict[str, Any]) -> DiscoveryResource:
    """Parse a single discovery resource from facilitator JSON."""
    return DiscoveryResource(
        resource=item.get("resource", ""),
        type=item.get("type", ""),
        x402_version=item.get("x402Version", 0),
        accepts=item.get("accepts"),
        last_updated=item.get("lastUpdated"),
        description=item.get("description"),
        mime_type=item.get("mimeType"),
        service_name=item.get("serviceName"),
        tags=item.get("tags"),
        icon_url=item.get("iconUrl"),
        extensions=item.get("extensions"),
    )


def _parse_list_response(
    data: dict[str, Any],
) -> DiscoveryResourcesResponse:
    """Parse a list discovery resources response from JSON data."""
    items = [_parse_discovery_resource_item(item) for item in data.get("items", [])]

    raw_pagination = data.get("pagination", {})
    pagination = Pagination(
        limit=raw_pagination.get("limit", 0),
        offset=raw_pagination.get("offset", 0),
        total=raw_pagination.get("total", 0),
    )

    return DiscoveryResourcesResponse(
        x402_version=data.get("x402Version", 0),
        items=items,
        pagination=pagination,
    )


def _parse_search_response(
    data: dict[str, Any],
) -> SearchDiscoveryResourcesResponse:
    """Parse a search discovery resources response from JSON data."""
    items = [_parse_discovery_resource_item(item) for item in data.get("resources", [])]

    raw_pagination = data.get("pagination")
    pagination = (
        SearchPagination(
            limit=raw_pagination.get("limit", 0),
            cursor=raw_pagination.get("cursor"),
        )
        if raw_pagination is not None
        else None
    )

    return SearchDiscoveryResourcesResponse(
        x402_version=data.get("x402Version", 0),
        resources=items,
        partial_results=data.get("partialResults"),
        pagination=pagination,
    )
