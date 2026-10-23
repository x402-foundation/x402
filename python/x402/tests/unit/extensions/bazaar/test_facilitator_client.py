"""Unit tests for the Bazaar facilitator client (with_bazaar, list_resources, search)."""

from __future__ import annotations

import json
from collections.abc import Callable
from unittest.mock import MagicMock

import httpx
import pytest

from x402.extensions.bazaar import (
    AsyncBazaarClientExtension,
    AsyncBazaarExtendedClient,
    AsyncBazaarExtension,
    BazaarClientExtension,
    BazaarExtendedClient,
    BazaarExtension,
    DiscoveryResourcesResponse,
    ListDiscoveryResourcesParams,
    Pagination,
    SearchDiscoveryResourcesParams,
    SearchDiscoveryResourcesResponse,
    with_bazaar,
)
from x402.extensions.bazaar.facilitator_client import (
    _parse_discovery_resource_item,
    _parse_list_response,
    _parse_search_response,
)
from x402.http import (
    AuthHeaders,
    FacilitatorConfig,
    HTTPFacilitatorClient,
    HTTPFacilitatorClientSync,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_client(url: str = "https://facilitator.example.com") -> MagicMock:
    """Create a minimal mock HTTPFacilitatorClient."""
    client = MagicMock()
    client.url = url
    client._auth_provider = None
    return client


def _make_http_response(status_code: int = 200, json_data: dict | None = None) -> MagicMock:
    """Create a mock HTTP response."""
    response = MagicMock()
    response.status_code = status_code
    response.text = json.dumps(json_data or {})
    response.json.return_value = json_data or {}
    return response


LIST_RESPONSE_FIXTURE = {
    "x402Version": 2,
    "items": [
        {
            "resource": "https://api.example.com/weather",
            "type": "http",
            "x402Version": 2,
            "accepts": [{"scheme": "exact", "network": "eip155:8453"}],
            "lastUpdated": "2026-01-01T00:00:00Z",
            "extensions": {"bazaar": {"category": "weather"}},
        }
    ],
    "pagination": {"limit": 20, "offset": 0, "total": 1},
}

SEARCH_RESPONSE_FIXTURE = {
    "x402Version": 2,
    "resources": [
        {
            "resource": "https://api.example.com/weather",
            "type": "http",
            "x402Version": 2,
            "accepts": [],
            "lastUpdated": "2026-01-01T00:00:00Z",
        }
    ],
    "partialResults": False,
    "pagination": {"limit": 10, "cursor": None},
}


# ---------------------------------------------------------------------------
# _parse_list_response
# ---------------------------------------------------------------------------


class TestParseListResponse:
    def test_parses_items_and_pagination(self) -> None:
        result = _parse_list_response(LIST_RESPONSE_FIXTURE)

        assert isinstance(result, DiscoveryResourcesResponse)
        assert result.x402_version == 2
        assert len(result.items) == 1
        assert result.items[0].resource == "https://api.example.com/weather"
        assert result.items[0].type == "http"
        assert result.items[0].x402_version == 2
        assert result.items[0].last_updated == "2026-01-01T00:00:00Z"
        assert result.items[0].extensions == {"bazaar": {"category": "weather"}}
        assert isinstance(result.pagination, Pagination)
        assert result.pagination.limit == 20
        assert result.pagination.offset == 0
        assert result.pagination.total == 1

    def test_handles_empty_items(self) -> None:
        data = {
            "x402Version": 2,
            "items": [],
            "pagination": {"limit": 20, "offset": 0, "total": 0},
        }
        result = _parse_list_response(data)

        assert result.items == []
        assert result.pagination.total == 0

    def test_handles_missing_optional_fields(self) -> None:
        data = {
            "x402Version": 1,
            "items": [{"resource": "https://api.example.com/data", "type": "mcp"}],
            "pagination": {"limit": 10, "offset": 0, "total": 1},
        }
        result = _parse_list_response(data)

        assert result.items[0].resource == "https://api.example.com/data"
        assert result.items[0].extensions is None
        assert result.items[0].accepts is None
        assert result.items[0].x402_version == 0

    def test_handles_missing_pagination(self) -> None:
        data = {"x402Version": 2, "items": []}
        result = _parse_list_response(data)

        assert result.pagination.limit == 0
        assert result.pagination.offset == 0
        assert result.pagination.total == 0


# ---------------------------------------------------------------------------
# _parse_search_response
# ---------------------------------------------------------------------------


class TestParseSearchResponse:
    def test_parses_items_and_search_meta(self) -> None:
        result = _parse_search_response(SEARCH_RESPONSE_FIXTURE)

        assert isinstance(result, SearchDiscoveryResourcesResponse)
        assert result.x402_version == 2
        assert len(result.resources) == 1
        assert result.resources[0].resource == "https://api.example.com/weather"
        assert result.partial_results is False
        assert result.pagination is not None
        assert result.pagination.limit == 10
        assert result.pagination.cursor is None

    def test_parses_pagination_object_with_cursor(self) -> None:
        data = {
            "x402Version": 2,
            "resources": [],
            "pagination": {"limit": 10, "cursor": "eyJwYWdlIjoyfQ=="},
        }
        result = _parse_search_response(data)

        assert result.pagination is not None
        assert result.pagination.limit == 10
        assert result.pagination.cursor == "eyJwYWdlIjoyfQ=="

    def test_handles_null_cursor_in_pagination(self) -> None:
        data = {
            "x402Version": 2,
            "resources": [],
            "pagination": {"limit": 5, "cursor": None},
        }
        result = _parse_search_response(data)

        assert result.pagination is not None
        assert result.pagination.cursor is None

    def test_handles_missing_pagination(self) -> None:
        data = {"x402Version": 2, "resources": []}
        result = _parse_search_response(data)

        assert result.pagination is None


# ---------------------------------------------------------------------------
# with_bazaar
# ---------------------------------------------------------------------------


class TestWithBazaar:
    def test_returns_extended_client(self) -> None:
        client = _make_client()
        extended = with_bazaar(client)

        assert isinstance(extended, BazaarExtendedClient)

    def test_extensions_bazaar_is_present(self) -> None:
        client = _make_client()
        extended = with_bazaar(client)

        assert isinstance(extended.extensions, BazaarClientExtension)
        assert isinstance(extended.extensions.bazaar, BazaarExtension)

    def test_delegates_attribute_access_to_wrapped_client(self) -> None:
        client = _make_client()
        client.url = "https://example.com/facilitator"
        extended = with_bazaar(client)

        assert extended.url == "https://example.com/facilitator"

    def test_context_manager_delegates_to_client(self) -> None:
        client = _make_client()
        client.__enter__ = MagicMock(return_value=client)
        client.__exit__ = MagicMock(return_value=None)
        extended = with_bazaar(client)

        with extended as ctx:
            assert ctx is extended

        client.__enter__.assert_called_once()
        client.__exit__.assert_called_once()


# ---------------------------------------------------------------------------
# BazaarExtension.list_resources
# ---------------------------------------------------------------------------


class TestListResources:
    def _make_extended(self, response: MagicMock) -> BazaarExtendedClient:
        client = _make_client()
        http_client = MagicMock()
        http_client.get.return_value = response
        client._get_client.return_value = http_client
        return with_bazaar(client)

    def test_calls_correct_endpoint(self) -> None:
        response = _make_http_response(200, LIST_RESPONSE_FIXTURE)
        extended = self._make_extended(response)

        extended.extensions.bazaar.list_resources()

        http_client = extended._client._get_client()
        call_args = http_client.get.call_args
        assert call_args[0][0] == "https://facilitator.example.com/discovery/resources"

    def test_passes_type_param(self) -> None:
        response = _make_http_response(200, LIST_RESPONSE_FIXTURE)
        extended = self._make_extended(response)

        extended.extensions.bazaar.list_resources(ListDiscoveryResourcesParams(type="http"))

        http_client = extended._client._get_client()
        call_kwargs = http_client.get.call_args[1]
        assert call_kwargs["params"]["type"] == "http"

    def test_passes_limit_and_offset(self) -> None:
        response = _make_http_response(200, LIST_RESPONSE_FIXTURE)
        extended = self._make_extended(response)

        extended.extensions.bazaar.list_resources(ListDiscoveryResourcesParams(limit=10, offset=5))

        http_client = extended._client._get_client()
        call_kwargs = http_client.get.call_args[1]
        assert call_kwargs["params"]["limit"] == "10"
        assert call_kwargs["params"]["offset"] == "5"

    def test_passes_additional_filters(self) -> None:
        response = _make_http_response(200, LIST_RESPONSE_FIXTURE)
        extended = self._make_extended(response)

        extended.extensions.bazaar.list_resources(
            ListDiscoveryResourcesParams(
                pay_to="0x1234567890123456789012345678901234567890",
                scheme="exact",
                network="eip155:8453",
                extensions="bazaar",
            )
        )

        http_client = extended._client._get_client()
        call_kwargs = http_client.get.call_args[1]
        assert call_kwargs["params"]["payTo"] == "0x1234567890123456789012345678901234567890"
        assert call_kwargs["params"]["scheme"] == "exact"
        assert call_kwargs["params"]["network"] == "eip155:8453"
        assert call_kwargs["params"]["extensions"] == "bazaar"

    def test_omits_params_when_none(self) -> None:
        response = _make_http_response(200, LIST_RESPONSE_FIXTURE)
        extended = self._make_extended(response)

        extended.extensions.bazaar.list_resources()

        http_client = extended._client._get_client()
        call_kwargs = http_client.get.call_args[1]
        assert call_kwargs.get("params") is None

    def test_returns_parsed_response(self) -> None:
        response = _make_http_response(200, LIST_RESPONSE_FIXTURE)
        extended = self._make_extended(response)

        result = extended.extensions.bazaar.list_resources()

        assert isinstance(result, DiscoveryResourcesResponse)
        assert len(result.items) == 1
        assert result.items[0].resource == "https://api.example.com/weather"
        assert result.pagination.total == 1

    def test_raises_on_error_response(self) -> None:
        response = _make_http_response(500, {})
        response.text = "internal server error"
        extended = self._make_extended(response)

        with pytest.raises(ValueError, match="listDiscoveryResources failed \\(500\\)"):
            extended.extensions.bazaar.list_resources()

    def test_raises_on_404(self) -> None:
        response = _make_http_response(404, {})
        response.text = "not found"
        extended = self._make_extended(response)

        with pytest.raises(ValueError, match="listDiscoveryResources failed \\(404\\)"):
            extended.extensions.bazaar.list_resources()

    def test_sends_bazaar_auth_headers_when_provider_present(self) -> None:
        response = _make_http_response(200, LIST_RESPONSE_FIXTURE)
        client = _make_client()
        http_client = MagicMock()
        http_client.get.return_value = response
        client._get_client.return_value = http_client

        auth_provider = MagicMock()
        auth_headers = MagicMock()
        auth_headers.bazaar = {"Authorization": "Bearer test-token"}
        auth_provider.get_auth_headers.return_value = auth_headers
        client._auth_provider = auth_provider

        extended = with_bazaar(client)
        extended.extensions.bazaar.list_resources()

        call_kwargs = http_client.get.call_args[1]
        assert call_kwargs["headers"]["Authorization"] == "Bearer test-token"

    def test_no_auth_headers_when_no_provider(self) -> None:
        response = _make_http_response(200, LIST_RESPONSE_FIXTURE)
        client = _make_client()
        http_client = MagicMock()
        http_client.get.return_value = response
        client._get_client.return_value = http_client
        client._auth_provider = None

        extended = with_bazaar(client)
        extended.extensions.bazaar.list_resources()

        call_kwargs = http_client.get.call_args[1]
        assert "Authorization" not in call_kwargs["headers"]


# ---------------------------------------------------------------------------
# BazaarExtension.search
# ---------------------------------------------------------------------------


class TestSearch:
    def _make_extended(self, response: MagicMock) -> BazaarExtendedClient:
        client = _make_client()
        http_client = MagicMock()
        http_client.get.return_value = response
        client._get_client.return_value = http_client
        return with_bazaar(client)

    def test_calls_correct_search_endpoint(self) -> None:
        response = _make_http_response(200, SEARCH_RESPONSE_FIXTURE)
        extended = self._make_extended(response)

        extended.extensions.bazaar.search(SearchDiscoveryResourcesParams(query="weather"))

        http_client = extended._client._get_client()
        call_args = http_client.get.call_args
        assert "/discovery/search" in call_args[0][0]

    def test_passes_query_param(self) -> None:
        response = _make_http_response(200, SEARCH_RESPONSE_FIXTURE)
        extended = self._make_extended(response)

        extended.extensions.bazaar.search(SearchDiscoveryResourcesParams(query="weather APIs"))

        http_client = extended._client._get_client()
        call_kwargs = http_client.get.call_args[1]
        assert call_kwargs["params"]["query"] == "weather APIs"

    def test_passes_optional_type_param(self) -> None:
        response = _make_http_response(200, SEARCH_RESPONSE_FIXTURE)
        extended = self._make_extended(response)

        extended.extensions.bazaar.search(
            SearchDiscoveryResourcesParams(query="weather", type="http")
        )

        http_client = extended._client._get_client()
        call_kwargs = http_client.get.call_args[1]
        assert call_kwargs["params"]["type"] == "http"

    def test_passes_limit_and_cursor(self) -> None:
        response = _make_http_response(200, SEARCH_RESPONSE_FIXTURE)
        extended = self._make_extended(response)

        extended.extensions.bazaar.search(
            SearchDiscoveryResourcesParams(query="test", limit=5, cursor="abc123")
        )

        http_client = extended._client._get_client()
        call_kwargs = http_client.get.call_args[1]
        assert call_kwargs["params"]["limit"] == "5"
        assert call_kwargs["params"]["cursor"] == "abc123"

    def test_passes_additional_filters(self) -> None:
        response = _make_http_response(200, SEARCH_RESPONSE_FIXTURE)
        extended = self._make_extended(response)

        extended.extensions.bazaar.search(
            SearchDiscoveryResourcesParams(
                query="test",
                pay_to="0x1234567890123456789012345678901234567890",
                scheme="exact",
                network="eip155:8453",
                extensions="bazaar",
            )
        )

        http_client = extended._client._get_client()
        call_kwargs = http_client.get.call_args[1]
        assert call_kwargs["params"]["payTo"] == "0x1234567890123456789012345678901234567890"
        assert call_kwargs["params"]["scheme"] == "exact"
        assert call_kwargs["params"]["network"] == "eip155:8453"
        assert call_kwargs["params"]["extensions"] == "bazaar"

    def test_returns_parsed_search_response(self) -> None:
        response = _make_http_response(200, SEARCH_RESPONSE_FIXTURE)
        extended = self._make_extended(response)

        result = extended.extensions.bazaar.search(
            SearchDiscoveryResourcesParams(query="weather APIs")
        )

        assert isinstance(result, SearchDiscoveryResourcesResponse)
        assert len(result.resources) == 1
        assert result.resources[0].resource == "https://api.example.com/weather"
        assert result.pagination is not None
        assert result.pagination.limit == 10
        assert result.pagination.cursor is None

    def test_raises_on_empty_query(self) -> None:
        client = _make_client()
        extended = with_bazaar(client)

        with pytest.raises(ValueError, match="search query is required"):
            extended.extensions.bazaar.search(SearchDiscoveryResourcesParams(query=""))

    def test_raises_on_error_response(self) -> None:
        response = _make_http_response(500, {})
        response.text = "search failed"
        extended = self._make_extended(response)

        with pytest.raises(ValueError, match="searchDiscoveryResources failed \\(500\\)"):
            extended.extensions.bazaar.search(SearchDiscoveryResourcesParams(query="test"))

    def test_sends_bazaar_auth_headers(self) -> None:
        response = _make_http_response(200, SEARCH_RESPONSE_FIXTURE)
        client = _make_client()
        http_client = MagicMock()
        http_client.get.return_value = response
        client._get_client.return_value = http_client

        auth_provider = MagicMock()
        auth_headers = MagicMock()
        auth_headers.bazaar = {"X-Api-Key": "secret"}
        auth_provider.get_auth_headers.return_value = auth_headers
        client._auth_provider = auth_provider

        extended = with_bazaar(client)
        extended.extensions.bazaar.search(SearchDiscoveryResourcesParams(query="test"))

        call_kwargs = http_client.get.call_args[1]
        assert call_kwargs["headers"]["X-Api-Key"] == "secret"

    def test_search_without_type_omits_type_from_params(self) -> None:
        response = _make_http_response(200, SEARCH_RESPONSE_FIXTURE)
        extended = self._make_extended(response)

        extended.extensions.bazaar.search(SearchDiscoveryResourcesParams(query="weather"))

        http_client = extended._client._get_client()
        call_kwargs = http_client.get.call_args[1]
        assert "type" not in call_kwargs["params"]

    def test_search_without_cursor_omits_cursor(self) -> None:
        response = _make_http_response(200, SEARCH_RESPONSE_FIXTURE)
        extended = self._make_extended(response)

        extended.extensions.bazaar.search(SearchDiscoveryResourcesParams(query="weather"))

        http_client = extended._client._get_client()
        call_kwargs = http_client.get.call_args[1]
        assert "cursor" not in call_kwargs["params"]

    def test_returns_pagination_object_with_cursor(self) -> None:
        cursor = "eyJwYWdlIjoyfQ=="
        data = {
            "x402Version": 2,
            "resources": [],
            "pagination": {"limit": 10, "cursor": cursor},
        }
        response = _make_http_response(200, data)
        extended = self._make_extended(response)

        result = extended.extensions.bazaar.search(
            SearchDiscoveryResourcesParams(query="financial")
        )

        assert result.pagination is not None
        assert result.pagination.limit == 10
        assert result.pagination.cursor == cursor


# ---------------------------------------------------------------------------
# Real facilitator clients (not MagicMock)
# ---------------------------------------------------------------------------


class _StaticAuth:
    """Auth provider that returns one fixed bazaar header."""

    def __init__(self, header: dict[str, str]) -> None:
        self._header = header

    def get_auth_headers(self) -> AuthHeaders:
        return AuthHeaders(bazaar=dict(self._header))


def _transport_client(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    sync: bool,
    auth: _StaticAuth | None = None,
) -> tuple[BazaarExtendedClient | AsyncBazaarExtendedClient, httpx.Client | httpx.AsyncClient]:
    """Build a real facilitator client whose HTTP stack never leaves the process."""
    transport = httpx.MockTransport(handler)
    config_url = "https://facilitator.example.com"
    if sync:
        http_client: httpx.Client | httpx.AsyncClient = httpx.Client(transport=transport)
        facilitator: HTTPFacilitatorClient | HTTPFacilitatorClientSync = HTTPFacilitatorClientSync(
            FacilitatorConfig(url=config_url, http_client=http_client, auth_provider=auth)
        )
    else:
        http_client = httpx.AsyncClient(transport=transport)
        facilitator = HTTPFacilitatorClient(
            FacilitatorConfig(url=config_url, http_client=http_client, auth_provider=auth)
        )
    return with_bazaar(facilitator), http_client


class TestRealFacilitatorDiscovery:
    """The docs construct HTTPFacilitatorClient. Discovery must await that client."""

    @pytest.mark.asyncio
    async def test_async_client_lists_without_sync_getter(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=LIST_RESPONSE_FIXTURE)

        extended, http_client = _transport_client(handler, sync=False)
        assert isinstance(extended, AsyncBazaarExtendedClient)
        assert isinstance(extended.extensions, AsyncBazaarClientExtension)
        assert isinstance(extended.extensions.bazaar, AsyncBazaarExtension)
        assert not hasattr(extended._client, "_get_client")

        try:
            result = await extended.extensions.bazaar.list_resources(
                ListDiscoveryResourcesParams(type="http", limit=10, offset=5)
            )
        finally:
            await http_client.aclose()

        assert isinstance(result, DiscoveryResourcesResponse)
        assert result.items[0].resource == "https://api.example.com/weather"
        assert result.pagination.total == 1
        assert len(seen) == 1
        assert seen[0].url.path == "/discovery/resources"
        assert seen[0].url.params["type"] == "http"
        assert seen[0].url.params["limit"] == "10"
        assert seen[0].url.params["offset"] == "5"

    @pytest.mark.asyncio
    async def test_async_search_sends_query_and_auth_header(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=SEARCH_RESPONSE_FIXTURE)

        extended, http_client = _transport_client(
            handler,
            sync=False,
            auth=_StaticAuth({"Authorization": "Bearer test-token"}),
        )
        try:
            result = await extended.extensions.bazaar.search(
                SearchDiscoveryResourcesParams(query="weather APIs", type="http")
            )
        finally:
            await http_client.aclose()

        assert result.resources[0].resource == "https://api.example.com/weather"
        assert seen[0].url.path == "/discovery/search"
        assert seen[0].url.params["query"] == "weather APIs"
        assert seen[0].headers["Authorization"] == "Bearer test-token"

    @pytest.mark.asyncio
    async def test_async_list_recovers_after_facilitator_error(self) -> None:
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx.Response(503, text="unavailable")
            return httpx.Response(200, json=LIST_RESPONSE_FIXTURE)

        extended, http_client = _transport_client(handler, sync=False)
        try:
            with pytest.raises(ValueError, match="listDiscoveryResources failed \\(503\\)"):
                await extended.extensions.bazaar.list_resources()
            result = await extended.extensions.bazaar.list_resources(
                ListDiscoveryResourcesParams(type="http")
            )
        finally:
            await http_client.aclose()

        assert calls["n"] == 2
        assert result.pagination.total == 1

    @pytest.mark.asyncio
    async def test_async_empty_search_does_not_call_facilitator(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=SEARCH_RESPONSE_FIXTURE)

        extended, http_client = _transport_client(handler, sync=False)
        try:
            with pytest.raises(ValueError, match="search query is required"):
                await extended.extensions.bazaar.search(SearchDiscoveryResourcesParams(query=""))
        finally:
            await http_client.aclose()

        assert seen == []

    @pytest.mark.asyncio
    async def test_async_search_reports_facilitator_failure(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="search failed")

        extended, http_client = _transport_client(handler, sync=False)
        try:
            with pytest.raises(ValueError, match="searchDiscoveryResources failed \\(500\\)"):
                await extended.extensions.bazaar.search(
                    SearchDiscoveryResourcesParams(query="weather")
                )
        finally:
            await http_client.aclose()

    @pytest.mark.asyncio
    async def test_async_context_delegates_to_facilitator_client(self) -> None:
        facilitator = HTTPFacilitatorClient(
            FacilitatorConfig(url="https://facilitator.example.com")
        )
        extended = with_bazaar(facilitator)
        async with extended as ctx:
            assert ctx is extended
            assert ctx.url == "https://facilitator.example.com"

    def test_sync_client_still_lists_without_await(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=LIST_RESPONSE_FIXTURE)

        extended, http_client = _transport_client(handler, sync=True)
        assert isinstance(extended, BazaarExtendedClient)
        assert isinstance(extended.extensions.bazaar, BazaarExtension)
        assert not hasattr(extended._client, "_get_async_client")
        try:
            result = extended.extensions.bazaar.list_resources(
                ListDiscoveryResourcesParams(type="mcp")
            )
        finally:
            http_client.close()

        assert result.items[0].type == "http"
        assert seen[0].url.path == "/discovery/resources"
        assert seen[0].url.params["type"] == "mcp"

    def test_sync_client_recovers_after_facilitator_error(self) -> None:
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx.Response(404, text="not found")
            return httpx.Response(200, json=SEARCH_RESPONSE_FIXTURE)

        extended, http_client = _transport_client(handler, sync=True)
        try:
            with pytest.raises(ValueError, match="searchDiscoveryResources failed \\(404\\)"):
                extended.extensions.bazaar.search(SearchDiscoveryResourcesParams(query="weather"))
            result = extended.extensions.bazaar.search(
                SearchDiscoveryResourcesParams(query="weather")
            )
        finally:
            http_client.close()

        assert calls["n"] == 2
        assert result.resources[0].resource == "https://api.example.com/weather"


class TestParseDiscoveryResourceItem:
    def test_parses_service_metadata_fields(self) -> None:
        item = {
            "resource": "https://api.example.com/weather",
            "type": "http",
            "x402Version": 2,
            "accepts": [],
            "lastUpdated": "2024-01-01T00:00:00.000Z",
            "description": "Weather data",
            "mimeType": "application/json",
            "serviceName": "Weather API",
            "tags": ["weather", "api"],
            "iconUrl": "https://api.example.com/icon.png",
            "extensions": {
                "bazaar": {
                    "info": {"input": {"type": "http", "method": "GET"}},
                    "schema": {},
                }
            },
        }

        resource = _parse_discovery_resource_item(item)

        assert resource.description == "Weather data"
        assert resource.mime_type == "application/json"
        assert resource.service_name == "Weather API"
        assert resource.tags == ["weather", "api"]
        assert resource.icon_url == "https://api.example.com/icon.png"
        assert resource.extensions == item["extensions"]


class TestDiscoveryResourceSerialization:
    def test_to_dict_includes_service_metadata(self) -> None:
        from x402.extensions.bazaar import DiscoveryResource

        resource = DiscoveryResource(
            resource="https://api.example.com/weather",
            type="http",
            x402_version=2,
            accepts=[],
            last_updated="2024-01-01T00:00:00.000Z",
            description="Weather data",
            mime_type="application/json",
            service_name="Weather API",
            tags=["weather", "api"],
        )

        assert resource.to_dict() == {
            "resource": "https://api.example.com/weather",
            "type": "http",
            "x402Version": 2,
            "accepts": [],
            "lastUpdated": "2024-01-01T00:00:00.000Z",
            "description": "Weather data",
            "mimeType": "application/json",
            "serviceName": "Weather API",
            "tags": ["weather", "api"],
        }
