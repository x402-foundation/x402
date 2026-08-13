"""Route matching tests for the shared HTTP server base.

Regression coverage for wildcard (`*`) route patterns, path normalization
bypasses (CWE-436), and a payment-gate bypass via a line feed.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from x402.http.types import HTTPRequestContext, RouteConfig
from x402.http.x402_http_server_base import x402HTTPServerBase


def _context(path: str, method: str = "GET") -> HTTPRequestContext:
    """Build a request context that carries an explicit path and method.

    The adapter is only consulted when ``method`` is empty, so a bare
    MagicMock is sufficient for route-matching tests.
    """
    return HTTPRequestContext(adapter=MagicMock(), path=path, method=method)


class TestWildcardLineFeedBypass:
    """A wildcard segment must match a line feed like any other character.

    The compiled route regex expands ``*`` to ``.*?``. Without the ``re.DOTALL``
    flag, ``.`` does not match ``\\n``, so a request path whose wildcard tail
    contains a (decoded) line feed fails to match its own protected route. When
    the route misses, ``requires_payment`` returns ``False`` and the middleware
    serves the protected resource with no payment verification or settlement.
    """

    def _server(self) -> x402HTTPServerBase:
        return x402HTTPServerBase(
            MagicMock(),
            {"GET /api/premium/*": RouteConfig(accepts=[])},
        )

    def test_plain_wildcard_path_requires_payment(self) -> None:
        # Baseline: an ordinary sub-path of the wildcard route is protected.
        assert self._server().requires_payment(_context("/api/premium/report")) is True

    def test_unrelated_path_does_not_require_payment(self) -> None:
        # Guard against a fix that makes every path match.
        assert self._server().requires_payment(_context("/public/report")) is False

    @pytest.mark.parametrize(
        "path",
        [
            "/api/premium/re\nport",  # decoded LF mid-segment (what an ASGI server delivers)
            "/api/premium/re%0Aport",  # percent-encoded LF, decoded by _normalize_path
            "/api/premium/a\n/b",  # LF before a later segment boundary
        ],
        ids=["decoded-lf", "encoded-lf", "lf-before-segment"],
    )
    def test_line_feed_in_wildcard_tail_still_requires_payment(self, path: str) -> None:
        assert self._server().requires_payment(_context(path)) is True


class TestNormalizePath:
    @pytest.mark.parametrize(
        ("input_path", "expected"),
        [
            ("/api", "/api"),
            ("/api/", "/api"),
            ("/api//users", "/api/users"),
            ("/api?query=1", "/api"),
            ("/api#fragment", "/api"),
            ("/api%20space", "/api space"),
            ("", "/"),
            ("/api/users/x%2Fy", "/api/users/x%2Fy"),
            ("/api/users/x%2fy", "/api/users/x%2Fy"),
            ("/api/users/x%5Cy", "/api/users/x%5Cy"),
            ("/api/users/x%252Fy", "/api/users/x%2Fy"),
            ("/api/users/x%zzy", "/api/users/x%zzy"),
        ],
    )
    def test_normalize_path(self, input_path: str, expected: str) -> None:
        assert x402HTTPServerBase._normalize_path(input_path) == expected


class TestRouteMatchingPathNormalizationBypass:
    @pytest.mark.parametrize(
        ("pattern", "escaped_path", "should_match"),
        [
            ("GET /api/users/:id", "/api/users/1", True),
            ("GET /api/users/:id", "/api/users/x%2Fy", True),
            ("GET /api/users/:id", "/api/users/x%2fy", True),
            ("GET /api/users/:id", "/api/users/x%252Fy", True),
            ("GET /api/users/:id", "/api/users/x%5Cy", True),
            ("GET /api/users/:id", "/api/users/x%25y", True),
            ("GET /api/users/[id]", "/api/users/x%2Fy", True),
            ("GET /api/users/:id", "/api/users/x/y", False),
            ("GET /api/premium/*", "/api/premium/abc", True),
            ("GET /api/premium/*", "/api/premium/", True),
            ("GET /api/premium/*", "/api/premium", True),
            ("GET /api/premium/*", "/api/premium/a/b/c", True),
            ("GET /api/premium/*", "/api/premiumx", False),
            ("GET /api/premium/*", "/api/other", False),
            ("GET /api/compute", "/api/compute", True),
            ("GET /api/compute", "/api/compute/", True),
            ("GET /api/compute", "/api/computex", False),
        ],
        ids=[
            "param-baseline",
            "param-encoded-slash",
            "param-lowercase-encoded-slash",
            "param-double-encoded-slash",
            "param-encoded-backslash",
            "param-encoded-percent",
            "bracket-param-encoded-slash",
            "param-real-extra-segment",
            "wildcard-baseline",
            "wildcard-trailing-slash",
            "wildcard-bare-prefix",
            "wildcard-deep-path",
            "wildcard-sibling-prefix",
            "wildcard-unrelated",
            "static-baseline",
            "static-trailing-slash",
            "static-unrelated",
        ],
    )
    def test_route_regex_matches_normalized_path(
        self, pattern: str, escaped_path: str, should_match: bool
    ) -> None:
        server = x402HTTPServerBase(MagicMock(), {pattern: RouteConfig(accepts=[])})
        assert server.requires_payment(_context(escaped_path)) is should_match
