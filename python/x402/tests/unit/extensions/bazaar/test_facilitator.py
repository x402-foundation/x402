"""Tests for Bazaar facilitator functions."""

from x402.extensions.bazaar import (
    BAZAAR,
    BodyDiscoveryInfo,
    QueryDiscoveryInfo,
    declare_discovery_extension,
    extract_discovery_info,
    extract_discovery_info_from_extension,
    validate_and_extract,
    validate_discovery_extension,
)
from x402.extensions.bazaar.facilitator import (
    _is_valid_icon_url,
    _is_valid_route_template,
    _is_valid_service_name,
    _sanitize_resource_service_metadata,
    _sanitize_tags,
)
from x402.extensions.bazaar.resource_service import (
    DeclareMcpDiscoveryConfig,
    declare_mcp_discovery_extension,
)
from x402.extensions.bazaar.types import McpDiscoveryInfo


class TestIsValidRouteTemplate:
    """Direct unit tests for the _is_valid_route_template helper."""

    def test_returns_false_for_none_input(self) -> None:
        assert _is_valid_route_template(None) is False

    def test_returns_false_for_empty_string(self) -> None:
        assert _is_valid_route_template("") is False

    def test_returns_false_for_paths_not_starting_with_slash(self) -> None:
        assert _is_valid_route_template("users/123") is False
        assert _is_valid_route_template("relative/path") is False
        assert _is_valid_route_template("no-slash") is False

    def test_returns_false_for_paths_containing_dotdot(self) -> None:
        assert _is_valid_route_template("/users/../admin") is False
        assert _is_valid_route_template("/../etc/passwd") is False
        assert _is_valid_route_template("/users/..") is False

    def test_returns_false_for_paths_containing_scheme(self) -> None:
        assert _is_valid_route_template("http://evil.com/path") is False
        assert _is_valid_route_template("/users/http://evil") is False
        assert _is_valid_route_template("javascript://foo") is False

    def test_returns_true_for_valid_paths(self) -> None:
        assert _is_valid_route_template("/users/:userId") is True
        assert _is_valid_route_template("/api/v1/items") is True
        assert _is_valid_route_template("/products/:productId/reviews/:reviewId") is True
        assert _is_valid_route_template("/weather/:country/:city") is True

    def test_returns_false_for_paths_with_spaces_or_invalid_chars(self) -> None:
        assert _is_valid_route_template("/users/ bad") is False
        assert _is_valid_route_template("/path with spaces") is False

    def test_dotdot_segment_prefix_is_rejected(self) -> None:
        assert _is_valid_route_template("/users/..hidden") is False

    def test_rejects_percent_encoded_traversal_sequences(self) -> None:
        assert _is_valid_route_template("/users/%2e%2e/admin") is False
        assert _is_valid_route_template("/users/%2E%2E/admin") is False


class TestValidateDiscoveryExtension:
    """Tests for validate_discovery_extension function."""

    def test_valid_query_extension(self) -> None:
        """Test validating a valid query extension (enriched with method per spec)."""
        ext = declare_discovery_extension(
            input={"query": "test"},
            input_schema={"properties": {"query": {"type": "string"}}},
        )
        inner = ext[BAZAAR.key]
        inner["info"]["input"]["method"] = "GET"

        result = validate_discovery_extension(inner)
        assert result.valid is True
        assert len(result.errors) == 0

    def test_valid_body_extension(self) -> None:
        """Test validating a valid body extension (enriched with method per spec)."""
        ext = declare_discovery_extension(
            input={"data": "test"},
            input_schema={"properties": {"data": {"type": "string"}}},
            body_type="json",
        )
        inner = ext[BAZAAR.key]
        inner["info"]["input"]["method"] = "POST"

        result = validate_discovery_extension(inner)
        assert result.valid is True

    def test_method_required_enforcement(self) -> None:
        """Test that validation fails when method is absent per spec."""
        ext = declare_discovery_extension(
            input={"query": "test"},
            input_schema={"properties": {"query": {"type": "string"}}},
        )

        result = validate_discovery_extension(ext[BAZAAR.key])
        assert result.valid is False
        assert any("method" in e for e in result.errors)


