"""Tests for Bazaar server extension."""

from x402.extensions.bazaar import (
    BAZAAR,
    bazaar_resource_server_extension,
    declare_discovery_extension,
    validate_discovery_extension,
)
from x402.http.types import HTTPRequestContext


class MockHTTPRequest:
    """Mock HTTP request context for testing."""

    def __init__(self, method: str = "GET") -> None:
        self._method = method

    @property
    def method(self) -> str:
        return self._method


class TestBazaarResourceServerExtension:
    """Tests for BazaarResourceServerExtension."""

    def test_extension_key(self) -> None:
        """Test extension key is correct."""
        assert bazaar_resource_server_extension.key == BAZAAR.key

    def test_enrich_with_http_context(self) -> None:
        """Test enriching declaration with HTTP context."""
        ext = declare_discovery_extension(
            input={"query": "test"},
        )
        declaration = ext[BAZAAR.key]

        # Convert to dict if needed
        if hasattr(declaration, "model_dump"):
            declaration = declaration.model_dump(by_alias=True)

        context = MockHTTPRequest(method="GET")
        enriched = bazaar_resource_server_extension.enrich_declaration(declaration, context)

        assert enriched["info"]["input"]["method"] == "GET"

    def test_enrich_post_method(self) -> None:
        """Test enriching with POST method."""
        ext = declare_discovery_extension(
            input={"data": "test"},
            body_type="json",
        )
        declaration = ext[BAZAAR.key]

        if hasattr(declaration, "model_dump"):
            declaration = declaration.model_dump(by_alias=True)

        context = MockHTTPRequest(method="POST")
        enriched = bazaar_resource_server_extension.enrich_declaration(declaration, context)

        assert enriched["info"]["input"]["method"] == "POST"

    def test_enrich_then_validate_get(self) -> None:
        """Test that declaring without method, then enriching, produces a valid extension."""
        ext = declare_discovery_extension(
            input={"query": "test"},
            input_schema={"properties": {"query": {"type": "string"}}},
        )
        declaration = ext[BAZAAR.key]

        if hasattr(declaration, "model_dump"):
            declaration = declaration.model_dump(by_alias=True)

        # Pre-enrichment: validation should fail (method missing)
        pre_result = validate_discovery_extension(declaration)
        assert pre_result.valid is False

        context = MockHTTPRequest(method="GET")
        enriched = bazaar_resource_server_extension.enrich_declaration(declaration, context)

        # Post-enrichment: validation should pass
        post_result = validate_discovery_extension(enriched)
        assert post_result.valid is True, (
            f"enriched GET extension should pass: {post_result.errors}"
        )

    def test_enrich_then_validate_post(self) -> None:
        """Test that declaring without method, then enriching, produces a valid extension."""
        ext = declare_discovery_extension(
            input={"data": "test"},
            input_schema={"properties": {"data": {"type": "string"}}},
            body_type="json",
        )
        declaration = ext[BAZAAR.key]

        if hasattr(declaration, "model_dump"):
            declaration = declaration.model_dump(by_alias=True)

        pre_result = validate_discovery_extension(declaration)
        assert pre_result.valid is False

        context = MockHTTPRequest(method="POST")
        enriched = bazaar_resource_server_extension.enrich_declaration(declaration, context)

        post_result = validate_discovery_extension(enriched)
        assert post_result.valid is True, (
            f"enriched POST extension should pass: {post_result.errors}"
        )

    def test_enrich_no_context(self) -> None:
        """Test enriching without HTTP context returns unchanged."""
        ext = declare_discovery_extension(
            input={"query": "test"},
        )
        declaration = ext[BAZAAR.key]

        if hasattr(declaration, "model_dump"):
            declaration = declaration.model_dump(by_alias=True)

        # Pass None context
        enriched = bazaar_resource_server_extension.enrich_declaration(declaration, None)

        # Should return unchanged (no method injection)
        assert enriched == declaration

    def test_enrich_invalid_context(self) -> None:
        """Test enriching with invalid context returns unchanged."""
        ext = declare_discovery_extension(
            input={"query": "test"},
        )
        declaration = ext[BAZAAR.key]

        if hasattr(declaration, "model_dump"):
            declaration = declaration.model_dump(by_alias=True)

        # Pass an object without method attribute
        enriched = bazaar_resource_server_extension.enrich_declaration(
            declaration, {"not_a_request": True}
        )

        assert enriched == declaration

    def test_schema_requires_method_after_enrich(self) -> None:
        """Test that schema requires method after enrichment."""
        ext = declare_discovery_extension(
            input={"query": "test"},
        )
        declaration = ext[BAZAAR.key]

        if hasattr(declaration, "model_dump"):
            declaration = declaration.model_dump(by_alias=True)

        context = MockHTTPRequest(method="DELETE")
        enriched = bazaar_resource_server_extension.enrich_declaration(declaration, context)

        schema = enriched.get("schema", {})
        input_schema = schema.get("properties", {}).get("input", {})
        required = input_schema.get("required", [])
        assert "method" in required

    def test_enrich_preserves_existing_data(self) -> None:
        """Test that enrichment preserves existing declaration data."""
        ext = declare_discovery_extension(
            input={"city": "San Francisco", "units": "celsius"},
            input_schema={
                "properties": {
                    "city": {"type": "string"},
                    "units": {"type": "string"},
                },
            },
        )
        declaration = ext[BAZAAR.key]

        if hasattr(declaration, "model_dump"):
            declaration = declaration.model_dump(by_alias=True)

        context = MockHTTPRequest(method="GET")
        enriched = bazaar_resource_server_extension.enrich_declaration(declaration, context)

        # Check original data preserved
        assert enriched["info"]["input"]["type"] == "http"
        # Check queryParams preserved
        query_params = enriched["info"]["input"].get("queryParams")
        if query_params:
            assert "city" in query_params or "city" in str(query_params)


