"""Tests for Payment-Identifier utility functions."""

from x402.extensions.payment_identifier.utils import generate_payment_id, is_valid_payment_id


class TestGeneratePaymentId:
    """Tests for generate_payment_id function."""

    def test_generate_with_default_prefix(self) -> None:
        """Test generating ID with default prefix."""
        id = generate_payment_id()
        assert id.startswith("pay_")
        assert len(id) == 4 + 32  # "pay_" + 32 hex chars
        assert is_valid_payment_id(id)

    def test_generate_with_custom_prefix(self) -> None:
        """Test generating ID with custom prefix."""
        id = generate_payment_id("txn_")
        assert id.startswith("txn_")
        assert len(id) == 4 + 32  # "txn_" + 32 hex chars
        assert is_valid_payment_id(id)

    def test_generate_without_prefix(self) -> None:
        """Test generating ID without prefix."""
        id = generate_payment_id("")
        assert not id.startswith("pay_")
        assert len(id) == 32  # 32 hex chars
        assert is_valid_payment_id(id)

    def test_generate_unique_ids(self) -> None:
        """Test that generated IDs are unique."""
        ids = {generate_payment_id() for _ in range(100)}
        assert len(ids) == 100  # All unique

    def test_generated_ids_pass_validation(self) -> None:
        """Test that generated IDs pass validation."""
        for _ in range(10):
            id = generate_payment_id()
            assert is_valid_payment_id(id)


class TestIsValidPaymentId:
    """Tests for is_valid_payment_id function."""

    def test_valid_ids(self) -> None:
        """Test valid payment IDs."""
        assert is_valid_payment_id("pay_7d5d747be160e280") is True
        assert is_valid_payment_id("1234567890123456") is True  # Exactly 16 chars
        assert is_valid_payment_id("abcdefghijklmnop") is True
        assert is_valid_payment_id("test_with-hyphens") is True
        assert is_valid_payment_id("test_with_underscores") is True

    def test_too_short(self) -> None:
        """Test IDs that are too short."""
        assert is_valid_payment_id("abc") is False
        assert is_valid_payment_id("123456789012345") is False  # 15 chars

    def test_too_long(self) -> None:
        """Test IDs that are too long."""
        long_id = "a" * 129
        assert is_valid_payment_id(long_id) is False

    def test_boundary_lengths(self) -> None:
        """Test IDs at boundary lengths."""
        min_id = "a" * 16
        max_id = "a" * 128
        assert is_valid_payment_id(min_id) is True
        assert is_valid_payment_id(max_id) is True

    def test_invalid_characters(self) -> None:
        """Test IDs with invalid characters."""
        assert is_valid_payment_id("pay_abc!@#$%^&*()") is False
        assert is_valid_payment_id("pay_abc def ghij") is False  # spaces
        assert is_valid_payment_id("pay_abc.def.ghij") is False  # dots

    def test_non_string_values(self) -> None:
        """Test non-string values."""
        assert is_valid_payment_id(None) is False  # type: ignore[arg-type]
        assert is_valid_payment_id(123) is False  # type: ignore[arg-type]
        assert is_valid_payment_id([]) is False  # type: ignore[arg-type]
        assert is_valid_payment_id({}) is False  # type: ignore[arg-type]