class TestExtractDiscoveryInfo:
    """Tests for extract_discovery_info function."""

    def test_extract_v2_query_extension(self) -> None:
        """Test extracting discovery info from v2 payload with query extension."""
        ext = declare_discovery_extension(
            input={"city": "SF"},
            input_schema={"properties": {"city": {"type": "string"}}},
        )

        # Convert extension to dict format for payload
        ext_dict = ext[BAZAAR.key]
        if hasattr(ext_dict, "model_dump"):
            ext_dict = ext_dict.model_dump(by_alias=True)
        ext_dict["info"]["input"]["method"] = "GET"

        payload = {
            "x402Version": 2,
            "resource": {"url": "https://api.example.com/weather"},
            "extensions": {BAZAAR.key: ext_dict},
            "accepted": {},
        }
        requirements = {"scheme": "exact", "network": "eip155:8453"}

        result = extract_discovery_info(payload, requirements)

        assert result is not None
        assert result.resource_url == "https://api.example.com/weather"
        assert result.x402_version == 2
        assert isinstance(result.discovery_info, QueryDiscoveryInfo)

    def test_extract_v2_body_extension(self) -> None:
        """Test extracting discovery info from v2 payload with body extension."""
        ext = declare_discovery_extension(
            input={"text": "hello"},
            body_type="json",
        )

        ext_dict = ext[BAZAAR.key]
        if hasattr(ext_dict, "model_dump"):
            ext_dict = ext_dict.model_dump(by_alias=True)
        ext_dict["info"]["input"]["method"] = "POST"

        payload = {
            "x402Version": 2,
            "resource": {"url": "https://api.example.com/translate"},
            "extensions": {BAZAAR.key: ext_dict},
            "accepted": {},
        }
        requirements = {}

        result = extract_discovery_info(payload, requirements)

        assert result is not None
        assert isinstance(result.discovery_info, BodyDiscoveryInfo)

    def test_extract_missing_extension(self) -> None:
        """Test extracting when no bazaar extension is present."""
        payload = {
            "x402Version": 2,
            "resource": {"url": "https://api.example.com/data"},
            "extensions": {},
            "accepted": {},
        }
        requirements = {}

        result = extract_discovery_info(payload, requirements)
        assert result is None

    def test_extract_no_extensions(self) -> None:
        """Test extracting when extensions field is missing."""
        payload = {
            "x402Version": 2,
            "resource": {"url": "https://api.example.com/data"},
            "accepted": {},
        }
        requirements = {}

        result = extract_discovery_info(payload, requirements)
        assert result is None

    def test_extract_v2_mcp_extension_with_empty_method(self) -> None:
        """MCP discovery should not depend on HTTP method being present."""
        payload = {
            "x402Version": 2,
            "resource": {"url": "https://api.example.com/mcp"},
            "extensions": {
                BAZAAR.key: {
                    "info": {
                        "input": {
                            "type": "mcp",
                            "method": "",
                            "toolName": "search_tool",
                            "inputSchema": {"type": "object"},
                        },
                    },
                    "schema": {},
                }
            },
            "accepted": {},
        }

        result = extract_discovery_info(payload, {}, validate=False)

        assert result is not None
        assert result.resource_url == "https://api.example.com/mcp"

    def test_strip_query_params_from_v2_resource_url(self) -> None:
        """Test that query params are stripped from v2 resourceUrl."""
        ext = declare_discovery_extension(
            input={"city": "NYC"},
            input_schema={"properties": {"city": {"type": "string"}}},
        )

        ext_dict = ext[BAZAAR.key]
        if hasattr(ext_dict, "model_dump"):
            ext_dict = ext_dict.model_dump(by_alias=True)
        ext_dict["info"]["input"]["method"] = "GET"

        payload = {
            "x402Version": 2,
            "resource": {"url": "https://api.example.com/weather?city=NYC&units=metric"},
            "extensions": {BAZAAR.key: ext_dict},
            "accepted": {},
        }

        result = extract_discovery_info(payload, {})

        assert result is not None
        assert result.resource_url == "https://api.example.com/weather"

    def test_strip_hash_sections_from_v2_resource_url(self) -> None:
        """Test that hash sections are stripped from v2 resourceUrl."""
        ext = declare_discovery_extension(
            input={},
            input_schema={"properties": {}},
        )

        ext_dict = ext[BAZAAR.key]
        if hasattr(ext_dict, "model_dump"):
            ext_dict = ext_dict.model_dump(by_alias=True)
        ext_dict["info"]["input"]["method"] = "GET"

        payload = {
            "x402Version": 2,
            "resource": {"url": "https://api.example.com/docs#section-1"},
            "extensions": {BAZAAR.key: ext_dict},
            "accepted": {},
        }

        result = extract_discovery_info(payload, {})

        assert result is not None
        assert result.resource_url == "https://api.example.com/docs"

    def test_strip_query_params_and_hash_from_v2_resource_url(self) -> None:
        """Test that both query params and hash sections are stripped from v2 resourceUrl."""
        ext = declare_discovery_extension(
            input={},
            input_schema={"properties": {}},
        )

        ext_dict = ext[BAZAAR.key]
        if hasattr(ext_dict, "model_dump"):
            ext_dict = ext_dict.model_dump(by_alias=True)
        ext_dict["info"]["input"]["method"] = "GET"

        payload = {
            "x402Version": 2,
            "resource": {"url": "https://api.example.com/page?foo=bar#anchor"},
            "extensions": {BAZAAR.key: ext_dict},
            "accepted": {},
        }

        result = extract_discovery_info(payload, {})

        assert result is not None
        assert result.resource_url == "https://api.example.com/page"

    def test_strip_query_params_from_v1_resource_url(self) -> None:
        """Test that query params are stripped from v1 resourceUrl."""
        v1_requirements = {
            "scheme": "exact",
            "network": "eip155:8453",
            "maxAmountRequired": "10000",
            "resource": "https://api.example.com/search?q=test&page=1",
            "description": "Search",
            "mimeType": "application/json",
            "outputSchema": {
                "input": {
                    "type": "http",
                    "method": "GET",
                    "discoverable": True,
                    "queryParams": {"q": "string", "page": "number"},
                },
            },
            "payTo": "0x...",
            "maxTimeoutSeconds": 300,
            "asset": "0x...",
            "extra": {},
        }

        v1_payload = {
            "x402Version": 1,
            "scheme": "exact",
            "network": "eip155:8453",
            "payload": {},
        }

        result = extract_discovery_info(v1_payload, v1_requirements)

        assert result is not None
        assert result.resource_url == "https://api.example.com/search"

    def test_strip_hash_sections_from_v1_resource_url(self) -> None:
        """Test that hash sections are stripped from v1 resourceUrl."""
        v1_requirements = {
            "scheme": "exact",
            "network": "eip155:8453",
            "maxAmountRequired": "10000",
            "resource": "https://api.example.com/docs#section",
            "description": "Docs",
            "mimeType": "application/json",
            "outputSchema": {
                "input": {
                    "type": "http",
                    "method": "GET",
                    "discoverable": True,
                },
            },
            "payTo": "0x...",
            "maxTimeoutSeconds": 300,
            "asset": "0x...",
            "extra": {},
        }

        v1_payload = {
            "x402Version": 1,
            "scheme": "exact",
            "network": "eip155:8453",
            "payload": {},
        }

        result = extract_discovery_info(v1_payload, v1_requirements)

        assert result is not None
        assert result.resource_url == "https://api.example.com/docs"


