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
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.mcp import (
    MCPToolResult,
    ResourceInfo,
    SyncPaymentWrapperConfig,
    create_payment_wrapper_sync,
    wrap_fastmcp_tool_sync,
)
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

    # Create the paid tool bridge (SDK handles _meta extraction + CallToolResult conversion)
    paid_weather_tool = wrap_fastmcp_tool_sync(
        paid_weather,
        lambda args, _: MCPToolResult(
            content=[{"type": "text", "text": json.dumps(get_weather_data(args["city"]))}],
        ),
        tool_name="get_weather",
    )

    # Paid tool - just call the bridge with args + context
    @mcp_server.tool()
    def get_weather(city: str, ctx: Context) -> CallToolResult:
        """Get current weather for a city. Requires payment of $0.001."""
        return paid_weather_tool({"city": city}, ctx)

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
