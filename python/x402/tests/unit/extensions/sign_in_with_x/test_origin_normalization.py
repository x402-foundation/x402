"""Tests for SIWX configured origin normalization."""

from __future__ import annotations

import pytest

from x402.extensions.sign_in_with_x.hooks import normalize_configured_origin


@pytest.mark.parametrize(
    ("configured", "expected"),
    [
        ("https://api.example.com", "https://api.example.com"),
        ("https://api.example.com:443", "https://api.example.com"),
        ("http://api.example.com:80", "http://api.example.com"),
        ("https://api.example.com:8443", "https://api.example.com:8443"),
        ("https://API.Example.com", "https://api.example.com"),
        ("https://bücher.example", "https://xn--bcher-kva.example"),
        ("https://[::1]:8443", "https://[::1]:8443"),
        ("https://[::1]:443", "https://[::1]"),
    ],
)
def test_normalize_configured_origin_matches_whatwg(configured: str, expected: str) -> None:
    assert normalize_configured_origin(configured) == expected


@pytest.mark.parametrize(
    "configured",
    [
        "ftp://api.example.com",
        "https://user:pass@api.example.com",
        "https://api.example.com/path",
        "https://api.example.com?query=1",
        "https://api.example.com#fragment",
        "https://api.example.com:99999",
    ],
)
def test_normalize_configured_origin_rejects_invalid_origins(configured: str) -> None:
    with pytest.raises(ValueError):
        normalize_configured_origin(configured)