class TestExtractDiscoveryInfoFromExtension:
    """Tests for extract_discovery_info_from_extension function."""

    def test_extract_valid_extension(self) -> None:
        """Test extracting info from a valid extension."""
        ext = declare_discovery_extension(
            input={"q": "test"},
        )
        inner = ext[BAZAAR.key]
        inner["info"]["input"]["method"] = "GET"

        info = extract_discovery_info_from_extension(inner)
        assert isinstance(info, QueryDiscoveryInfo)

    def test_extract_without_validation(self) -> None:
        """Test extracting info without validation."""
        ext = declare_discovery_extension(
            input={"q": "test"},
        )

        info = extract_discovery_info_from_extension(ext[BAZAAR.key], validate=False)
        assert info is not None


class TestValidateAndExtract:
    """Tests for validate_and_extract function."""

    def test_valid_extension(self) -> None:
        """Test validate_and_extract with valid extension."""
        ext = declare_discovery_extension(
            input={"query": "test"},
        )
        inner = ext[BAZAAR.key]
        inner["info"]["input"]["method"] = "GET"

        result = validate_and_extract(inner)
        assert result.valid is True
        assert result.info is not None
        assert len(result.errors) == 0

    def test_returns_info_on_success(self) -> None:
        """Test that info is returned on successful validation."""
        ext = declare_discovery_extension(
            input={"name": "test"},
            body_type="json",
        )
        inner = ext[BAZAAR.key]
        inner["info"]["input"]["method"] = "POST"

        result = validate_and_extract(inner)
        assert result.valid is True
        assert isinstance(result.info, BodyDiscoveryInfo)


