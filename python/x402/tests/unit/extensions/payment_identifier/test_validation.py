"""Tests for Payment-Identifier validation functions."""

from x402.extensions.payment_identifier import (
    PAYMENT_IDENTIFIER,
    declare_payment_identifier_extension,
    extract_and_validate_payment_identifier,
    extract_payment_identifier,
    has_payment_identifier,
    is_payment_identifier_extension,
    is_payment_identifier_required,
    validate_payment_identifier,
    validate_payment_identifier_requirement,
)
from x402.extensions.payment_identifier.utils import generate_payment_id
from x402.extensions.payment_identifier.validation import PaymentIdentifierValidationResult
from x402.schemas.payments import PaymentPayload, PaymentRequirements


def create_extension_with_id(id: str | None = None, required: bool = False) -> dict:
    """Helper to create an extension with ID appended."""
    extensions = {PAYMENT_IDENTIFIER: declare_payment_identifier_extension(required)}
    if id:
        from x402.extensions.payment_identifier.client import (
            append_payment_identifier_to_extensions,
        )

        try:
            append_payment_identifier_to_extensions(extensions, id)
        except ValueError:
            # If ID is invalid, create extension directly without validation
            # (for testing invalid ID scenarios)
            ext = extensions[PAYMENT_IDENTIFIER]
            if isinstance(ext, dict):
                ext["info"]["id"] = id
            else:
                ext_dict = (
                    ext.model_dump(by_alias=True) if hasattr(ext, "model_dump") else dict(ext)
                )
                ext_dict["info"]["id"] = id
                extensions[PAYMENT_IDENTIFIER] = ext_dict
    else:
        from x402.extensions.payment_identifier.client import (
            append_payment_identifier_to_extensions,
        )

        append_payment_identifier_to_extensions(extensions)
    return extensions[PAYMENT_IDENTIFIER]


class TestIsPaymentIdentifierExtension:
    """Tests for is_payment_identifier_extension function."""

    def test_valid_extension(self) -> None:
        """Test valid extension structure."""
        ext = declare_payment_identifier_extension()
        assert is_payment_identifier_extension(ext) is True

    def test_invalid_extension(self) -> None:
        """Test invalid extension structures."""
        assert is_payment_identifier_extension({}) is False
        assert is_payment_identifier_extension(None) is False
        assert is_payment_identifier_extension({"schema": {}}) is False
        assert is_payment_identifier_extension({"info": {}}) is False

    def test_extension_without_required(self) -> None:
        """Test extension without required field."""
        assert is_payment_identifier_extension({"info": {"id": "test"}}) is False


class TestValidatePaymentIdentifier:
    """Tests for validate_payment_identifier function."""

    def test_valid_extension(self) -> None:
        """Test validating a correct extension."""
        extension = create_extension_with_id()
        result = validate_payment_identifier(extension)
        assert result.valid is True
        assert len(result.errors) == 0

    def test_reject_non_object(self) -> None:
        """Test rejecting non-object extension."""
        assert validate_payment_identifier(None).valid is False
        assert validate_payment_identifier("string").valid is False
        assert validate_payment_identifier(123).valid is False

    def test_reject_extension_without_info(self) -> None:
        """Test rejecting extension without info."""
        result = validate_payment_identifier({"schema": {}})
        assert result.valid is False
        assert any("info" in error.lower() for error in result.errors)

    def test_reject_extension_without_required(self) -> None:
        """Test rejecting extension without required in info."""
        result = validate_payment_identifier(
            {"info": {"id": "pay_valid_id_12345678"}, "schema": {}}
        )
        assert result.valid is False
        assert any("required" in error.lower() for error in result.errors)

    def test_validate_extension_without_id(self) -> None:
        """Test validating extension with required but no id."""
        result = validate_payment_identifier(
            {
                "info": {"required": False},
                "schema": declare_payment_identifier_extension()["schema"],
            }
        )
        assert result.valid is True

    def test_reject_invalid_id_format(self) -> None:
        """Test rejecting extension with invalid id format."""
        result = validate_payment_identifier(
            {
                "info": {"required": False, "id": "short"},
                "schema": declare_payment_identifier_extension()["schema"],
            }
        )
        assert result.valid is False

    def test_reject_non_string_id(self) -> None:
        """Test rejecting extension with non-string id."""
        result = validate_payment_identifier(
            {
                "info": {"required": False, "id": 123},
                "schema": declare_payment_identifier_extension()["schema"],
            }
        )
        assert result.valid is False
        assert any("string" in error.lower() for error in result.errors)

    def test_validate_extension_with_valid_schema(self) -> None:
        """Test validating extension with valid schema."""
        result = validate_payment_identifier(
            {
                "info": {"required": False, "id": "valid_id_12345678"},
                "schema": declare_payment_identifier_extension()["schema"],
            }
        )
        assert result.valid is True


