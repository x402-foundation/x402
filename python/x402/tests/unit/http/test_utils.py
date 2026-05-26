"""Unit tests for x402.http.utils - header encoding/decoding utilities."""

import base64
import json

import pytest

from x402.http.utils import (
    decode_payment_required_header,
    decode_payment_response_header,
    decode_payment_signature_header,
    detect_payment_required_version,
    encode_payment_required_header,
    encode_payment_response_header,
    encode_payment_signature_header,
    htmlsafe_json_dumps,
    safe_base64_decode,
    safe_base64_encode,
)
from x402.schemas import (
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    SettleResponse,
)
from x402.schemas.v1 import PaymentPayloadV1, PaymentRequiredV1


def make_payment_requirements() -> PaymentRequirements:
    """Helper to create valid PaymentRequirements."""
    return PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0x0000000000000000000000000000000000000000",
        amount="1000000",
        pay_to="0x1234567890123456789012345678901234567890",
        max_timeout_seconds=300,
    )


def make_v2_payload(signature: str = "0x123") -> PaymentPayload:
    """Helper to create valid V2 PaymentPayload."""
    return PaymentPayload(
        x402_version=2,
        payload={"signature": signature},
        accepted=make_payment_requirements(),
    )


class TestCamelCaseSerialization:
    """Tests that model_dump_json() produces camelCase by default (#1120)."""

    def test_payment_payload_serializes_camel_case(self):
        """model_dump_json() should produce camelCase without by_alias."""
        payload = make_v2_payload()
        data = json.loads(payload.model_dump_json())

        assert "x402Version" in data
        assert "x402_version" not in data

    def test_payment_requirements_serializes_camel_case(self):
        """PaymentRequirements fields should serialize as camelCase."""
        req = make_payment_requirements()
        data = json.loads(req.model_dump_json())

        assert "payTo" in data
        assert "pay_to" not in data
        assert "maxTimeoutSeconds" in data
        assert "max_timeout_seconds" not in data

    def test_payment_required_serializes_camel_case(self):
        """PaymentRequired should serialize as camelCase."""
        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        data = json.loads(payment_required.model_dump_json())

        assert "x402Version" in data
        assert "x402_version" not in data
        assert "payTo" in data["accepts"][0]
        assert "maxTimeoutSeconds" in data["accepts"][0]


class TestSafeBase64:
    """Tests for base64 encode/decode utilities."""

    def test_encode_simple_string(self):
        """Test encoding a simple string."""
        result = safe_base64_encode("hello world")
        expected = base64.b64encode(b"hello world").decode("utf-8")
        assert result == expected

    def test_decode_simple_string(self):
        """Test decoding a simple string."""
        encoded = base64.b64encode(b"hello world").decode("utf-8")
        result = safe_base64_decode(encoded)
        assert result == "hello world"

    def test_roundtrip(self):
        """Test encode/decode roundtrip."""
        original = '{"key": "value", "number": 123}'
        encoded = safe_base64_encode(original)
        decoded = safe_base64_decode(encoded)
        assert decoded == original

    def test_unicode_characters(self):
        """Test encoding/decoding unicode characters."""
        original = "hello 世界 🌍"
        encoded = safe_base64_encode(original)
        decoded = safe_base64_decode(encoded)
        assert decoded == original


class TestPaymentSignatureHeader:
    """Tests for payment signature header encoding/decoding."""

    def test_encode_v2_payload(self):
        """Test encoding a V2 payment payload."""
        payload = make_v2_payload()
        result = encode_payment_signature_header(payload)

        # Verify it's valid base64
        decoded_json = safe_base64_decode(result)
        data = json.loads(decoded_json)
        assert data["x402Version"] == 2
        assert data["accepted"]["scheme"] == "exact"

    def test_decode_v2_payload(self):
        """Test decoding a V2 payment payload."""
        payload = make_v2_payload()
        encoded = encode_payment_signature_header(payload)
        decoded = decode_payment_signature_header(encoded)

        assert isinstance(decoded, PaymentPayload)
        assert decoded.x402_version == 2
        assert decoded.get_scheme() == "exact"
        assert decoded.get_network() == "eip155:8453"

    def test_encode_v1_payload(self):
        """Test encoding a V1 payment payload."""
        payload = PaymentPayloadV1(
            x402_version=1,
            scheme="exact",
            network="base-sepolia",
            payload={"signature": "0xabc"},
        )
        result = encode_payment_signature_header(payload)

        decoded_json = safe_base64_decode(result)
        data = json.loads(decoded_json)
        assert data["x402Version"] == 1

    def test_decode_v1_payload(self):
        """Test decoding a V1 payment payload."""
        payload = PaymentPayloadV1(
            x402_version=1,
            scheme="exact",
            network="base-sepolia",
            payload={"signature": "0xabc"},
        )
        encoded = encode_payment_signature_header(payload)
        decoded = decode_payment_signature_header(encoded)

        assert isinstance(decoded, PaymentPayloadV1)
        assert decoded.x402_version == 1