class TestDynamicRoutesFacilitator:
    """Tests for dynamic route handling in the facilitator."""

    def test_route_template_used_for_canonical_url(self) -> None:
        """When routeTemplate is present, it should override the concrete URL path."""
        ext = declare_discovery_extension(input={})
        declaration = ext[BAZAAR.key]
        if hasattr(declaration, "model_dump"):
            declaration = declaration.model_dump(by_alias=True)
        # Inject method/routeTemplate/pathParams as the server extension would at request time
        declaration["info"]["input"]["method"] = "GET"
        declaration["routeTemplate"] = "/users/:userId"
        declaration["info"]["input"]["pathParams"] = {"userId": "123"}

        payload = {
            "x402Version": 2,
            "scheme": "exact",
            "network": "eip155:8453",
            "payload": {},
            "accepted": {},
            "resource": {"url": "http://example.com/users/123"},
            "extensions": {BAZAAR.key: declaration},
        }

        discovered = extract_discovery_info(payload, {}, validate=False)

        assert discovered is not None
        assert discovered.resource_url == "http://example.com/users/:userId"
        assert discovered.route_template == "/users/:userId"

    def test_static_route_uses_concrete_url(self) -> None:
        """Without routeTemplate, the stripped concrete URL should be used."""
        ext = declare_discovery_extension(
            input={"query": "test"},
            input_schema={"properties": {"query": {"type": "string"}}},
        )
        declaration = ext[BAZAAR.key]
        if hasattr(declaration, "model_dump"):
            declaration = declaration.model_dump(by_alias=True)
        declaration["info"]["input"]["method"] = "GET"

        payload = {
            "x402Version": 2,
            "scheme": "exact",
            "network": "eip155:8453",
            "payload": {},
            "accepted": {},
            "resource": {"url": "http://example.com/search?q=test"},
            "extensions": {BAZAAR.key: declaration},
        }

        discovered = extract_discovery_info(payload, {}, validate=False)

        assert discovered is not None
        assert discovered.resource_url == "http://example.com/search"
        assert discovered.route_template is None


