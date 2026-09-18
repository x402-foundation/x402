"""Route matching tests for the shared HTTP server base.

Regression coverage for wildcard (`*`) route patterns, path normalization
bypasses (CWE-436), and a payment-gate bypass via a line feed.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from x402 import x402ResourceServer
from x402.http.types import HTTPRequestContext, PaymentOption, RouteConfig, RouteConfigurationError
from x402.http.x402_http_server_base import x402HTTPServerBase


def _context(path: str, method: str = "GET", decoded_path: str | None = None) -> HTTPRequestContext:
    """Build a request context that carries an explicit path and method.

    The adapter is only consulted when ``method`` is empty, so a bare
    MagicMock is sufficient for route-matching tests.
    """
    return HTTPRequestContext(
        adapter=MagicMock(), path=path, method=method, decoded_path=decoded_path
    )


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


class TestNormalizeDecodedPath:
    """``_normalize_decoded_path`` normalizes structure only, and must not
    re-decode percent-escapes since the input is already framework-decoded.
    """

    @pytest.mark.parametrize(
        ("input_path", "expected"),
        [
            ("/api", "/api"),
            ("/api/", "/api"),
            ("/api//users", "/api/users"),
            ("/api?query=1", "/api"),
            ("/api#fragment", "/api"),
            ("", "/"),
            # Already-decoded input is passed through, not re-decoded.
            ("/api/x%41", "/api/x%41"),
            ("/api/premium", "/api/premium"),
        ],
    )
    def test_normalize_decoded_path(self, input_path: str, expected: str) -> None:
        assert x402HTTPServerBase._normalize_decoded_path(input_path) == expected


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


class TestDecodedPathDivergenceBypass:
    """A literal route must be protected regardless of which path
    representation (escaped or decoded) a given framework routes on.
    """

    def _server(self, pattern: str = "GET /api/premium") -> x402HTTPServerBase:
        return x402HTTPServerBase(MagicMock(), {pattern: RouteConfig(accepts=[])})

    @pytest.mark.parametrize(
        "escaped_path",
        [
            "/api%2Fpremium",
            "/api%2fpremium",
            "/%61pi%2Fpremium",
        ],
        ids=["encoded-slash", "lowercase-encoded-slash", "encoded-slash-and-letter"],
    )
    def test_literal_route_requires_payment_when_decoded_path_matches(
        self, escaped_path: str
    ) -> None:
        context = _context(escaped_path, decoded_path="/api/premium")
        assert self._server().requires_payment(context) is True

    def test_literal_route_misses_without_decoded_path(self) -> None:
        # Pre-fix behavior: only the escaped path is checked.
        context = _context("/api%2Fpremium", decoded_path=None)
        assert self._server().requires_payment(context) is False

    def test_real_extra_segment_still_not_matched(self) -> None:
        # Guard against over-matching a genuinely different resource.
        context = _context("/api/users/x/y", decoded_path="/api/users/x/y")
        server = self._server(pattern="GET /api/users/:id")
        assert server.requires_payment(context) is False

    def test_unrelated_decoded_path_does_not_require_payment(self) -> None:
        context = _context("/public/report", decoded_path="/public/report")
        assert self._server().requires_payment(context) is False


class _ExactAuthorizeScheme:
    scheme = "exact"
    default_asset_transfer_method = "default"
    payment_flows = {
        "default": {"supported": ("authorization",), "default": "authorization"},
    }


class TestPaymentFlowRouteValidation:
    def _server(self) -> x402ResourceServer:
        resource_server = x402ResourceServer()
        resource_server.register("eip155:8453", _ExactAuthorizeScheme())
        return resource_server

    def test_unsupported_payment_flow_at_construction(self) -> None:
        with pytest.raises(RouteConfigurationError) as exc:
            x402HTTPServerBase(
                self._server(),
                {
                    "GET /api/data": RouteConfig(
                        accepts=PaymentOption(
                            scheme="exact",
                            pay_to="0x123",
                            price="$0.01",
                            network="eip155:8453",
                            extra={"paymentFlow": "escrow"},
                        )
                    )
                },
            )
        assert len(exc.value.errors) == 1
        assert exc.value.errors[0].reason == "unsupported_payment_flow"
        assert "does not support paymentFlow" in exc.value.errors[0].message

    def test_unsupported_asset_transfer_method_at_construction(self) -> None:
        with pytest.raises(RouteConfigurationError) as exc:
            x402HTTPServerBase(
                self._server(),
                {
                    "GET /api/data": RouteConfig(
                        accepts=PaymentOption(
                            scheme="exact",
                            pay_to="0x123",
                            price="$0.01",
                            network="eip155:8453",
                            extra={"assetTransferMethod": "not-a-real-atm"},
                        )
                    )
                },
            )
        assert len(exc.value.errors) == 1
        assert exc.value.errors[0].reason == "unsupported_asset_transfer_method"
        assert "does not support assetTransferMethod" in exc.value.errors[0].message
