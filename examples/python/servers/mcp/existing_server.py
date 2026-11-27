"""MCP Server with x402 Paid Tools - Existing Server Integration.

This example demonstrates the LOW-LEVEL API using create_payment_wrapper.
Use this approach when you have an EXISTING MCP server and want to add
x402 payment to specific tools without adopting the full x402MCPServer abstraction.

Run with: python main.py existing
"""

import json
import os
import random
import sys
from typing import Any

from dotenv import load_dotenv
from mcp.server.fastmcp import Context, FastMCP
from mcp.types import CallToolResult

from x402.http import FacilitatorConfig, HTTPFacilitatorClientSync
from x402.mcp import (
    MCPToolResult,
    ResourceInfo,
    SyncPaymentWrapperConfig,
    create_payment_wrapper_sync,
)
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.schemas import ResourceConfig
from x402.server import x402ResourceServerSync

load_dotenv()

EVM_ADDRESS = os.getenv("EVM_ADDRESS")
FACILITATOR_URL = os.getenv("FACILITATOR_URL", "https://x402.org/facilitator")
PORT = int(os.getenv("PORT", "4022"))

if not EVM_ADDRESS:
    print("EVM_ADDRESS environment variable is required")
    sys.exit(1)


def get_weather_data(city: str) -> dict[str, Any]:
    """Simulate fetching weather data for a city."""
    conditions = ["sunny", "cloudy", "rainy", "snowy", "windy"]
    weather = random.choice(conditions)
    temperature = random.randint(40, 80)
    return {"city": city, "weather": weather, "temperature": temperature}


def call_paid_tool(
    paid_tool: Any,
    tool_name: str,
    arguments: dict[str, Any],
    ctx: Context,
) -> CallToolResult:
    """Call a sync payment wrapper from a FastMCP tool.

    ``extra["_meta"]`` carries the payment payload from the request metadata.
    """
    request_meta = ctx.request_context.meta
    meta = dict(request_meta.model_extra or {}) if request_meta is not None else {}
    result = paid_tool(arguments, {"_meta": meta, "toolName": tool_name})
    return CallToolResult(
        content=result.content,
        isError=result.is_error,
        structuredContent=result.structured_content,
        _meta=result.meta,
    )


def run_existing() -> None:
    """Main entry point - Demonstrates adding x402 to an existing MCP server."""
    print("\n Using LOW-LEVEL API (create_payment_wrapper with existing server)\n")

    # ========================================================================
    # STEP 1: Your existing MCP server (this might already exist in your code)
    # ========================================================================
    mcp_server = FastMCP("x402-mcp-server-existing", host="0.0.0.0", port=PORT)

    # ========================================================================
    # STEP 2: Set up x402 resource server for payment handling
    # ========================================================================
    facilitator_client = HTTPFacilitatorClientSync(FacilitatorConfig(url=FACILITATOR_URL))
    resource_server = x402ResourceServerSync(facilitator_client)
    resource_server.register("eip155:84532", ExactEvmServerScheme())
    resource_server.initialize()

    # ========================================================================
    # STEP 3: Build payment requirements
    # ========================================================================
    weather_accepts = resource_server.build_payment_requirements(
        ResourceConfig(
            scheme="exact",
            network="eip155:84532",
            pay_to=EVM_ADDRESS,
            price="$0.001",
            extra={"name": "USDC", "version": "2"},
        )
    )

    forecast_accepts = resource_server.build_payment_requirements(
        ResourceConfig(
            scheme="exact",
            network="eip155:84532",
            pay_to=EVM_ADDRESS,
            price="$0.005",
            extra={"name": "USDC", "version": "2"},
        )
    )

    # ========================================================================
    # STEP 4: Create payment wrappers
    # ========================================================================
    paid_weather = create_payment_wrapper_sync(
        resource_server,
        SyncPaymentWrapperConfig(
            accepts=weather_accepts,
            resource=ResourceInfo(url="mcp://tool/get_weather"),
        ),
    )

    paid_forecast = create_payment_wrapper_sync(
        resource_server,
        SyncPaymentWrapperConfig(
            accepts=forecast_accepts,
            resource=ResourceInfo(url="mcp://tool/get_forecast"),
        ),
    )

    # ========================================================================
    # STEP 5: Register tools - wrap handlers with payment
    # ========================================================================

    def weather_handler(args: dict[str, Any], _context: Any) -> MCPToolResult:
        """Tool body - only runs after the payment has been verified."""
        return MCPToolResult(
            content=[
                {
                    "type": "text",
                    "text": json.dumps(get_weather_data(args["city"]), indent=2),
                }
            ],
        )

    def forecast_handler(args: dict[str, Any], _context: Any) -> MCPToolResult:
        """Tool body - only runs after the payment has been verified."""
        forecast = [{**get_weather_data(args["city"]), "day": day + 1} for day in range(7)]
        return MCPToolResult(
            content=[{"type": "text", "text": json.dumps(forecast, indent=2)}],
        )

    paid_weather_tool = paid_weather(weather_handler)
    paid_forecast_tool = paid_forecast(forecast_handler)

    # Free tool - works exactly as before, no changes needed
    @mcp_server.tool()
    def ping() -> str:
        """A free health check tool."""
        return "pong"

    @mcp_server.tool()
    def get_weather(city: str, ctx: Context) -> CallToolResult:
        """Get current weather for a city. Requires payment of $0.001."""
        return call_paid_tool(paid_weather_tool, "get_weather", {"city": city}, ctx)

    @mcp_server.tool()
    def get_forecast(city: str, ctx: Context) -> CallToolResult:
        """Get 7-day weather forecast. Requires payment of $0.005."""
        return call_paid_tool(paid_forecast_tool, "get_forecast", {"city": city}, ctx)

    # Run server with SSE transport (interoperable with Go/TypeScript clients)
    print(f"Existing MCP Server with x402 running on http://localhost:{PORT}")
    print("\nAvailable tools:")
    print("   - get_weather (paid: $0.001)")
    print("   - get_forecast (paid: $0.005)")
    print("   - ping (free)")
    print(f"\nConnect via SSE: http://localhost:{PORT}/sse\n")

    mcp_server.run(transport="sse")