class TestExtractDiscoveryInfoMCP:
    """Tests for MCP resource extraction via extract_discovery_info."""

    def test_extract_v2_mcp_extension_populates_tool_name(self) -> None:
        """MCP extensions should populate tool_name, not method."""
        ext = declare_mcp_discovery_extension(
            DeclareMcpDiscoveryConfig(
                tool_name="search_tool",
                input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
            )
        )

        payload = {
            "x402Version": 2,
            "resource": {"url": "https://api.example.com/mcp"},
            "extensions": {BAZAAR.key: ext[BAZAAR.key]},
            "accepted": {},
        }

        result = extract_discovery_info(payload, {}, validate=False)

        assert result is not None
        assert result.tool_name == "search_tool"
        assert result.method == ""
        assert result.resource_url == "https://api.example.com/mcp"
        assert isinstance(result.discovery_info, McpDiscoveryInfo)

    def test_extract_v2_mcp_extension_with_empty_method_field(self) -> None:
        """MCP payloads with an explicit empty method field should still extract correctly."""
        payload = {
            "x402Version": 2,
            "resource": {"url": "https://api.example.com/mcp"},
            "extensions": {
                BAZAAR.key: {
                    "info": {
                        "input": {
                            "type": "mcp",
                            "method": "",
                            "toolName": "search_tool",
                            "inputSchema": {"type": "object"},
                        },
                    },
                    "schema": {},
                }
            },
            "accepted": {},
        }

        result = extract_discovery_info(payload, {}, validate=False)

        assert result is not None
        assert result.tool_name == "search_tool"
        assert result.method == ""

    def test_extract_v2_mcp_does_not_return_unknown_method(self) -> None:
        """MCP resources must never surface method='UNKNOWN' — only empty string."""
        ext = declare_mcp_discovery_extension(
            DeclareMcpDiscoveryConfig(
                tool_name="my_tool",
                input_schema={"type": "object"},
            )
        )

        payload = {
            "x402Version": 2,
            "resource": {"url": "https://api.example.com/mcp"},
            "extensions": {BAZAAR.key: ext[BAZAAR.key]},
            "accepted": {},
        }

        result = extract_discovery_info(payload, {}, validate=False)

        assert result is not None
        assert result.method != "UNKNOWN"
        assert result.method == ""

    def test_http_resource_with_no_method_returns_none(self) -> None:
        """HTTP resources with no method set must not silently produce a result."""
        payload = {
            "x402Version": 2,
            "resource": {"url": "https://api.example.com/data"},
            "extensions": {
                BAZAAR.key: {
                    "info": {
                        "input": {
                            "type": "http",
                            # method intentionally absent
                            "queryParams": {"q": "test"},
                        },
                    },
                    "schema": {},
                }
            },
            "accepted": {},
        }

        result = extract_discovery_info(payload, {}, validate=False)

        assert result is None

    def test_http_resource_with_empty_method_string_returns_none(self) -> None:
        """HTTP resources with an explicit empty method string must not silently produce a result."""
        payload = {
            "x402Version": 2,
            "resource": {"url": "https://api.example.com/data"},
            "extensions": {
                BAZAAR.key: {
                    "info": {
                        "input": {
                            "type": "http",
                            "method": "",
                        },
                    },
                    "schema": {},
                }
            },
            "accepted": {},
        }

        result = extract_discovery_info(payload, {}, validate=False)

        assert result is None


class TestIsValidServiceName:
    """Direct unit tests for the _is_valid_service_name helper."""

    def test_accepts_strings_up_to_32_chars(self) -> None:
        assert _is_valid_service_name("Example Weather") is True
        assert _is_valid_service_name("a") is True
        assert _is_valid_service_name("a" * 32) is True

    def test_rejects_empty_none_and_over_cap(self) -> None:
        assert _is_valid_service_name(None) is False
        assert _is_valid_service_name("") is False
        assert _is_valid_service_name("a" * 33) is False

    def test_rejects_non_string(self) -> None:
        assert _is_valid_service_name(42) is False
        assert _is_valid_service_name(["x"]) is False

    def test_rejects_non_ascii_characters(self) -> None:
        # Multi-byte chars in UTF-8 — would otherwise diverge across SDKs
        # (UTF-16 code units in TS, code points here, bytes in Go).
        assert _is_valid_service_name("Café Service") is False
        assert _is_valid_service_name("東京 Weather") is False
        assert _is_valid_service_name("🚀 Service") is False

    def test_rejects_ascii_control_characters(self) -> None:
        assert _is_valid_service_name("Service\x00") is False
        assert _is_valid_service_name("Line\nBreak") is False
        assert _is_valid_service_name("Tab\there") is False

    def test_accepts_printable_ascii_with_spaces_and_punctuation(self) -> None:
        assert _is_valid_service_name("Example Weather") is True
        assert _is_valid_service_name("AT&T") is True
        assert _is_valid_service_name("Coinbase, Inc.") is True
        assert _is_valid_service_name("Service v2.0!") is True


