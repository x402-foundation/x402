"""Route matching tests for the shared HTTP server base.

Regression coverage for wildcard (`*`) route patterns and a payment-gate
bypass via a line feed, which a naive `.` wildcard cannot cross.
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