class TestExtractPaymentIdentifier:
    """Tests for extract_payment_identifier function."""

    def test_extract_from_payload(self) -> None:
        """Test extracting ID from PaymentPayload."""
        payment_id = generate_payment_id()
        ext = create_extension_with_id(payment_id)
        payload = PaymentPayload(
            x402_version=2,
            payload={},
            accepted=PaymentRequirements(
                scheme="exact",
                network="eip155:8453",
                asset="0x123",
                amount="1000",
                pay_to="0x456",
                max_timeout_seconds=300,
            ),
            extensions={PAYMENT_IDENTIFIER: ext},
        )

        extracted_id = extract_payment_identifier(payload)
        assert extracted_id == payment_id

    def test_extract_none_when_not_present(self) -> None:
        """Test extracting when extension not present."""
        payload = PaymentPayload(
            x402_version=2,
            payload={},
            accepted=PaymentRequirements(
                scheme="exact",
                network="eip155:8453",
                asset="0x123",
                amount="1000",
                pay_to="0x456",
                max_timeout_seconds=300,
            ),
            extensions={},
        )

        assert extract_payment_identifier(payload) is None

    def test_extract_none_when_no_extensions(self) -> None:
        """Test extracting when extensions field is None."""
        payload = PaymentPayload(
            x402_version=2,
            payload={},
            accepted=PaymentRequirements(
                scheme="exact",
                network="eip155:8453",
                asset="0x123",
                amount="1000",
                pay_to="0x456",
                max_timeout_seconds=300,
            ),
            extensions=None,
        )

        assert extract_payment_identifier(payload) is None

    def test_extract_with_validation_false(self) -> None:
        """Test extracting with validate=False."""
        ext = create_extension_with_id("invalid_short")
        payload = PaymentPayload(
            x402_version=2,
            payload={},
            accepted=PaymentRequirements(
                scheme="exact",
                network="eip155:8453",
                asset="0x123",
                amount="1000",
                pay_to="0x456",
                max_timeout_seconds=300,
            ),
            extensions={PAYMENT_IDENTIFIER: ext},
        )

        # Should return None when validate=True (default)
        assert extract_payment_identifier(payload, validate=True) is None
        # Should return ID when validate=False
        assert extract_payment_identifier(payload, validate=False) == "invalid_short"


class TestExtractAndValidatePaymentIdentifier:
    """Tests for extract_and_validate_payment_identifier function."""

    def test_extract_and_validate_valid(self) -> None:
        """Test extracting and validating valid extension."""
        payment_id = generate_payment_id()
        ext = create_extension_with_id(payment_id)
        payload = PaymentPayload(
            x402_version=2,
            payload={},
            accepted=PaymentRequirements(
                scheme="exact",
                network="eip155:8453",
                asset="0x123",
                amount="1000",
                pay_to="0x456",
                max_timeout_seconds=300,
            ),
            extensions={PAYMENT_IDENTIFIER: ext},
        )

        id_value, validation = extract_and_validate_payment_identifier(payload)
        assert id_value == payment_id
        assert validation.valid is True

    def test_extract_and_validate_invalid(self) -> None:
        """Test extracting and validating invalid extension."""
        ext = {"info": {"required": False, "id": "short"}, "schema": {}}
        payload = PaymentPayload(
            x402_version=2,
            payload={},
            accepted=PaymentRequirements(
                scheme="exact",
                network="eip155:8453",
                asset="0x123",
                amount="1000",
                pay_to="0x456",
                max_timeout_seconds=300,
            ),
            extensions={PAYMENT_IDENTIFIER: ext},
        )

        id_value, validation = extract_and_validate_payment_identifier(payload)
        assert id_value is None
        assert validation.valid is False

    def test_extract_and_validate_no_extension(self) -> None:
        """Test extracting and validating when no extension."""
        payload = PaymentPayload(
            x402_version=2,
            payload={},
            accepted=PaymentRequirements(
                scheme="exact",
                network="eip155:8453",
                asset="0x123",
                amount="1000",
                pay_to="0x456",
                max_timeout_seconds=300,
            ),
            extensions={},
        )

        id_value, validation = extract_and_validate_payment_identifier(payload)
        assert id_value is None
        assert validation.valid is True