class TestSanitizeTags:
    """Direct unit tests for the _sanitize_tags helper."""

    def test_returns_none_for_non_lists(self) -> None:
        assert _sanitize_tags(None) is None
        assert _sanitize_tags("weather") is None
        assert _sanitize_tags({"tag": "weather"}) is None

    def test_drops_invalid_entries(self) -> None:
        result = _sanitize_tags(["weather", "", "a" * 33, 42, None, "forecast"])
        assert result == ["weather", "forecast"]

    def test_truncates_to_5_entries(self) -> None:
        result = _sanitize_tags(["a", "b", "c", "d", "e", "f", "g"])
        assert result == ["a", "b", "c", "d", "e"]

    def test_returns_none_when_nothing_survives(self) -> None:
        assert _sanitize_tags(["", "a" * 33, 7]) is None
        assert _sanitize_tags([]) is None

    def test_drops_non_ascii_tags_but_keeps_ascii_siblings(self) -> None:
        result = _sanitize_tags(["weather", "café", "東京", "🚀", "forecast"])
        assert result == ["weather", "forecast"]

    def test_dedupes_case_insensitively_keeping_first_occurrence(self) -> None:
        result = _sanitize_tags(["Weather", "weather", "WEATHER", "forecast"])
        assert result == ["Weather", "forecast"]


class TestIsValidIconUrl:
    """Direct unit tests for the _is_valid_icon_url helper."""

    def test_accepts_plain_http_and_https_urls(self) -> None:
        assert _is_valid_icon_url("https://api.example.com/icon.png") is True
        assert _is_valid_icon_url("http://api.example.com/icon") is True

    def test_rejects_empty_none_and_over_cap(self) -> None:
        assert _is_valid_icon_url(None) is False
        assert _is_valid_icon_url("") is False
        assert _is_valid_icon_url("https://example.com/" + "a" * 2048) is False

    def test_rejects_non_http_schemes(self) -> None:
        assert _is_valid_icon_url("data:image/png;base64,iVBOR") is False
        assert _is_valid_icon_url("file:///etc/passwd") is False
        assert _is_valid_icon_url("javascript:alert(1)") is False
        assert _is_valid_icon_url("ftp://example.com/icon.png") is False

    def test_rejects_userinfo(self) -> None:
        assert _is_valid_icon_url("https://user@example.com/icon.png") is False
        assert _is_valid_icon_url("https://user:pass@example.com/icon.png") is False

    def test_rejects_ip_literals(self) -> None:
        assert _is_valid_icon_url("http://10.0.0.1/icon.png") is False
        assert _is_valid_icon_url("http://127.0.0.1/icon.png") is False
        assert _is_valid_icon_url("http://[::1]/icon.png") is False
        assert _is_valid_icon_url("http://[2001:db8::1]/icon.png") is False

    def test_rejects_decimal_and_short_form_ip_hosts(self) -> None:
        # 2130706433 == 127.0.0.1; 0 expands to 0.0.0.0 on Linux.
        assert _is_valid_icon_url("http://2130706433/icon.png") is False
        assert _is_valid_icon_url("http://0/icon.png") is False
        assert _is_valid_icon_url("http://3232235521/icon.png") is False

    def test_rejects_hex_encoded_ip_hosts(self) -> None:
        # 0x7f000001 == 127.0.0.1.
        assert _is_valid_icon_url("http://0x7f000001/icon.png") is False
        assert _is_valid_icon_url("http://0X7F000001/icon.png") is False

    def test_rejects_localhost(self) -> None:
        assert _is_valid_icon_url("http://localhost/icon.png") is False
        assert _is_valid_icon_url("http://LOCALHOST/icon.png") is False

    def test_rejects_loopback_aliases(self) -> None:
        assert _is_valid_icon_url("http://localhost.localdomain/icon.png") is False
        assert _is_valid_icon_url("http://ip6-localhost/icon.png") is False
        assert _is_valid_icon_url("http://ip6-loopback/icon.png") is False

    def test_rejects_idn_full_width_localhost_confusables(self) -> None:
        # Full-width Latin "ｌｏｃａｌｈｏｓｔ" normalizes to "localhost" via UTS #46.
        assert _is_valid_icon_url("http://ｌｏｃａｌｈｏｓｔ/icon.png") is False

    def test_rejects_control_characters(self) -> None:
        assert _is_valid_icon_url("https://example.com/\x00icon.png") is False
        assert _is_valid_icon_url("https://example.com/icon\n.png") is False
        assert _is_valid_icon_url("https://example.com/icon\x7f.png") is False

    def test_rejects_relative_paths(self) -> None:
        assert _is_valid_icon_url("/icon.png") is False
        assert _is_valid_icon_url("icon.png") is False


