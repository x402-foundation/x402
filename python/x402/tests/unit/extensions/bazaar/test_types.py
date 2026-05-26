"""Tests for Bazaar extension types."""

from x402.extensions.bazaar.types import (
    BAZAAR,
    BodyDiscoveryExtension,
    BodyDiscoveryInfo,
    BodyInput,
    OutputInfo,
    QueryDiscoveryExtension,
    QueryDiscoveryInfo,
    QueryInput,
    is_body_method,
    is_query_method,
    parse_discovery_extension,
    parse_discovery_info,
)


class TestConstants:
    """Test extension constants."""

    def test_bazaar_constant(self) -> None:
        """Test BAZAAR constant value."""
        assert BAZAAR.key == "bazaar"


class TestMethodChecks:
    """Test HTTP method type checks."""

    def test_is_query_method(self) -> None:
        """Test is_query_method function."""
        assert is_query_method("GET")
        assert is_query_method("HEAD")
        assert is_query_method("DELETE")
        assert is_query_method("get")  # case insensitive
        assert not is_query_method("POST")
        assert not is_query_method("PUT")
        assert not is_query_method("PATCH")

    def test_is_body_method(self) -> None:
        """Test is_body_method function."""
        assert is_body_method("POST")
        assert is_body_method("PUT")
        assert is_body_method("PATCH")
        assert is_body_method("post")  # case insensitive
        assert not is_body_method("GET")
        assert not is_body_method("HEAD")
        assert not is_body_method("DELETE")


class TestQueryTypes:
    """Test query parameter types."""

    def test_query_input(self) -> None:
        """Test QueryInput model."""
        query_input = QueryInput(
            type="http",
            method="GET",
            query_params={"city": "San Francisco"},
            headers={"Accept": "application/json"},
        )
        assert query_input.type == "http"
        assert query_input.method == "GET"
        assert query_input.query_params == {"city": "San Francisco"}
        assert query_input.headers == {"Accept": "application/json"}

    def test_query_input_alias(self) -> None:
        """Test QueryInput with camelCase alias."""
        query_input = QueryInput.model_validate(
            {
                "type": "http",
                "method": "GET",
                "queryParams": {"city": "SF"},
            }
        )
        assert query_input.query_params == {"city": "SF"}

    def test_query_discovery_info(self) -> None:
        """Test QueryDiscoveryInfo model."""
        info = QueryDiscoveryInfo(
            input=QueryInput(type="http", method="GET"),
            output=OutputInfo(type="json", example={"temp": 72}),
        )
        assert info.input.method == "GET"
        assert info.output is not None
        assert info.output.example == {"temp": 72}


class TestBodyTypes:
    """Test body method types."""

    def test_body_input(self) -> None:
        """Test BodyInput model."""
        body_input = BodyInput(
            type="http",
            method="POST",
            body_type="json",
            body={"name": "John", "age": 30},
        )
        assert body_input.type == "http"
        assert body_input.method == "POST"
        assert body_input.body_type == "json"
        assert body_input.body == {"name": "John", "age": 30}

    def test_body_input_alias(self) -> None:
        """Test BodyInput with camelCase alias."""
        body_input = BodyInput.model_validate(
            {
                "type": "http",
                "method": "POST",
                "bodyType": "json",
                "body": {"test": True},
            }
        )
        assert body_input.body_type == "json"
        assert body_input.body == {"test": True}

    def test_body_discovery_info(self) -> None:
        """Test BodyDiscoveryInfo model."""
        info = BodyDiscoveryInfo(
            input=BodyInput(
                type="http",
                method="POST",
                body_type="json",
                body={"text": "hello"},
            ),
            output=OutputInfo(type="json", example={"translated": "hola"}),
        )
        assert info.input.method == "POST"
        assert info.input.body_type == "json"
        assert info.output is not None


class TestDiscoveryExtension:
    """Test discovery extension types."""

    def test_query_discovery_extension(self) -> None:
        """Test QueryDiscoveryExtension model."""
        ext = QueryDiscoveryExtension(
            info=QueryDiscoveryInfo(
                input=QueryInput(type="http", method="GET"),
            ),
            schema={"type": "object"},
        )
        assert ext.info.input.method == "GET"
        assert ext.schema_ == {"type": "object"}

    def test_body_discovery_extension(self) -> None:
        """Test BodyDiscoveryExtension model."""
        ext = BodyDiscoveryExtension(
            info=BodyDiscoveryInfo(
                input=BodyInput(
                    type="http",
                    method="POST",
                    body_type="json",
                    body={},
                ),
            ),
            schema={"type": "object"},
        )
        assert ext.info.input.method == "POST"


class TestParseDiscoveryExtension:
    """Test discovery extension parsing."""

    def test_parse_query_extension(self) -> None:
        """Test parsing a query extension."""
        data = {
            "info": {
                "input": {
                    "type": "http",
                    "method": "GET",
                    "queryParams": {"q": "test"},
                },
            },
            "schema": {"type": "object"},
        }
        ext = parse_discovery_extension(data)
        assert isinstance(ext, QueryDiscoveryExtension)
        assert ext.info.input.method == "GET"

    def test_parse_body_extension(self) -> None:
        """Test parsing a body extension."""
        data = {
            "info": {
                "input": {
                    "type": "http",
                    "method": "POST",
                    "bodyType": "json",
                    "body": {"data": "test"},
                },
            },
            "schema": {"type": "object"},
        }
        ext = parse_discovery_extension(data)
        assert isinstance(ext, BodyDiscoveryExtension)
        assert ext.info.input.method == "POST"


class TestParseDiscoveryInfo:
    """Test discovery info parsing."""

    def test_parse_query_info(self) -> None:
        """Test parsing query discovery info."""
        data = {
            "input": {
                "type": "http",
                "method": "GET",
            },
        }
        info = parse_discovery_info(data)
        assert isinstance(info, QueryDiscoveryInfo)

    def test_parse_body_info(self) -> None:
        """Test parsing body discovery info."""
        data = {
            "input": {
                "type": "http",
                "method": "POST",
                "bodyType": "json",
                "body": {},
            },
        }
        info = parse_discovery_info(data)
        assert isinstance(info, BodyDiscoveryInfo)
