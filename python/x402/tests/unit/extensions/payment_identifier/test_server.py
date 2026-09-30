"""Tests for Payment-Identifier server extension."""

from x402.extensions.payment_identifier import (
    PAYMENT_IDENTIFIER,
    declare_payment_identifier_extension,
    payment_identifier_resource_server_extension,
)


class TestDeclarePaymentIdentifierExtension:
    """Tests for declare_payment_identifier_extension function."""

    def test_declare_with_default_required(self) -> None:
        """Test declaring extension with default required=False."""
        declaration = declare_payment_identifier_extension()
        assert declaration["info"]["required"] is False
        assert "schema" in declaration

    def test_declare_with_required_true(self) -> None:
        """Test declaring extension with required=True."""
        declaration = declare_payment_identifier_extension(required=True)
        assert declaration["info"]["required"] is True
        assert "schema" in declaration

    def test_declare_includes_schema(self) -> None:
        """Test that declaration includes schema."""
        declaration = declare_payment_identifier_extension()
        schema = declaration["schema"]
        assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
        assert schema["type"] == "object"
        assert schema["properties"]["required"]["type"] == "boolean"
        assert schema["properties"]["id"]["minLength"] == 16
        assert schema["properties"]["id"]["maxLength"] == 128

    def test_declare_schema_required_field(self) -> None:
        """Test that schema requires 'required' field."""
        declaration = declare_payment_identifier_extension()
        schema = declaration["schema"]
        assert "required" in schema["required"]


class TestPaymentIdentifierResourceServerExtension:
    """Tests for PaymentIdentifierResourceServerExtension."""

    def test_extension_key(self) -> None:
        """Test extension key is correct."""
        assert payment_identifier_resource_server_extension.key == PAYMENT_IDENTIFIER

    def test_enrich_declaration_returns_unchanged(self) -> None:
        """Test that enrich_declaration returns declaration unchanged."""
        declaration = declare_payment_identifier_extension()
        context = {"method": "GET"}

        enriched = payment_identifier_resource_server_extension.enrich_declaration(
            declaration, context
        )

        # Should return unchanged since payment-identifier doesn't need enrichment
        assert enriched == declaration

    def test_enrich_with_none_context(self) -> None:
        """Test enriching with None context."""
        declaration = declare_payment_identifier_extension()
        enriched = payment_identifier_resource_server_extension.enrich_declaration(
            declaration, None
        )
        assert enriched == declaration

    def test_enrich_preserves_structure(self) -> None:
        """Test that enrichment preserves declaration structure."""
        declaration = declare_payment_identifier_extension(required=True)
        enriched = payment_identifier_resource_server_extension.enrich_declaration(
            declaration, {"any": "context"}
        )
        assert enriched["info"]["required"] is True
        assert "schema" in enriched