class TestPaymentRequiredHeader:
    """Tests for payment required header encoding/decoding."""

    def test_encode_v2_payment_required(self):
        """Test encoding a V2 PaymentRequired."""
        requirements = make_payment_requirements()
        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[requirements],
            error=None,
        )
        result = encode_payment_required_header(payment_required)

        decoded_json = safe_base64_decode(result)
        data = json.loads(decoded_json)
        assert data["x402Version"] == 2
        assert len(data["accepts"]) == 1
        assert data["accepts"][0]["scheme"] == "exact"

    def test_decode_v2_payment_required(self):
        """Test decoding a V2 PaymentRequired."""
        requirements = make_payment_requirements()
        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[requirements],
        )
        encoded = encode_payment_required_header(payment_required)
        decoded = decode_payment_required_header(encoded)

        assert isinstance(decoded, PaymentRequired)
        assert decoded.x402_version == 2
        assert len(decoded.accepts) == 1
        assert decoded.accepts[0].scheme == "exact"

    def test_decode_v1_payment_required(self):
        """Test decoding a V1 PaymentRequired from header."""
        # Create V1-style data
        v1_data = {
            "x402Version": 1,
            "accepts": [
                {
                    "scheme": "exact",
                    "network": "base-sepolia",
                    "maxAmountRequired": "500000",
                    "resource": "https://example.com/api",
                    "description": "Test",
                    "mimeType": "application/json",
                    "payTo": "0x1234567890123456789012345678901234567890",
                    "maxTimeoutSeconds": 300,
                    "asset": "0x0000000000000000000000000000000000000000",
                    "extra": {},
                }
            ],
            "error": None,
        }
        encoded = safe_base64_encode(json.dumps(v1_data))
        decoded = decode_payment_required_header(encoded)

        assert isinstance(decoded, PaymentRequiredV1)
        assert decoded.x402_version == 1


class TestPaymentResponseHeader:
    """Tests for payment response header encoding/decoding."""

    def test_encode_settle_response(self):
        """Test encoding a SettleResponse."""
        settle = SettleResponse(
            success=True,
            transaction="0xabc123",
            network="eip155:8453",
            payer="0x1234567890123456789012345678901234567890",
        )
        result = encode_payment_response_header(settle)

        decoded_json = safe_base64_decode(result)
        data = json.loads(decoded_json)
        assert data["success"] is True
        assert data["transaction"] == "0xabc123"

    def test_decode_settle_response(self):
        """Test decoding a SettleResponse."""
        settle = SettleResponse(
            success=True,
            transaction="0xabc123",
            network="eip155:8453",
            payer="0x1234567890123456789012345678901234567890",
        )
        encoded = encode_payment_response_header(settle)
        decoded = decode_payment_response_header(encoded)

        assert decoded.success is True
        assert decoded.transaction == "0xabc123"
        assert decoded.network == "eip155:8453"

    def test_decode_failed_settle_response(self):
        """Test decoding a failed SettleResponse."""
        settle = SettleResponse(
            success=False,
            error_reason="Insufficient funds",
            transaction="",
            network="eip155:8453",
        )
        encoded = encode_payment_response_header(settle)
        decoded = decode_payment_response_header(encoded)

        assert decoded.success is False
        assert decoded.error_reason == "Insufficient funds"