class MockAdapter:
    """Mock HTTP adapter with configurable path."""

    def __init__(self, path: str) -> None:
        self._path = path

    def get_path(self) -> str:
        return self._path


class TestBazaarDynamicRoutes:
    """Tests for dynamic route pattern handling in BazaarResourceServerExtension."""

    def _prepare_declaration(self, ext: dict) -> dict:
        declaration = ext[BAZAAR.key]
        if hasattr(declaration, "model_dump"):
            declaration = declaration.model_dump(by_alias=True)
        return declaration

    def test_static_route_leaves_extension_unchanged(self) -> None:
        """Static routes should not produce a routeTemplate."""
        ext = declare_discovery_extension(input={"query": "test"})
        declaration = self._prepare_declaration(ext)

        context = HTTPRequestContext(
            method="GET", adapter=MockAdapter("/users"), path="/users", route_pattern="/users"
        )
        enriched = bazaar_resource_server_extension.enrich_declaration(declaration, context)

        assert "routeTemplate" not in enriched

    def test_dynamic_route_produces_route_template(self) -> None:
        """Dynamic route should produce routeTemplate with :param syntax."""
        ext = declare_discovery_extension(input={})
        declaration = self._prepare_declaration(ext)

        context = HTTPRequestContext(
            method="GET",
            adapter=MockAdapter("/users/123"),
            path="/users/123",
            route_pattern="/users/[userId]",
        )
        enriched = bazaar_resource_server_extension.enrich_declaration(declaration, context)

        assert enriched.get("routeTemplate") == "/users/:userId"

    def test_path_params_extracted_from_concrete_url(self) -> None:
        """Path params should be extracted from the concrete URL path."""
        ext = declare_discovery_extension(input={})
        declaration = self._prepare_declaration(ext)

        context = HTTPRequestContext(
            method="GET",
            adapter=MockAdapter("/users/123"),
            path="/users/123",
            route_pattern="/users/[userId]",
        )
        enriched = bazaar_resource_server_extension.enrich_declaration(declaration, context)

        path_params = enriched["info"]["input"].get("pathParams")
        assert path_params == {"userId": "123"}

    def test_multiple_path_params_extracted(self) -> None:
        """Multiple path params should all be extracted."""
        ext = declare_discovery_extension(input={})
        declaration = self._prepare_declaration(ext)

        context = HTTPRequestContext(
            method="GET",
            adapter=MockAdapter("/users/42/posts/7"),
            path="/users/42/posts/7",
            route_pattern="/users/[userId]/posts/[postId]",
        )
        enriched = bazaar_resource_server_extension.enrich_declaration(declaration, context)

        assert enriched.get("routeTemplate") == "/users/:userId/posts/:postId"
        path_params = enriched["info"]["input"].get("pathParams")
        assert path_params == {"userId": "42", "postId": "7"}

    def test_mismatched_pattern_and_path_returns_empty_params(self) -> None:
        """extractPathParams returns {} gracefully when pattern and URL path are structurally different.

        This can occur in production if middleware and extension patterns diverge (e.g. the
        route is mounted at a different prefix than the extension expects).
        """
        ext = declare_discovery_extension(input={})
        declaration = self._prepare_declaration(ext)

        # Pattern expects /users/[userId] but adapter path is /api/other — fewer segments.
        context = HTTPRequestContext(
            method="GET",
            adapter=MockAdapter("/api/other"),
            path="/api/other",
            route_pattern="/users/[userId]",
        )
        enriched = bazaar_resource_server_extension.enrich_declaration(declaration, context)

        # routeTemplate is still produced (pattern contains a bracket param), but pathParams is empty
        assert enriched.get("routeTemplate") == "/users/:userId"
        path_params = enriched["info"]["input"].get("pathParams")
        assert path_params == {}

    def test_colon_param_route_produces_route_template(self) -> None:
        """Routes with :param syntax should produce routeTemplate."""
        ext = declare_discovery_extension(input={})
        declaration = self._prepare_declaration(ext)

        context = HTTPRequestContext(
            method="GET",
            adapter=MockAdapter("/users/123"),
            path="/users/123",
            route_pattern="/users/:userId",
        )
        enriched = bazaar_resource_server_extension.enrich_declaration(declaration, context)

        assert enriched.get("routeTemplate") == "/users/:userId"

    def test_colon_param_extracts_path_params(self) -> None:
        """:param patterns should extract pathParams from the URL."""
        ext = declare_discovery_extension(input={})
        declaration = self._prepare_declaration(ext)

        context = HTTPRequestContext(
            method="GET",
            adapter=MockAdapter("/users/42/posts/7"),
            path="/users/42/posts/7",
            route_pattern="/users/:userId/posts/:postId",
        )
        enriched = bazaar_resource_server_extension.enrich_declaration(declaration, context)

        assert enriched.get("routeTemplate") == "/users/:userId/posts/:postId"
        path_params = enriched["info"]["input"].get("pathParams")
        assert path_params == {"userId": "42", "postId": "7"}

    def test_mixed_bracket_and_colon_params(self) -> None:
        """Mixed [param] and :param should normalize to :param and extract all values."""
        ext = declare_discovery_extension(input={})
        declaration = self._prepare_declaration(ext)

        context = HTTPRequestContext(
            method="GET",
            adapter=MockAdapter("/users/42/posts/7"),
            path="/users/42/posts/7",
            route_pattern="/users/[userId]/posts/:postId",
        )
        enriched = bazaar_resource_server_extension.enrich_declaration(declaration, context)

        assert enriched.get("routeTemplate") == "/users/:userId/posts/:postId"
        path_params = enriched["info"]["input"].get("pathParams")
        assert path_params == {"userId": "42", "postId": "7"}

    def test_wildcard_auto_converts_to_var_params(self) -> None:
        """Wildcard * segments should auto-convert to :var1, :var2, etc."""
        ext = declare_discovery_extension(input={})
        declaration = self._prepare_declaration(ext)

        context = HTTPRequestContext(
            method="GET",
            adapter=MockAdapter("/weather/san-francisco"),
            path="/weather/san-francisco",
            route_pattern="/weather/*",
        )
        enriched = bazaar_resource_server_extension.enrich_declaration(declaration, context)

        assert enriched.get("routeTemplate") == "/weather/:var1"
        path_params = enriched["info"]["input"].get("pathParams")
        assert path_params == {"var1": "san-francisco"}

    def test_multiple_wildcards_auto_convert(self) -> None:
        """Multiple * segments should become :var1, :var2, :var3, etc."""
        ext = declare_discovery_extension(input={})
        declaration = self._prepare_declaration(ext)

        context = HTTPRequestContext(
            method="GET",
            adapter=MockAdapter("/api/users/42/posts/7"),
            path="/api/users/42/posts/7",
            route_pattern="/api/*/*/posts/*",
        )
        enriched = bazaar_resource_server_extension.enrich_declaration(declaration, context)

        assert enriched.get("routeTemplate") == "/api/:var1/:var2/posts/:var3"
