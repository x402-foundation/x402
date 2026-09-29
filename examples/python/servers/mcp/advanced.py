"""MCP Server with x402 Paid Tools - Advanced Example with Hooks.

This example demonstrates using create_payment_wrapper with hooks for:
- Logging and observability
- Rate limiting and access control
- Custom settlement handling
- Production monitoring

Run with: python main.py advanced
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
    AfterExecutionContext,
    MCPToolResult,
    ResourceInfo,
    ServerHookContext,
    SettlementContext,
    SyncPaymentWrapperConfig,
    SyncPaymentWrapperHooks,
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


def get_weather_data(city: str) -> dict[str, Any]:
    """Simulate fetching weather data for a city."""
    conditions = ["sunny", "cloudy", "rainy", "snowy", "windy"]
    weather = random.choice(conditions)
    temperature = random.randint(40, 80)
    return {"city": city, "weather": weather, "temperature": temperature}


def run_advanced() -> None:
    """Main entry point - demonstrates hooks with payment wrapper using REAL MCP SDK."""
    print("\n Using Payment Wrapper with Hooks and REAL MCP SDK\n")

    # ========================================================================
    # STEP 1: Create REAL MCP server using FastMCP
    # ========================================================================
    mcp_server = FastMCP("x402-mcp-server-advanced", host="0.0.0.0", port=PORT)

    # ========================================================================
    # STEP 2: Set up x402 resource server
    # ========================================================================
    facilitator_client = HTTPFacilitatorClientSync(FacilitatorConfig(url=FACILITATOR_URL))
    resource_server = x402ResourceServerSync(facilitator_client)
    resource_server.register("eip155:84532", ExactEvmServerScheme())
    resource_server.initialize()

    # ========================================================================
    # STEP 3: Build payment requirements for different tools
    # ========================================================================
    weather_accepts = resource_server.build_payment_requirements(
        ResourceConfig(
            scheme="exact", network="eip155:84532",
            pay_to=EVM_ADDRESS, price="$0.001",
            extra={"name": "USDC", "version": "2"},
        )
    )

    forecast_accepts = resource_server.build_payment_requirements(
        ResourceConfig(
            scheme="exact", network="eip155:84532",
            pay_to=EVM_ADDRESS, price="$0.005",
            extra={"name": "USDC", "version": "2"},
        )
    )

    # ========================================================================
    # STEP 4: Create payment wrappers with hooks for production features
    # ========================================================================

    # Shared hooks for all paid tools
    def before_hook(context: ServerHookContext) -> bool:
        print(f"\n[Hook] Before execution: {context.tool_name}")
        print(f"   Amount: {context.payment_requirements.amount}")
        return True  # Continue execution

    def after_hook(context: AfterExecutionContext) -> None:
        print(f"[Hook] After execution: {context.tool_name}")
        print(f"   Result error: {context.result.is_error}")

    def settlement_hook(context: SettlementContext) -> None:
        print(f"[Hook] Settlement complete: {context.tool_name}")
        if context.settlement.transaction:
            print(f"   Transaction: {context.settlement.transaction}")
        print(f"   Success: {context.settlement.success}\n")

    shared_hooks = SyncPaymentWrapperHooks(
        on_before_execution=before_hook,
        on_after_execution=after_hook,
        on_after_settlement=settlement_hook,
    )

    paid_weather = create_payment_wrapper_sync(
        resource_server,
        SyncPaymentWrapperConfig(
            accepts=weather_accepts,
            resource=ResourceInfo(url="mcp://tool/get_weather"),
            hooks=shared_hooks,
        ),
    )

    paid_forecast = create_payment_wrapper_sync(
        resource_server,
        SyncPaymentWrapperConfig(
            accepts=forecast_accepts,
            resource=ResourceInfo(url="mcp://tool/get_forecast"),
            hooks=shared_hooks,
        ),
    )

    # ========================================================================
    # STEP 5: Register tools - wrap handlers with payment
    # ========================================================================

    paid_weather_tool = wrap_fastmcp_tool_sync(
        paid_weather,
        lambda args, _: MCPToolResult(
            content=[{"type": "text", "text": json.dumps(get_weather_data(args["city"]), indent=2)}],
        ),
        tool_name="get_weather",
    )

    paid_forecast_tool = wrap_fastmcp_tool_sync(
        paid_forecast,
        lambda args, _: MCPToolResult(
            content=[{"type": "text", "text": json.dumps(
                [{**get_weather_data(args["city"]), "day": i + 1} for i in range(7)], indent=2,
            )}],
        ),
        tool_name="get_forecast",
    )

    @mcp_server.tool()
    def get_weather(city: str, ctx: Context) -> CallToolResult:
        """Get current weather for a city. Requires payment of $0.001."""
        return paid_weather_tool({"city": city}, ctx)

    @mcp_server.tool()
    def get_forecast(city: str, ctx: Context) -> CallToolResult:
        """Get 7-day weather forecast. Requires payment of $0.005."""
        return paid_forecast_tool({"city": city}, ctx)

    @mcp_server.tool()
    def ping() -> str:
        """A free health check tool."""
        return "pong"

    # Run server with SSE transport (interoperable with Go/TypeScript clients)
    print(f"x402 MCP Server (Advanced) running on http://localhost:{PORT}")
    print("\nAvailable tools:")
    print("   - get_weather (paid: $0.001) [with hooks]")
    print("   - get_forecast (paid: $0.005) [with hooks]")
    print("   - ping (free)")
    print(f"\nConnect via SSE: http://localhost:{PORT}/sse\n")

    mcp_server.run(transport="sse")
