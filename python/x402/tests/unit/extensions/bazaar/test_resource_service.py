"""Tests for Bazaar resource service functions."""

from x402.extensions.bazaar import (
    BAZAAR,
    OutputConfig,
    declare_discovery_extension,
)


class TestDeclareDiscoveryExtension:
    """Tests for declare_discovery_extension function."""

    def test_query_extension_basic(self) -> None:
        """Test creating a basic query extension."""
        result = declare_discovery_extension(
            input={"city": "San Francisco"},
            input_schema={
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        )

        assert BAZAAR.key in result
        ext = result[BAZAAR.key]
        assert isinstance(ext, dict)
        assert ext["info"]["input"]["queryParams"] == {"city": "San Francisco"}

    def test_query_extension_with_output(self) -> None:
        """Test query extension with output example."""
        result = declare_discovery_extension(
            input={"query": "test"},
            input_schema={"properties": {"query": {"type": "string"}}},
            output=OutputConfig(
                example={"results": [], "total": 0},
                schema={"type": "object"},
            ),
        )

        ext = result[BAZAAR.key]
        assert isinstance(ext, dict)
        assert ext["info"]["output"] is not None
        assert ext["info"]["output"]["type"] == "json"
        assert ext["info"]["output"]["example"] == {"results": [], "total": 0}

    def test_body_extension_json(self) -> None:
        """Test creating a body extension with JSON body type."""
        result = declare_discovery_extension(
            input={"name": "John", "age": 30},
            input_schema={
                "properties": {
                    "name": {"type": "string"},
                    "age": {"type": "number"},
                },
                "required": ["name"],
            },
            body_type="json",
        )

        assert BAZAAR.key in result
        ext = result[BAZAAR.key]
        assert isinstance(ext, dict)
        assert ext["info"]["input"]["bodyType"] == "json"
        assert ext["info"]["input"]["body"] == {"name": "John", "age": 30}

    def test_body_extension_form_data(self) -> None:
        """Test creating a body extension with form-data type."""
        result = declare_discovery_extension(
            input={"file": "data.csv"},
            input_schema={"properties": {"file": {"type": "string"}}},
            body_type="form-data",
        )

        ext = result[BAZAAR.key]
        assert isinstance(ext, dict)
        assert ext["info"]["input"]["bodyType"] == "form-data"

    def test_body_extension_text(self) -> None:
        """Test creating a body extension with text type."""
        result = declare_discovery_extension(
            input={"content": "raw text"},
            body_type="text",
        )

        ext = result[BAZAAR.key]
        assert isinstance(ext, dict)
        assert ext["info"]["input"]["bodyType"] == "text"

    def test_extension_has_schema(self) -> None:
        """Test that extensions include JSON schema."""
        result = declare_discovery_extension(
            input={"q": "test"},
            input_schema={"properties": {"q": {"type": "string"}}},
        )

        ext = result[BAZAAR.key]
        schema = ext["schema"]
        assert "$schema" in schema
        assert schema["type"] == "object"
        assert "properties" in schema
        assert "input" in schema["properties"]

    def test_empty_extension(self) -> None:
        """Test creating an extension with minimal config."""
        result = declare_discovery_extension()

        assert BAZAAR.key in result
        ext = result[BAZAAR.key]
        assert isinstance(ext, dict)
        assert ext["info"]["input"]["type"] == "http"

    def test_output_schema_included(self) -> None:
        """Test that output schema is included when output has example."""
        result = declare_discovery_extension(
            output=OutputConfig(
                example={"data": []},
                schema={"properties": {"data": {"type": "array"}}},
            ),
        )

        ext = result[BAZAAR.key]
        schema = ext["schema"]
        assert "output" in schema["properties"]
