"""Tests for Payment-Identifier client utilities."""

import pytest

from x402.extensions.payment_identifier import (
    PAYMENT_IDENTIFIER,
    append_payment_identifier_to_extensions,
    declare_payment_identifier_extension,
)


class TestAppendPaymentIdentifierToExtensions:
    """Tests for append_payment_identifier_to_extensions function."""

    def test_append_auto_generated_id(self) -> None:
        """Test appending auto-generated ID when extension exists."""
        extensions = {PAYMENT_IDENTIFIER: declare_payment_identifier_extension()}
        result = append_payment_identifier_to_extensions(extensions)

        assert result is extensions  # Same reference
        ext = extensions[PAYMENT_IDENTIFIER]
        assert "info" in ext
        assert "id" in ext["info"]
        assert ext["info"]["id"].startswith("pay_")
        assert len(ext["info"]["id"]) == 4 + 32  # "pay_" + 32 hex chars
        assert ext["info"]["required"] is False

    def test_append_custom_id(self) -> None:
        """Test appending custom ID when extension exists."""
        custom_id = "custom_id_1234567890"
        extensions = {PAYMENT_IDENTIFIER: declare_payment_identifier_extension()}
        append_payment_identifier_to_extensions(extensions, custom_id)

        ext = extensions[PAYMENT_IDENTIFIER]
        assert ext["info"]["id"] == custom_id

    def test_preserve_required_flag(self) -> None:
        """Test that required flag is preserved from server declaration."""
        extensions = {PAYMENT_IDENTIFIER: declare_payment_identifier_extension(required=True)}
        append_payment_identifier_to_extensions(extensions)

        ext = extensions[PAYMENT_IDENTIFIER]
        assert ext["info"]["required"] is True
        assert "id" in ext["info"]

    def test_no_modification_when_extension_not_present(self) -> None:
        """Test that extensions are not modified when payment-identifier is not present."""
        extensions = {"other": {"foo": "bar"}}
        result = append_payment_identifier_to_extensions(extensions)

        assert result is extensions
        assert PAYMENT_IDENTIFIER not in extensions
        assert extensions["other"] == {"foo": "bar"}

    def test_no_modification_when_extension_invalid(self) -> None:
        """Test that extensions are not modified when extension structure is invalid."""
        extensions = {PAYMENT_IDENTIFIER: {"schema": {}}}
        result = append_payment_identifier_to_extensions(extensions)

        assert result is extensions
        ext = extensions[PAYMENT_IDENTIFIER]
        assert "info" not in ext or "id" not in ext.get("info", {})

    def test_raises_error_for_invalid_custom_id(self) -> None:
        """Test that ValueError is raised for invalid custom ID."""
        extensions = {PAYMENT_IDENTIFIER: declare_payment_identifier_extension()}

        with pytest.raises(ValueError, match="Invalid payment ID"):
            append_payment_identifier_to_extensions(extensions, "short")

        with pytest.raises(ValueError, match="Invalid payment ID"):
            append_payment_identifier_to_extensions(extensions, "invalid!@#$%^&")

    def test_no_error_when_extension_not_present_and_custom_id_provided(self) -> None:
        """Test that no error when extension doesn't exist and custom ID provided."""
        extensions = {"other": {}}
        result = append_payment_identifier_to_extensions(extensions, "valid_id_12345678")
        assert result is extensions
        assert PAYMENT_IDENTIFIER not in extensions

    def test_overwrites_existing_id(self) -> None:
        """Test that calling multiple times overwrites existing ID."""
        extensions = {PAYMENT_IDENTIFIER: declare_payment_identifier_extension()}
        append_payment_identifier_to_extensions(extensions, "first_id_12345678")
        assert extensions[PAYMENT_IDENTIFIER]["info"]["id"] == "first_id_12345678"

        append_payment_identifier_to_extensions(extensions, "second_id_12345678")
        assert extensions[PAYMENT_IDENTIFIER]["info"]["id"] == "second_id_12345678"
