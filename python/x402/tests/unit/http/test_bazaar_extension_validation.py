"""Tests for startup-time bazaar extension validation in middleware packages."""

from __future__ import annotations

import warnings
from unittest.mock import MagicMock, patch

import pytest

from x402.http.types import (
    PaymentOption,
    RouteConfig,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_payment_option():
    return PaymentOption(
        scheme="exact",
        pay_to="0x123",
        price="$0.01",
        network="eip155:84532",
    )


# ---------------------------------------------------------------------------
# FastAPI middleware validation tests
# ---------------------------------------------------------------------------


class TestFastAPIBazaarExtensionValidation:
    """Tests for bazaar extension validation in FastAPI middleware startup."""

    def test_no_extension_no_warning(self):
        """A route with no extensions should produce no bazaar warning."""
        from x402.http.middleware.fastapi import _validate_bazaar_extensions

        routes = {
            "GET /api/data": RouteConfig(
                accepts=[_make_payment_option()],
                extensions=None,
            )
        }

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            _validate_bazaar_extensions(routes)

        bazaar_warnings = [w for w in caught if "bazaar" in str(w.message).lower()]
        assert len(bazaar_warnings) == 0

    def test_valid_extension_no_warning(self):
        """A route with a valid bazaar extension should produce no warning."""
        from x402.http.middleware.fastapi import _validate_bazaar_extensions

        routes = {
            "GET /api/data": RouteConfig(
                accepts=[_make_payment_option()],
                extensions={
                    "bazaar": {
                        "info": {
                            "input": {"type": "http", "method": "GET"},
                            "output": {"type": "string"},
                        },
                        "schema": {
                            "type": "object",
                            "properties": {
                                "input": {"type": "object"},
                                "output": {"type": "object"},
                            },
                            "required": ["input"],
                        },
                    }
                },
            )
        }

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            _validate_bazaar_extensions(routes)

        bazaar_warnings = [w for w in caught if "bazaar" in str(w.message).lower()]
        assert len(bazaar_warnings) == 0

    def test_invalid_extension_emits_warning(self):
        """A route with schema requiring fields absent from info should emit a warning."""
        from x402.http.middleware.fastapi import _validate_bazaar_extensions

        routes = {
            "GET /api/data": RouteConfig(
                accepts=[_make_payment_option()],
                extensions={
                    "bazaar": {
                        "info": {
                            "input": {"type": "http", "method": "GET"},
                        },
                        "schema": {
                            "type": "object",
                            "properties": {
                                "input": {"type": "object"},
                                "jobs": {"type": "array"},
                                "count": {"type": "integer"},
                            },
                            "required": ["input", "jobs", "count"],
                        },
                    }
                },
            )
        }

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            _validate_bazaar_extensions(routes)

        bazaar_warnings = [w for w in caught if "bazaar" in str(w.message).lower()]
        assert len(bazaar_warnings) == 1
        assert "invalid bazaar extension" in str(bazaar_warnings[0].message).lower()

    def test_non_bazaar_extension_not_warned(self):
        """Non-bazaar extensions should not trigger bazaar warnings."""
        from x402.http.middleware.fastapi import _validate_bazaar_extensions

        routes = {
            "GET /api/data": RouteConfig(
                accepts=[_make_payment_option()],
                extensions={
                    "other-extension": {
                        "info": {},
                        "schema": {"required": ["missing_field"]},
                    }
                },
            )
        }

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            _validate_bazaar_extensions(routes)

        bazaar_warnings = [w for w in caught if "bazaar" in str(w.message).lower()]
        assert len(bazaar_warnings) == 0

    def test_validation_skipped_when_bazaar_unavailable(self):
        """When bazaar validation is not importable, no exception should be raised."""
        from x402.http.middleware.fastapi import _validate_bazaar_extensions

        routes = {
            "GET /api/data": RouteConfig(
                accepts=[_make_payment_option()],
                extensions={
                    "bazaar": {
                        "info": {},
                        "schema": {"required": ["missing_field"]},
                    }
                },
            )
        }

        with patch(
            "x402.http.middleware.fastapi._validate_bazaar_extensions.__module__",
            side_effect=ImportError,
        ):
            with warnings.catch_warnings(record=True):
                warnings.simplefilter("always")
                _validate_bazaar_extensions(routes)


# ---------------------------------------------------------------------------
# Flask middleware validation tests
# ---------------------------------------------------------------------------


try:
    import flask as _flask  # noqa: F401

    _HAS_FLASK = True
except ImportError:
    _HAS_FLASK = False


@pytest.mark.skipif(not _HAS_FLASK, reason="flask not installed")
class TestFlaskBazaarExtensionValidation:
    """Tests for bazaar extension validation in Flask middleware startup."""

    def test_no_extension_no_warning(self):
        """A route with no extensions should produce no bazaar warning."""
        from x402.http.middleware.flask import _validate_bazaar_extensions

        routes = {
            "GET /api/data": RouteConfig(
                accepts=[_make_payment_option()],
                extensions=None,
            )
        }

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            _validate_bazaar_extensions(routes)

        bazaar_warnings = [w for w in caught if "bazaar" in str(w.message).lower()]
        assert len(bazaar_warnings) == 0

    def test_valid_extension_no_warning(self):
        """A route with a valid bazaar extension should produce no warning."""
        from x402.http.middleware.flask import _validate_bazaar_extensions

        routes = {
            "GET /api/data": RouteConfig(
                accepts=[_make_payment_option()],
                extensions={
                    "bazaar": {
                        "info": {
                            "input": {"type": "http", "method": "GET"},
                            "output": {"type": "string"},
                        },
                        "schema": {
                            "type": "object",
                            "properties": {
                                "input": {"type": "object"},
                                "output": {"type": "object"},
                            },
                            "required": ["input"],
                        },
                    }
                },
            )
        }

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            _validate_bazaar_extensions(routes)

        bazaar_warnings = [w for w in caught if "bazaar" in str(w.message).lower()]
        assert len(bazaar_warnings) == 0

    def test_invalid_extension_emits_warning(self):
        """A route with an invalid bazaar extension should emit a warning."""
        from x402.http.middleware.flask import _validate_bazaar_extensions

        routes = {
            "GET /api/data": RouteConfig(
                accepts=[_make_payment_option()],
                extensions={
                    "bazaar": {
                        "info": {
                            "input": {"type": "http", "method": "GET"},
                        },
                        "schema": {
                            "type": "object",
                            "properties": {
                                "input": {"type": "object"},
                                "jobs": {"type": "array"},
                                "count": {"type": "integer"},
                            },
                            "required": ["input", "jobs", "count"],
                        },
                    }
                },
            )
        }

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            _validate_bazaar_extensions(routes)

        bazaar_warnings = [w for w in caught if "bazaar" in str(w.message).lower()]
        assert len(bazaar_warnings) == 1
        assert "invalid bazaar extension" in str(bazaar_warnings[0].message).lower()


# ---------------------------------------------------------------------------
# Core server base no longer validates bazaar extensions
# ---------------------------------------------------------------------------


class TestCoreNoLongerValidatesBazaar:
    """Verify that the core HTTP server base does not emit bazaar warnings."""

    def test_core_does_not_warn_on_invalid_bazaar(self):
        """Core _validate_route_configuration should not emit bazaar warnings."""
        from x402.http.x402_http_server_base import x402HTTPServerBase

        mock_server = MagicMock()
        mock_server.has_registered_scheme.return_value = True
        mock_server.get_supported_kind.return_value = "exact"

        routes = {
            "GET /api/data": RouteConfig(
                accepts=[_make_payment_option()],
                extensions={
                    "bazaar": {
                        "info": {"input": {"type": "http", "method": "GET"}},
                        "schema": {
                            "type": "object",
                            "properties": {"input": {"type": "object"}, "jobs": {"type": "array"}},
                            "required": ["input", "jobs"],
                        },
                    }
                },
            )
        }

        base = x402HTTPServerBase.__new__(x402HTTPServerBase)
        base._server = mock_server
        base._routes_config = routes
        base._compiled_routes = []
        base._paywall_provider = None
        base._compile_routes(routes)

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            errors = base._validate_route_configuration()

        assert errors == []
        bazaar_warnings = [w for w in caught if "bazaar" in str(w.message).lower()]
        assert len(bazaar_warnings) == 0


# ---------------------------------------------------------------------------
# Spec-level validation tests
# ---------------------------------------------------------------------------


class TestValidateDiscoveryExtensionSpec:
    """Tests for validate_discovery_extension_spec protocol-level validation."""

    def test_valid_http_get_extension(self):
        from x402.extensions.bazaar import validate_discovery_extension_spec

        ext = {
            "info": {"input": {"type": "http", "method": "GET"}},
            "schema": {},
        }
        result = validate_discovery_extension_spec(ext)
        assert result.valid

    def test_valid_http_post_extension(self):
        from x402.extensions.bazaar import validate_discovery_extension_spec

        ext = {
            "info": {"input": {"type": "http", "method": "POST", "bodyType": "json", "body": {}}},
            "schema": {},
        }
        result = validate_discovery_extension_spec(ext)
        assert result.valid

    def test_valid_mcp_extension(self):
        from x402.extensions.bazaar import validate_discovery_extension_spec

        ext = {
            "info": {
                "input": {
                    "type": "mcp",
                    "toolName": "my_tool",
                    "inputSchema": {"type": "object"},
                }
            },
            "schema": {},
        }
        result = validate_discovery_extension_spec(ext)
        assert result.valid

    def test_pre_enrichment_http_no_method(self):
        """Pre-enrichment HTTP extensions omit method and should pass."""
        from x402.extensions.bazaar import validate_discovery_extension_spec

        ext = {"info": {"input": {"type": "http"}}, "schema": {}}
        result = validate_discovery_extension_spec(ext)
        assert result.valid

    def test_invalid_input_type(self):
        from x402.extensions.bazaar import validate_discovery_extension_spec

        ext = {"info": {"input": {"type": "grpc"}}, "schema": {}}
        result = validate_discovery_extension_spec(ext)
        assert not result.valid
        assert any("input.type" in e for e in result.errors)

    def test_invalid_http_method(self):
        from x402.extensions.bazaar import validate_discovery_extension_spec

        ext = {"info": {"input": {"type": "http", "method": "DESTROY"}}, "schema": {}}
        result = validate_discovery_extension_spec(ext)
        assert not result.valid
        assert any("method" in e for e in result.errors)

    def test_invalid_body_type(self):
        from x402.extensions.bazaar import validate_discovery_extension_spec

        ext = {
            "info": {"input": {"type": "http", "method": "POST", "bodyType": "xml"}},
            "schema": {},
        }
        result = validate_discovery_extension_spec(ext)
        assert not result.valid
        assert any("bodyType" in e for e in result.errors)

    def test_body_type_with_non_body_method(self):
        from x402.extensions.bazaar import validate_discovery_extension_spec

        ext = {
            "info": {"input": {"type": "http", "method": "GET", "bodyType": "json"}},
            "schema": {},
        }
        result = validate_discovery_extension_spec(ext)
        assert not result.valid
        assert any("not a body method" in e for e in result.errors)

    def test_mcp_missing_tool_name(self):
        from x402.extensions.bazaar import validate_discovery_extension_spec

        ext = {
            "info": {"input": {"type": "mcp", "inputSchema": {"type": "object"}}},
            "schema": {},
        }
        result = validate_discovery_extension_spec(ext)
        assert not result.valid
        assert any("toolName" in e for e in result.errors)

    def test_mcp_missing_input_schema(self):
        from x402.extensions.bazaar import validate_discovery_extension_spec

        ext = {"info": {"input": {"type": "mcp", "toolName": "t"}}, "schema": {}}
        result = validate_discovery_extension_spec(ext)
        assert not result.valid
        assert any("inputSchema" in e for e in result.errors)

    def test_mcp_invalid_transport(self):
        from x402.extensions.bazaar import validate_discovery_extension_spec

        ext = {
            "info": {
                "input": {
                    "type": "mcp",
                    "toolName": "t",
                    "inputSchema": {"type": "object"},
                    "transport": "websocket",
                }
            },
            "schema": {},
        }
        result = validate_discovery_extension_spec(ext)
        assert not result.valid
        assert any("transport" in e for e in result.errors)

    def test_missing_info(self):
        from x402.extensions.bazaar import validate_discovery_extension_spec

        result = validate_discovery_extension_spec({"schema": {}})
        assert not result.valid

    def test_missing_input(self):
        from x402.extensions.bazaar import validate_discovery_extension_spec

        result = validate_discovery_extension_spec({"info": {}, "schema": {}})
        assert not result.valid


# ---------------------------------------------------------------------------
# Shared middleware utilities tests
# ---------------------------------------------------------------------------


class TestSharedBazaarUtils:
    """Tests for the shared _bazaar_utils module."""

    def test_check_if_bazaar_needed_with_bazaar(self):
        from x402.http.middleware._bazaar_utils import check_if_bazaar_needed

        routes = {
            "GET /api": RouteConfig(
                accepts=[_make_payment_option()],
                extensions={"bazaar": {}},
            )
        }
        assert check_if_bazaar_needed(routes) is True

    def test_check_if_bazaar_needed_without_bazaar(self):
        from x402.http.middleware._bazaar_utils import check_if_bazaar_needed

        routes = {
            "GET /api": RouteConfig(
                accepts=[_make_payment_option()],
                extensions=None,
            )
        }
        assert check_if_bazaar_needed(routes) is False

    def test_validate_no_warning_on_valid(self):
        from x402.http.middleware._bazaar_utils import validate_bazaar_extensions

        routes = {
            "GET /api": RouteConfig(
                accepts=[_make_payment_option()],
                extensions={
                    "bazaar": {
                        "info": {
                            "input": {"type": "http", "method": "GET"},
                            "output": {"type": "string"},
                        },
                        "schema": {
                            "type": "object",
                            "properties": {
                                "input": {"type": "object"},
                                "output": {"type": "object"},
                            },
                            "required": ["input"],
                        },
                    }
                },
            )
        }

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            validate_bazaar_extensions(routes)

        bazaar_warnings = [w for w in caught if "bazaar" in str(w.message).lower()]
        assert len(bazaar_warnings) == 0

    def test_validate_warns_on_spec_violation(self):
        from x402.http.middleware._bazaar_utils import validate_bazaar_extensions

        routes = {
            "GET /api": RouteConfig(
                accepts=[_make_payment_option()],
                extensions={
                    "bazaar": {
                        "info": {"input": {"type": "grpc"}},
                        "schema": {"type": "object"},
                    }
                },
            )
        }

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            validate_bazaar_extensions(routes)

        bazaar_warnings = [w for w in caught if "bazaar" in str(w.message).lower()]
        assert len(bazaar_warnings) == 1
        assert "invalid bazaar extension" in str(bazaar_warnings[0].message).lower()