class TestHasPaymentIdentifier:
    """Tests for has_payment_identifier function."""

    def test_has_extension(self) -> None:
        """Test has_payment_identifier returns True when present."""
        ext = declare_payment_identifier_extension()
        payload = PaymentPayload(
            x402_version=2,
            payload={},
            accepted=PaymentRequirements(
                scheme="exact",
                network="eip155:8453",
                asset="0x123",
                amount="1000",
                pay_to="0x456",
                max_timeout_seconds=300,
            ),
            extensions={PAYMENT_IDENTIFIER: ext},
        )

        assert has_payment_identifier(payload) is True

    def test_no_extension(self) -> None:
        """Test has_payment_identifier returns False when not present."""
        payload = PaymentPayload(
            x402_version=2,
            payload={},
            accepted=PaymentRequirements(
                scheme="exact",
                network="eip155:8453",
                asset="0x123",
                amount="1000",
                pay_to="0x456",
                max_timeout_seconds=300,
            ),
            extensions={},
        )

        assert has_payment_identifier(payload) is False

    def test_no_extensions_field(self) -> None:
        """Test has_payment_identifier when extensions is None."""
        payload = PaymentPayload(
            x402_version=2,
            payload={},
            accepted=PaymentRequirements(
                scheme="exact",
                network="eip155:8453",
                asset="0x123",
                amount="1000",
                pay_to="0x456",
                max_timeout_seconds=300,
            ),
            extensions=None,
        )

        assert has_payment_identifier(payload) is False


class TestIsPaymentIdentifierRequired:
    """Tests for is_payment_identifier_required function."""

    def test_required_false(self) -> None:
        """Test is_payment_identifier_required with required=False."""
        ext = declare_payment_identifier_extension(required=False)
        assert is_payment_identifier_required(ext) is False

    def test_required_true(self) -> None:
        """Test is_payment_identifier_required with required=True."""
        ext = declare_payment_identifier_extension(required=True)
        assert is_payment_identifier_required(ext) is True

    def test_invalid_extension(self) -> None:
        """Test is_payment_identifier_required with invalid extension."""
        assert is_payment_identifier_required({}) is False
        assert is_payment_identifier_required(None) is False


class TestValidatePaymentIdentifierRequirement:
    """Tests for validate_payment_identifier_requirement function."""

    def test_not_required(self) -> None:
        """Test validation when server doesn't require identifier."""
        payload = PaymentPayload(
            x402_version=2,
            payload={},
            accepted=PaymentRequirements(
                scheme="exact",
                network="eip155:8453",
                asset="0x123",
                amount="1000",
                pay_to="0x456",
                max_timeout_seconds=300,
            ),
            extensions={},
        )

        result = validate_payment_identifier_requirement(payload, server_required=False)
        assert result.valid is True

    def test_required_and_provided(self) -> None:
        """Test validation when required and provided."""
        payment_id = generate_payment_id()
        ext = create_extension_with_id(payment_id)
        payload = PaymentPayload(
            x402_version=2,
            payload={},
            accepted=PaymentRequirements(
                scheme="exact",
                network="eip155:8453",
                asset="0x123",
                amount="1000",
                pay_to="0x456",
                max_timeout_seconds=300,
            ),
            extensions={PAYMENT_IDENTIFIER: ext},
        )

        result = validate_payment_identifier_requirement(payload, server_required=True)
        assert result.valid is True

    def test_required_but_not_provided(self) -> None:
        """Test validation when required but not provided."""
        payload = PaymentPayload(
            x402_version=2,
            payload={},
            accepted=PaymentRequirements(
                scheme="exact",
                network="eip155:8453",
                asset="0x123",
                amount="1000",
                pay_to="0x456",
                max_timeout_seconds=300,
            ),
            extensions={},
        )

        result = validate_payment_identifier_requirement(payload, server_required=True)
        assert result.valid is False
        assert len(result.errors) > 0
        # Check that error mentions requirement or identifier
        assert any(
            "required" in error.lower() or "identifier" in error.lower() for error in result.errors
        )

    def test_required_but_invalid_id(self) -> None:
        """Test validation when required but ID is invalid."""
        ext = create_extension_with_id("short")
        payload = PaymentPayload(
            x402_version=2,
            payload={},
            accepted=PaymentRequirements(
                scheme="exact",
                network="eip155:8453",
                asset="0x123",
                amount="1000",
                pay_to="0x456",
                max_timeout_seconds=300,
            ),
            extensions={PAYMENT_IDENTIFIER: ext},
        )

        result = validate_payment_identifier_requirement(payload, server_required=True)
        assert result.valid is False
        assert any("format" in error.lower() for error in result.errors)


class TestPaymentIdentifierValidationResult:
    """Tests for PaymentIdentifierValidationResult dataclass."""

    def test_valid_result(self) -> None:
        """Test valid validation result."""
        result = PaymentIdentifierValidationResult(valid=True)
        assert result.valid is True
        assert result.errors == []

    def test_invalid_result_with_errors(self) -> None:
        """Test invalid validation result with errors."""
        result = PaymentIdentifierValidationResult(valid=False, errors=["error1", "error2"])
        assert result.valid is False
        assert len(result.errors) == 2
        assert "error1" in result.errors
        assert "error2" in result.errors
