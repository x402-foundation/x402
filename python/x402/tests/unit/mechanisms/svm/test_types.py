"""Tests for SVM payload types."""

from x402.mechanisms.svm import ExactSvmPayload, ExactSvmPayloadV1, ExactSvmPayloadV2


class TestExactSvmPayloadV1:
    """Test ExactSvmPayloadV1 type."""

    def test_should_accept_valid_payload_structure(self):
        """Should accept valid payload structure."""
        payload = ExactSvmPayloadV1(transaction="base64encodedtransaction==")

        assert payload.transaction is not None
        assert isinstance(payload.transaction, str)

    def test_should_accept_empty_transaction_string(self):
        """Should accept empty transaction string."""
        payload = ExactSvmPayloadV1(transaction="")

        assert payload.transaction == ""

    def test_should_accept_long_base64_transaction_strings(self):
        """Should accept long base64 transaction strings."""
        long_transaction = "A" * 1000 + "=="
        payload = ExactSvmPayloadV1(transaction=long_transaction)

        assert payload.transaction == long_transaction
        assert len(payload.transaction) == 1002


class TestExactSvmPayloadV2:
    """Test ExactSvmPayloadV2 type."""

    def test_should_have_same_structure_as_v1(self):
        """Should have the same structure as V1."""
        payload = ExactSvmPayloadV2(transaction="base64encodedtransaction==")

        # V2 should be compatible with V1
        payload_v1: ExactSvmPayloadV1 = payload
        assert payload_v1.transaction == payload.transaction

    def test_should_be_assignable_from_v1(self):
        """Should be assignable from V1."""
        payload_v1 = ExactSvmPayloadV1(transaction="test==")
        payload_v2: ExactSvmPayloadV2 = payload_v1

        assert payload_v2.transaction == payload_v1.transaction


class TestExactSvmPayloadSerialization:
    """Test ExactSvmPayload serialization."""

    def test_to_dict_should_return_dict_with_transaction(self):
        """to_dict should return dict with transaction field."""
        payload = ExactSvmPayload(transaction="encoded_tx==")
        result = payload.to_dict()

        assert result == {"transaction": "encoded_tx=="}

    def test_from_dict_should_create_payload_from_dict(self):
        """from_dict should create payload from dict."""
        data = {"transaction": "encoded_tx=="}
        payload = ExactSvmPayload.from_dict(data)

        assert payload.transaction == "encoded_tx=="

    def test_from_dict_should_handle_empty_dict(self):
        """from_dict should handle empty dict."""
        payload = ExactSvmPayload.from_dict({})

        assert payload.transaction == ""

    def test_round_trip_serialization(self):
        """Should preserve data through serialization round-trip."""
        original = ExactSvmPayload(transaction="test_transaction_data==")
        serialized = original.to_dict()
        restored = ExactSvmPayload.from_dict(serialized)

        assert restored.transaction == original.transaction
