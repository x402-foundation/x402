"""MCP E2E Test Server with x402 Payment-Wrapped Tools.

Thin MCP adapter over the same mechanisms catalog the HTTP frameworks use: one
tool per resolved route, each wrapped with ``create_payment_wrapper`` using
payment requirements built from the same ``accepts`` config
``build_payment_routes`` feeds the HTTP middleware. Tools take no arguments
and return the fixed ``{message, timestamp}`` body every HTTP route returns.
"""

from __future__ import annotations

import os
import threading
from typing import Any


def main() -> None:
    """Start the MCP server with x402 payment-wrapped tools."""
    import uvicorn
    from mcp.server.fastmcp import FastMCP
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    from x402 import ResourceConfig, ResourceInfo, x402ResourceServer
    from x402.http import FacilitatorConfig, HTTPFacilitatorClient
    from x402.mcp import create_payment_wrapper

    from catalog import PROTECTED_ROUTE_MESSAGE, catalog_routes, mcp_tool_name, resolve_routes, route_description
    from config import build_resolved_route_config, configure_resource_server, load_server_config
    from handlers import CLOSE_PATH, HEALTH_PATH, close_body, health_body, route_body

    cfg = load_server_config()

    mcp = FastMCP("x402 MCP E2E Server")

    facilitator_client = HTTPFacilitatorClient(FacilitatorConfig(url=cfg.facilitator_url))
    resource_server = x402ResourceServer(facilitator_client)
    configure_resource_server(resource_server, cfg)
    resource_server.initialize()

    # Tool descriptions come from the unresolved catalog routes (which still
    # carry `asset_transfer_method`), so unconfigured networks get sensible
    # descriptions too even though they never register a tool below.
    tool_descriptions = {
        route.path: route_description(
            route.network, route.scheme, route.asset_transfer_method, route.extensions, route.payment_flow
        )
        for route in catalog_routes()
    }

    def register_route_tool(route: Any) -> None:
        tool_name = mcp_tool_name(route.path)
        description = tool_descriptions.get(route.path, f"Paid MCP tool for {route.path}")
        route_config = build_resolved_route_config(route, "mcp")
        accepts_cfg = route_config["accepts"]
        accepts = resource_server.build_payment_requirements(
            ResourceConfig(
                scheme=accepts_cfg["scheme"],
                pay_to=accepts_cfg["payTo"],
                network=accepts_cfg["network"],
                price=accepts_cfg["price"],
                extra=accepts_cfg.get("extra"),
            )
        )
        wrapper = create_payment_wrapper(
            resource_server,
            accepts=accepts,
            resource=ResourceInfo(
                url=f"mcp://tool/{tool_name}",
                description=description,
                mime_type="application/json",
            ),
            extensions=route_config.get("extensions"),
        )

        @mcp.tool(name=tool_name, description=description)
        @wrapper
        async def _tool() -> str:
            import json
            from datetime import datetime, timezone

            return json.dumps(
                {
                    "message": PROTECTED_ROUTE_MESSAGE,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
            )

    for route in resolve_routes():
        register_route_tool(route)

    @mcp.tool(name="ping", description="A free health check tool")
    def ping() -> str:
        return "pong"

    async def health(request):
        return JSONResponse(health_body("mcp"))

    async def close(request):
        response = JSONResponse(close_body())

        def shutdown():
            import time

            time.sleep(0.1)
            os._exit(0)

        threading.Thread(target=shutdown, daemon=True).start()
        return response

    async def on_startup() -> None:
        # Emitted from the ASGI startup hook (not before uvicorn.run()) so the
        # "Server listening" log only appears once the socket is actually
        # bound and the app is ready to accept requests.
        print(f"Server listening on port {cfg.port}", flush=True)
        print(f"SSE endpoint: http://localhost:{cfg.port}/sse", flush=True)
        print(f"Health: http://localhost:{cfg.port}{HEALTH_PATH}", flush=True)

    mcp_app = mcp.sse_app()

    app = Starlette(
        routes=[
            Route(HEALTH_PATH, health, methods=["GET"]),
            Route(CLOSE_PATH, close, methods=["POST"]),
        ],
        on_startup=[on_startup],
    )

    # Mount MCP SSE app at root so /sse and /messages work
    app.mount("/", mcp_app)

    uvicorn.run(app, host="0.0.0.0", port=cfg.port, log_level="warning")


if __name__ == "__main__":
    main()
