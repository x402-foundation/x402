"""Tests for V1 Bazaar facilitator functions."""

from x402.extensions.bazaar import validate_discovery_extension
from x402.extensions.bazaar.types import BAZAAR, BodyDiscoveryInfo, QueryDiscoveryInfo
from x402.extensions.bazaar.v1 import (
    build_v1_catalog_extensions,
    extract_discovery_info_v1,
    extract_resource_metadata_v1,
    is_discoverable_v1,
)


class TestExtractDiscoveryInfoV1:
    """Tests for extract_discovery_info_v1 function."""

    def test_extract_get_endpoint(self) -> None:
        """Test extracting GET endpoint info."""
        requirements = {
            "scheme": "exact",
            "network": "eip155:8453",
            "resource": "https://api.example.com/weather",
            "outputSchema": {
                "input": {
                    "type": "http",
                    "method": "GET",
                    "queryParams": {"city": "string"},
                },
                "output": {"temperature": 72},
            },
        }

        info = extract_discovery_info_v1(requirements)

        assert info is not None
        assert isinstance(info, QueryDiscoveryInfo)
        assert info.input.method == "GET"
        assert info.input.query_params == {"city": "string"}
        assert info.output is not None
        assert info.output.example == {"temperature": 72}

    def test_extract_post_endpoint(self) -> None:
        """Test extracting POST endpoint info."""
        requirements = {
            "outputSchema": {
                "input": {
                    "type": "http",
                    "method": "POST",
                    "bodyType": "json",
                    "bodyFields": {"text": "string", "lang": "string"},
                },
            },
        }

        info = extract_discovery_info_v1(requirements)

        assert info is not None
        assert isinstance(info, BodyDiscoveryInfo)
        assert info.input.method == "POST"
        assert info.input.body_type == "json"
        assert info.input.body == {"text": "string", "lang": "string"}

    def test_extract_with_headers(self) -> None:
        """Test extracting endpoint with headers."""
        requirements = {
            "outputSchema": {
                "input": {
                    "type": "http",
                    "method": "GET",
                    "headers": {"Authorization": "Bearer token"},
                },
            },
        }

        info = extract_discovery_info_v1(requirements)

        assert info is not None
        assert info.input.headers == {"Authorization": "Bearer token"}

    def test_extract_snake_case_fields(self) -> None:
        """Test extracting with snake_case field names."""
        requirements = {
            "output_schema": {
                "input": {
                    "type": "http",
                    "method": "GET",
                    "query_params": {"q": "test"},
                },
            },
        }

        info = extract_discovery_info_v1(requirements)

        assert info is not None
        assert info.input.query_params == {"q": "test"}

    def test_extract_form_data_body_type(self) -> None:
        """Test extracting form-data body type."""
        requirements = {
            "outputSchema": {
                "input": {
                    "type": "http",
                    "method": "PUT",
                    "bodyType": "multipart/form-data",
                    "body": {"file": "data"},
                },
            },
        }

        info = extract_discovery_info_v1(requirements)

        assert info is not None
        assert isinstance(info, BodyDiscoveryInfo)
        assert info.input.body_type == "form-data"

    def test_extract_missing_output_schema(self) -> None:
        """Test extracting when outputSchema is missing."""
        requirements = {
            "scheme": "exact",
            "network": "eip155:8453",
        }

        info = extract_discovery_info_v1(requirements)
        assert info is None

    def test_extract_not_discoverable(self) -> None:
        """Test extracting when discoverable is false."""
        requirements = {
            "outputSchema": {
                "input": {
                    "type": "http",
                    "method": "GET",
                    "discoverable": False,
                },
            },
        }

        info = extract_discovery_info_v1(requirements)
        assert info is None

    def test_extract_unsupported_method(self) -> None:
        """Test extracting with unsupported HTTP method."""
        requirements = {
            "outputSchema": {
                "input": {
                    "type": "http",
                    "method": "OPTIONS",
                },
            },
        }

        info = extract_discovery_info_v1(requirements)
        assert info is None


