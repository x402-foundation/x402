"""Tests for Payment-Identifier extension types."""

from x402.extensions.payment_identifier.types import (
    PAYMENT_ID_MAX_LENGTH,
    PAYMENT_ID_MIN_LENGTH,
    PAYMENT_ID_PATTERN,
    PAYMENT_IDENTIFIER,
    PaymentIdentifierExtension,
    PaymentIdentifierInfo,
)


class TestConstants:
    """Test extension constants."""

    def test_payment_identifier_constant(self) -> None:
        """Test PAYMENT_IDENTIFIER constant value."""
        assert PAYMENT_IDENTIFIER == "payment-identifier"

    def test_length_constants(self) -> None:
        """Test length constants."""
        assert PAYMENT_ID_MIN_LENGTH == 16
        assert PAYMENT_ID_MAX_LENGTH == 128

    def test_pattern_constant(self) -> None:
        """Test PAYMENT_ID_PATTERN constant."""
        assert PAYMENT_ID_PATTERN is not None
        assert PAYMENT_ID_PATTERN.match("valid_id_123") is not None
        assert PAYMENT_ID_PATTERN.match("invalid!@#") is None


class TestPaymentIdentifierInfo:
    """Test PaymentIdentifierInfo model."""

    def test_info_with_required_only(self) -> None:
        """Test PaymentIdentifierInfo with required flag only."""
        info = PaymentIdentifierInfo(required=False)
        assert info.required is False
        assert info.id is None

    def test_info_with_id(self) -> None:
        """Test PaymentIdentifierInfo with id."""
        info = PaymentIdentifierInfo(required=False, id="pay_1234567890123456")
        assert info.required is False
        assert info.id == "pay_1234567890123456"

    def test_info_required_true(self) -> None:
        """Test PaymentIdentifierInfo with required=True."""
        info = PaymentIdentifierInfo(required=True)
        assert info.required is True

    def test_info_from_dict(self) -> None:
        """Test PaymentIdentifierInfo from dictionary."""
        info = PaymentIdentifierInfo.model_validate({"required": False, "id": "test_id_12345678"})
        assert info.required is False
        assert info.id == "test_id_12345678"


class TestPaymentIdentifierExtension:
    """Test PaymentIdentifierExtension model."""

    def test_extension_with_info_and_schema(self) -> None:
        """Test PaymentIdentifierExtension with info and schema."""
        info = PaymentIdentifierInfo(required=False)
        schema = {"type": "object", "properties": {}}
        ext = PaymentIdentifierExtension(info=info, schema=schema)
        assert ext.info.required is False
        assert ext.schema_ == schema

    def test_extension_with_id(self) -> None:
        """Test PaymentIdentifierExtension with id in info."""
        info = PaymentIdentifierInfo(required=False, id="pay_1234567890123456")
        schema = {"type": "object"}
        ext = PaymentIdentifierExtension(info=info, schema=schema)
        assert ext.info.id == "pay_1234567890123456"

    def test_extension_schema_alias(self) -> None:
        """Test PaymentIdentifierExtension with camelCase schema alias."""
        schema = {"type": "object"}
        ext = PaymentIdentifierExtension.model_validate(
            {"info": {"required": False}, "schema": schema}
        )
        assert ext.schema_ == schema
