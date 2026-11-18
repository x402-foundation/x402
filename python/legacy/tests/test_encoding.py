import pytest
from x402.encoding import safe_base64_encode, safe_base64_decode


def test_safe_base64_encode():
    # Test basic string encoding
    assert safe_base64_encode("hello") == "aGVsbG8="

    # Test empty string
    assert safe_base64_encode("") == ""

    # Test string with special characters
    assert safe_base64_encode("hello!@#$%^&*()") == "aGVsbG8hQCMkJV4mKigp"

    # Test string with unicode characters
    assert safe_base64_encode("hello 世界") == "aGVsbG8g5LiW55WM"

    # Test bytes input
    assert safe_base64_encode(b"hello") == "aGVsbG8="
    assert safe_base64_encode(b"\x00\x01\x02") == "AAEC"

    # Test non-utf8 bytes
    non_utf8_bytes = b"\xff\xfe\xfd"
    assert safe_base64_encode(non_utf8_bytes) == "//79"


def test_safe_base64_decode():
    # Test basic string decoding
    assert safe_base64_decode("aGVsbG8=") == "hello"

    # Test empty string
    assert safe_base64_decode("") == ""

    # Test string with special characters
    assert safe_base64_decode("aGVsbG8hQCMkJV4mKigp") == "hello!@#$%^&*()"

    # Test string with unicode characters
    assert safe_base64_decode("aGVsbG8g5LiW55WM") == "hello 世界"

    # Test invalid base64
    with pytest.raises(Exception):
        safe_base64_decode("invalid base64!")

    # Test base64 with invalid padding
    with pytest.raises(Exception):
        safe_base64_decode("aGVsbG8")

    # Test non-utf8 bytes (should raise UnicodeDecodeError)
    with pytest.raises(UnicodeDecodeError):
        safe_base64_decode("//79")  # This is the base64 encoding of \xff\xfe\xfd


def test_encode_decode_roundtrip():
    test_strings = [
        "hello",
        "",
        "hello!@#$%^&*()",
        "hello 世界",
        "test123",
        "!@#$%^&*()_+",
        "Hello, World!",
    ]

    for test_str in test_strings:
        encoded = safe_base64_encode(test_str)
        decoded = safe_base64_decode(encoded)
        assert decoded == test_str, f"Roundtrip failed for string: {test_str}"

    # Test utf-8 bytes roundtrip
    test_bytes = [
        b"hello",
        b"",
        b"\x00\x01\x02",
    ]

    for test_bytes in test_bytes:
        encoded = safe_base64_encode(test_bytes)
        decoded = safe_base64_decode(encoded)
        assert decoded == test_bytes.decode("utf-8"), (
            f"Roundtrip failed for bytes: {test_bytes}"
        )