class TestIsDiscoverableV1:
    """Tests for is_discoverable_v1 function."""

    def test_discoverable(self) -> None:
        """Test discoverable endpoint."""
        requirements = {
            "outputSchema": {
                "input": {
                    "type": "http",
                    "method": "GET",
                },
            },
        }

        assert is_discoverable_v1(requirements) is True

    def test_not_discoverable(self) -> None:
        """Test non-discoverable endpoint."""
        requirements = {
            "outputSchema": {
                "input": {
                    "type": "http",
                    "method": "GET",
                    "discoverable": False,
                },
            },
        }

        assert is_discoverable_v1(requirements) is False

    def test_missing_output_schema(self) -> None:
        """Test missing outputSchema."""
        requirements = {"scheme": "exact"}

        assert is_discoverable_v1(requirements) is False


class TestExtractResourceMetadataV1:
    """Tests for extract_resource_metadata_v1 function."""

    def test_extract_metadata(self) -> None:
        """Test extracting resource metadata."""
        requirements = {
            "resource": "https://api.example.com/data",
            "description": "Get data from API",
            "mimeType": "application/json",
        }

        metadata = extract_resource_metadata_v1(requirements)

        assert metadata.url == "https://api.example.com/data"
        assert metadata.description == "Get data from API"
        assert metadata.mime_type == "application/json"

    def test_extract_snake_case_mime_type(self) -> None:
        """Test extracting with snake_case mime_type."""
        requirements = {
            "resource": "https://api.example.com",
            "description": "Test",
            "mime_type": "text/plain",
        }

        metadata = extract_resource_metadata_v1(requirements)
        assert metadata.mime_type == "text/plain"

    def test_extract_missing_fields(self) -> None:
        """Test extracting with missing fields."""
        requirements = {}

        metadata = extract_resource_metadata_v1(requirements)

        assert metadata.url == ""
        assert metadata.description == ""
        assert metadata.mime_type == ""


class TestBuildV1CatalogExtensions:
    """Tests for v1 catalog extension normalization."""

    def test_synthesizes_bazaar_extension_from_discovery_info(self) -> None:
        requirements = {
            "outputSchema": {
                "input": {
                    "type": "http",
                    "method": "GET",
                    "queryParams": {"token": "JWT token string"},
                },
                "output": {"type": "object"},
            },
        }
        discovery_info = extract_discovery_info_v1(requirements)
        assert discovery_info is not None

        extensions = build_v1_catalog_extensions(None, discovery_info)

        assert "outputSchema" not in extensions
        assert BAZAAR.key in extensions
        assert extensions[BAZAAR.key]["info"] == discovery_info
        assert extensions[BAZAAR.key]["schema"]["required"] == ["input"]
        assert validate_discovery_extension(extensions[BAZAAR.key]).valid is True

    def test_replaces_output_schema_payload_extensions(self) -> None:
        requirements = {
            "outputSchema": {
                "input": {
                    "type": "http",
                    "method": "GET",
                    "queryParams": {"token": "JWT token string"},
                },
            },
        }
        discovery_info = extract_discovery_info_v1(requirements)
        assert discovery_info is not None

        payload_extensions = {"outputSchema": requirements["outputSchema"]}
        extensions = build_v1_catalog_extensions(payload_extensions, discovery_info)

        assert "outputSchema" not in extensions
        assert extensions[BAZAAR.key]["info"] == discovery_info

    def test_preserves_existing_bazaar_extension(self) -> None:
        requirements = {
            "outputSchema": {
                "input": {
                    "type": "http",
                    "method": "GET",
                },
            },
        }
        discovery_info = extract_discovery_info_v1(requirements)
        assert discovery_info is not None

        existing = {
            BAZAAR.key: {
                "info": {"input": {"type": "http", "method": "GET"}},
                "schema": {"type": "object"},
            }
        }
        assert build_v1_catalog_extensions(existing, discovery_info) is existing
