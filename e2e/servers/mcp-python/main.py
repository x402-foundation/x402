"""MCP E2E Test Server with x402 Payment-Wrapped Tools.

This server exposes paid MCP tools over SSE transport for e2e testing.
Uses the x402 SDK's MCP server wrapper for payment handling.
"""

import json
import os
import random
import threading

from dotenv import load_dotenv

load_dotenv()

PORT = int(os.getenv("PORT", "4022"))
EVM_NETWORK = os.getenv("EVM_NETWORK", "eip155:84532")
EVM_PAYEE_ADDRESS = os.getenv("EVM_PAYEE_ADDRESS", "")
TVM_NETWORK = os.getenv("TVM_NETWORK", "tvm:-3")
TVM_PAYEE_ADDRESS = os.getenv("TVM_PAYEE_ADDRESS", "")
FACILITATOR_URL = os.getenv("FACILITATOR_URL", "")

if not EVM_PAYEE_ADDRESS and not TVM_PAYEE_ADDRESS:
    print("At least one of EVM_PAYEE_ADDRESS or TVM_PAYEE_ADDRESS is required")
    exit(1)

if not FACILITATOR_URL:
    print("FACILITATOR_URL environment variable is required")
    exit(1)


def get_weather_data(city: str) -> dict:
    """Simulate fetching weather data for a city."""
    conditions = ["sunny", "cloudy", "rainy", "snowy", "windy"]
    weather = random.choice(conditions)
    temperature = random.randint(40, 80)
    return {"city": city, "weather": weather, "temperature": temperature}


def main() -> None:
    """Start the MCP server with x402 payment-wrapped tools."""
    from mcp.server.fastmcp import FastMCP

    from x402 import ResourceConfig, ResourceInfo, x402ResourceServer
    from x402.extensions.bazaar import DeclareMcpDiscoveryConfig, declare_mcp_discovery_extension
    from x402.http import FacilitatorConfig, HTTPFacilitatorClient
    from x402.mcp import create_payment_wrapper
    from x402.mechanisms.evm.exact import register_exact_evm_server
    from x402.mechanisms.tvm.exact import ExactTvmServerScheme

    # Create FastMCP server
    mcp = FastMCP("x402 MCP E2E Server")

    # Set up x402 resource server
    facilitator_client = HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL))
    resource_server = x402ResourceServer(facilitator_client)
    if EVM_PAYEE_ADDRESS:
        register_exact_evm_server(resource_server, EVM_NETWORK)
    if TVM_PAYEE_ADDRESS:
        resource_server.register(TVM_NETWORK, ExactTvmServerScheme())

    # Initialize (fetches supported kinds from facilitator)
    resource_server.initialize()

    weather_accepts = []
    if EVM_PAYEE_ADDRESS:
        weather_accepts.extend(
            resource_server.build_payment_requirements(
                ResourceConfig(
                    scheme="exact",
                    network=EVM_NETWORK,
                    pay_to=EVM_PAYEE_ADDRESS,
                    price="$0.001",
                )
            )
        )
    if TVM_PAYEE_ADDRESS:
        weather_accepts.extend(
            resource_server.build_payment_requirements(
                ResourceConfig(
                    scheme="exact",
                    network=TVM_NETWORK,
                    pay_to=TVM_PAYEE_ADDRESS,
                    price="$0.001",
                )
            )
        )

    # Declare Bazaar discovery metadata for the weather tool
    weather_discovery = declare_mcp_discovery_extension(
        DeclareMcpDiscoveryConfig(
            tool_name="get_weather",
            description="Get current weather for a city",
            transport="sse",
            input_schema={
                "properties": {"city": {"type": "string", "description": "City name"}},
                "required": ["city"],
            },
            example={"city": "San Francisco"},
        )
    )

    # Create payment wrapper for the weather tool
    weather_wrapper = create_payment_wrapper(
        resource_server,
        accepts=weather_accepts,
        resource=ResourceInfo(
            url="mcp://tool/get_weather",
            description="Get current weather for a city",
            mime_type="application/json",
        ),
        extensions=weather_discovery,
    )

    @mcp.tool(
        name="get_weather",
        description="Get current weather for a city. Requires payment of $0.001.",
    )
    @weather_wrapper
    async def get_weather(city: str) -> str:
        """Return weather data as JSON string."""
        return json.dumps(get_weather_data(city))

    @mcp.tool(name="ping", description="A free health check tool")
    def ping() -> str:
        return "pong"

    # Start with SSE transport via starlette/uvicorn
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    async def health(request):
        return JSONResponse(
            {
                "status": "ok",
                "tools": ["get_weather (paid: $0.001)", "ping (free)"],
                "protocols": [
                    protocol
                    for protocol, enabled in {
                        "evm": bool(EVM_PAYEE_ADDRESS),
                        "tvm": bool(TVM_PAYEE_ADDRESS),
                    }.items()
                    if enabled
                ],
            }
        )

    async def close(request):
        response = JSONResponse({"message": "Server shutting down gracefully"})

        def shutdown():
            import time

            time.sleep(0.1)
            os._exit(0)

        threading.Thread(target=shutdown, daemon=True).start()
        return response

    # Create MCP SSE app
    mcp_app = mcp.sse_app()

    # Create combined Starlette app with health/close routes
    app = Starlette(
        routes=[
            Route("/health", health, methods=["GET"]),
            Route("/close", close, methods=["POST"]),
        ],
    )

    # Mount MCP SSE app at root so /sse and /messages work
    app.mount("/", mcp_app)

    print(f"Server listening on port {PORT}")
    print(f"SSE endpoint: http://localhost:{PORT}/sse")
    print(f"Health: http://localhost:{PORT}/health")
    if EVM_PAYEE_ADDRESS:
        print(f"EVM payments enabled on {EVM_NETWORK}")
    if TVM_PAYEE_ADDRESS:
        print(f"TVM payments enabled on {TVM_NETWORK}")

    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