class TestDetectPaymentRequiredVersion:
    """Tests for version detection."""

    def test_detect_v2_from_header(self):
        """Test detecting V2 from PAYMENT-REQUIRED header."""
        headers = {"PAYMENT-REQUIRED": "some-encoded-value"}
        version = detect_payment_required_version(headers)
        assert version == 2

    def test_detect_v2_from_lowercase_header(self):
        """Test detecting V2 from lowercase header."""
        headers = {"payment-required": "some-encoded-value"}
        version = detect_payment_required_version(headers)
        assert version == 2

    def test_detect_v1_from_header(self):
        """Test detecting V1 from X-PAYMENT header."""
        headers = {"X-PAYMENT": "some-encoded-value"}
        version = detect_payment_required_version(headers)
        assert version == 1

    def test_detect_v1_from_body(self):
        """Test detecting V1 from body."""
        headers = {}
        body = json.dumps({"x402Version": 1, "accepts": []}).encode("utf-8")
        version = detect_payment_required_version(headers, body)
        assert version == 1

    def test_detect_v2_from_body(self):
        """Test detecting V2 from body."""
        headers = {}
        body = json.dumps({"x402Version": 2, "accepts": []}).encode("utf-8")
        version = detect_payment_required_version(headers, body)
        assert version == 2

    def test_raises_on_no_version(self):
        """Test that ValueError is raised when version cannot be detected."""
        headers = {}
        with pytest.raises(ValueError, match="Could not detect x402 version"):
            detect_payment_required_version(headers)

    def test_raises_on_invalid_body(self):
        """Test that ValueError is raised with invalid body."""
        headers = {}
        body = b"not json"
        with pytest.raises(ValueError, match="Could not detect x402 version"):
            detect_payment_required_version(headers, body)


class TestHtmlsafeJsonDumps:
    """Tests for HTML-safe JSON serialization (XSS prevention)."""

    def test_escapes_less_than(self):
        """Test that < is escaped to prevent XSS."""
        result = htmlsafe_json_dumps({"script": "</script>"})
        assert "<" not in result
        assert "\\u003C" in result

    def test_escapes_greater_than(self):
        """Test that > is escaped to prevent XSS."""
        result = htmlsafe_json_dumps({"tag": "<script>"})
        assert ">" not in result
        assert "\\u003E" in result

    def test_escapes_ampersand(self):
        """Test that & is escaped to prevent XSS."""
        result = htmlsafe_json_dumps({"entity": "&amp;"})
        assert "&" not in result
        assert "\\u0026" in result

    def test_xss_script_injection(self):
        """Test that script tag injection is prevented."""
        malicious = {"payload": "</script><script>alert('xss')</script>"}
        result = htmlsafe_json_dumps(malicious)
        # Verify no raw script tags
        assert "</script>" not in result
        assert "<script>" not in result
        # Verify JSON is still valid when decoded
        decoded = json.loads(result)
        assert decoded == malicious

    def test_preserves_valid_json(self):
        """Test that normal JSON values are preserved."""
        data = {"key": "value", "number": 123, "bool": True, "null": None}
        result = htmlsafe_json_dumps(data)
        decoded = json.loads(result)
        assert decoded == data

    def test_nested_objects(self):
        """Test escaping in nested objects."""
        data = {"outer": {"inner": "<script>alert(1)</script>"}}
        result = htmlsafe_json_dumps(data)
        assert "<" not in result
        assert ">" not in result
        decoded = json.loads(result)
        assert decoded == data

    def test_arrays(self):
        """Test escaping in arrays."""
        data = ["<", ">", "&", "normal"]
        result = htmlsafe_json_dumps(data)
        assert "<" not in result.replace("\\u003C", "")
        assert ">" not in result.replace("\\u003E", "")
        assert "&" not in result.replace("\\u0026", "")
        decoded = json.loads(result)
        assert decoded == data

    def test_unicode_passthrough(self):
        """Test that other unicode characters pass through correctly."""
        data = {"emoji": "🔒", "chinese": "你好", "russian": "привет"}
        result = htmlsafe_json_dumps(data)
        decoded = json.loads(result)
        assert decoded == data