class TestSanitizeResourceServiceMetadata:
    """Direct unit tests for the _sanitize_resource_service_metadata helper."""

    def test_preserves_all_valid_fields(self) -> None:
        out = _sanitize_resource_service_metadata(
            {
                "url": "https://api.example.com/x",
                "serviceName": "Example Weather",
                "tags": ["weather", "forecast"],
                "iconUrl": "https://api.example.com/icon.png",
            }
        )
        assert out.service_name == "Example Weather"
        assert out.tags == ["weather", "forecast"]
        assert out.icon_url == "https://api.example.com/icon.png"

    def test_soft_drops_only_invalid_fields(self) -> None:
        out = _sanitize_resource_service_metadata(
            {
                "serviceName": "a" * 33,
                "tags": ["weather", "forecast"],
                "iconUrl": "data:image/png;base64,iVBOR",
            }
        )
        assert out.service_name is None
        assert out.tags == ["weather", "forecast"]
        assert out.icon_url is None

    def test_accepts_snake_case_keys(self) -> None:
        out = _sanitize_resource_service_metadata(
            {
                "service_name": "Example",
                "icon_url": "https://api.example.com/icon.png",
            }
        )
        assert out.service_name == "Example"
        assert out.icon_url == "https://api.example.com/icon.png"

    def test_returns_empty_for_missing_or_non_dict(self) -> None:
        empty = _sanitize_resource_service_metadata(None)
        assert empty.service_name is None
        assert empty.tags is None
        assert empty.icon_url is None


class TestExtractDiscoveryInfoServiceMetadata:
    """End-to-end tests that service metadata round-trips through extraction."""

    def _build_payload(self, resource: dict) -> dict:
        declared = declare_discovery_extension(
            input={"city": "NYC"},
            input_schema={"properties": {"city": {"type": "string"}}},
        )
        ext = declared[BAZAAR.key]
        if hasattr(ext, "model_dump"):
            ext = ext.model_dump(by_alias=True)
        ext["info"]["input"]["method"] = "GET"
        return {
            "x402Version": 2,
            "scheme": "exact",
            "network": "eip155:8453",
            "payload": {},
            "accepted": {},
            "resource": resource,
            "extensions": {BAZAAR.key: ext},
        }

    def test_surfaces_sanitized_metadata(self) -> None:
        payload = self._build_payload(
            {
                "url": "https://api.example.com/weather",
                "description": "Weather API",
                "mimeType": "application/json",
                "serviceName": "Example Weather",
                "tags": ["weather", "forecast"],
                "iconUrl": "https://api.example.com/icon.png",
            }
        )
        discovered = extract_discovery_info(payload, {}, validate=False)
        assert discovered is not None
        assert discovered.service_name == "Example Weather"
        assert discovered.tags == ["weather", "forecast"]
        assert discovered.icon_url == "https://api.example.com/icon.png"

    def test_soft_drops_invalid_fields_independently(self) -> None:
        payload = self._build_payload(
            {
                "url": "https://api.example.com/weather",
                "serviceName": "a" * 33,
                "tags": ["weather", "", "forecast"],
                "iconUrl": "http://localhost/icon.png",
            }
        )
        discovered = extract_discovery_info(payload, {}, validate=False)
        assert discovered is not None
        assert discovered.service_name is None
        assert discovered.tags == ["weather", "forecast"]
        assert discovered.icon_url is None
