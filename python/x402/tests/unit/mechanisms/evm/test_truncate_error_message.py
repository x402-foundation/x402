"""Tests for the shared error-message truncation helper."""

from x402.mechanisms.evm.utils import MAX_ERROR_MESSAGE_LENGTH, truncate_error_message


class TestTruncateErrorMessage:
    def test_leaves_short_messages_unchanged(self):
        assert truncate_error_message("connection refused") == "connection refused"

    def test_truncates_long_messages_to_max_length(self):
        long_message = "x" * (MAX_ERROR_MESSAGE_LENGTH + 100)
        result = truncate_error_message(long_message)
        assert len(result) == MAX_ERROR_MESSAGE_LENGTH
        assert result == long_message[:MAX_ERROR_MESSAGE_LENGTH]

    def test_exact_length_is_unchanged(self):
        message = "x" * MAX_ERROR_MESSAGE_LENGTH
        assert truncate_error_message(message) == message
