"""MCP Server with x402 Paid Tools - Simple Example.

This example demonstrates creating an MCP server with payment-wrapped tools
using the REAL MCP SDK (mcp package from PyPI).
Uses the create_payment_wrapper function to add x402 payment to individual tools.

Run with: python main.py simple
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

if not FACILITATOR_URL:
    print("FACILITATOR_URL environment variable is required")
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


def run_simple() -> None:
    """Main entry point - demonstrates the payment wrapper API with REAL MCP SDK."""
    print("\n Using Payment Wrapper API with REAL MCP SDK\n")

    # ========================================================================
    # STEP 1: Create REAL MCP server using FastMCP
    # ========================================================================
    mcp_server = FastMCP("x402-mcp-server", host="0.0.0.0", port=PORT)

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
    accepts = resource_server.build_payment_requirements(
        ResourceConfig(
            scheme="exact",
            network="eip155:84532",
            pay_to=EVM_ADDRESS,
            price="$0.001",
            extra={"name": "USDC", "version": "2"},
        )
    )

    # ========================================================================
    # STEP 4: Create payment wrapper with accepts array
    # ========================================================================
    paid_weather = create_payment_wrapper_sync(
        resource_server,
        SyncPaymentWrapperConfig(accepts=accepts),
    )

    # ========================================================================
    # STEP 5: Register tools - wrap handler with payment
    # ========================================================================

    def weather_handler(args: dict[str, Any], _context: Any) -> MCPToolResult:
        """Tool body - only runs after the payment has been verified."""
        return MCPToolResult(
            content=[{"type": "text", "text": json.dumps(get_weather_data(args["city"]))}],
        )

    paid_weather_tool = paid_weather(weather_handler)

    # Paid tool - adapt the FastMCP context to the wrapper's (arguments, extra)
    @mcp_server.tool()
    def get_weather(city: str, ctx: Context) -> CallToolResult:
        """Get current weather for a city. Requires payment of $0.001."""
        return call_paid_tool(paid_weather_tool, "get_weather", {"city": city}, ctx)

    # Free tool - no wrapper needed
    @mcp_server.tool()
    def ping() -> str:
        """A free health check tool."""
        return "pong"

    # Run server with SSE transport (interoperable with Go/TypeScript clients)
    print(f"x402 MCP Server running on http://localhost:{PORT}")
    print("\nAvailable tools:")
    print("   - get_weather (paid: $0.001)")
    print("   - ping (free)")
    print(f"\nConnect via SSE: http://localhost:{PORT}/sse\n")

    mcp_server.run(transport="sse")
