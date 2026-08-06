"""Shared bazaar extension utilities for middleware packages.

Provides startup-time bazaar extension detection, registration, and validation
used by both FastAPI and Flask middleware.
"""

from __future__ import annotations

import warnings
from typing import Any

from ..types import RouteConfig, RoutesConfig


def check_if_bazaar_needed(routes: RoutesConfig) -> bool:
    """Check if any routes in the configuration declare bazaar extensions.

    Args:
        routes: Route configuration.

    Returns:
        True if any route has extensions.bazaar defined.
    """
    if isinstance(routes, RouteConfig):
        return bool(routes.extensions and "bazaar" in routes.extensions)

    if isinstance(routes, dict):
        if "accepts" in routes:
            extensions = routes.get("extensions", {})
            return bool(extensions and "bazaar" in extensions)

        for route_config in routes.values():
            if isinstance(route_config, RouteConfig):
                if route_config.extensions and "bazaar" in route_config.extensions:
                    return True
            elif isinstance(route_config, dict):
                extensions = route_config.get("extensions", {})
                if extensions and "bazaar" in extensions:
                    return True

    return False


def register_bazaar_extension(server: Any) -> None:
    """Register bazaar extension with server if available.

    Works with both x402ResourceServer (async) and x402ResourceServerSync.

    Args:
        server: Resource server to register extension with.
    """
    try:
        from ...extensions.bazaar import bazaar_resource_server_extension

        server.register_extension(bazaar_resource_server_extension)
    except ImportError:
        pass


def validate_bazaar_extensions(routes: RoutesConfig) -> None:
    """Validate bazaar extensions on all routes using the extension's JSON-schema validator.

    Emits warnings for invalid extensions but does not block startup.

    Args:
        routes: Route configuration.
    """
    try:
        from ...extensions.bazaar import (
            validate_discovery_extension,
            validate_discovery_extension_spec,
        )
    except ImportError:
        return

    entries: list[tuple[str, Any]] = []
    if isinstance(routes, RouteConfig):
        entries = [("*", routes)]
    elif isinstance(routes, dict):
        if "accepts" in routes:
            entries = [("*", routes)]
        else:
            entries = list(routes.items())

    for pattern, config in entries:
        extensions = None
        if isinstance(config, RouteConfig):
            extensions = config.extensions
        elif isinstance(config, dict):
            extensions = config.get("extensions")

        if not extensions or "bazaar" not in extensions:
            continue

        bazaar_ext = extensions["bazaar"]
        if (
            not isinstance(bazaar_ext, dict)
            or "info" not in bazaar_ext
            or "schema" not in bazaar_ext
        ):
            warnings.warn(
                f'x402: Route "{pattern}" declares a bazaar extension but it is malformed '
                f'(expected a dict with "info" and "schema" fields)',
                stacklevel=3,
            )
            continue

        try:
            spec_result = validate_discovery_extension_spec(bazaar_ext)
            if not spec_result.valid:
                warnings.warn(
                    f'x402: Route "{pattern}" has an invalid bazaar extension: '
                    f"{', '.join(spec_result.errors)}",
                    stacklevel=3,
                )
                continue
            result = validate_discovery_extension(bazaar_ext)
            if not result.valid:
                warnings.warn(
                    f'x402: Route "{pattern}" has an invalid bazaar extension: '
                    f"{', '.join(result.errors)}",
                    stacklevel=3,
                )
        except Exception:
            pass
