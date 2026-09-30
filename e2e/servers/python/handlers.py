"""Response bodies and startup output shared by the Python e2e servers.

Everything here is derived from the mechanisms catalog, so fastapi/flask never
name a network, a route, or a price.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

from catalog import (
    PROTECTED_ROUTE_MESSAGE,
    catalog_routes,
    server_address_env_key,
    served_networks,
)

HEALTH_PATH = "/health"
CLOSE_PATH = "/close"


def unconfigured_error_for_path(path: str) -> dict[str, str] | None:
    """Return a 501 payload when path is a catalog route with no payee configured."""
    for route in catalog_routes():
        if route.path != path:
            continue
        env_key = server_address_env_key(route.network)
        if os.getenv(env_key):
            return None
        return {
            "error": f"{route.network.upper()} payments not configured",
            "message": f"{env_key} environment variable is not set",
        }
    return None


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def route_body() -> dict[str, Any]:
    """JSON body a paid route's handler returns."""
    return {"message": PROTECTED_ROUTE_MESSAGE, "timestamp": _timestamp()}


def health_body(server: str) -> dict[str, Any]:
    """`/health` payload, reporting the networks this server actually serves."""
    return {
        "status": "healthy",
        "timestamp": _timestamp(),
        "server": server,
        "networks": {
            served.id: {"network": served.network, "payee": served.pay_to}
            for served in served_networks()
        },
    }


def close_body() -> dict[str, Any]:
    """`/close` payload."""
    return {"message": "Server shutting down gracefully", "timestamp": _timestamp()}


def print_startup_banner(title: str, port: int, facilitator_url: str | None) -> None:
    """Report the networks and endpoints resolved from the catalog."""
    print(f"{title} on port {port}")
    for served in served_networks():
        print(f"  {served.id}: {served.network} → {served.pay_to}")
    print(f"Using facilitator: {facilitator_url}")
    for route in catalog_routes():
        print(f"  GET  {route.path}  ({route.network} {route.scheme})")
    print(f"  GET  {HEALTH_PATH}  (no payment required)")
    print(f"  POST {CLOSE_PATH}  (shutdown server)")
    print("Server listening on port", port)
