"""Custom x402 Server Implementation.

This example demonstrates how to implement x402 payment handling manually
without using the pre-built middleware packages like PaymentMiddlewareASGI.

It shows you how the payment flow works under the hood:
1. Check for payment in request headers
2. If no payment, return 402 with payment requirements
3. If payment provided, verify with facilitator
4. Execute handler
5. Settle payment and add settlement headers to response

Use this approach when you need:
- Complete control over the payment flow
- Integration with unsupported frameworks
- Custom error handling or logging
- Understanding of how x402 works internally
"""

import base64
import json
import os
import sys
from dataclasses import dataclass, field

from dotenv import load_dotenv
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from x402.http import FacilitatorConfig, HTTPFacilitatorClient
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.schemas import Network, PaymentPayload, PaymentRequirements, ResourceConfig
from x402.server import x402ResourceServer

load_dotenv()

# Config
EVM_ADDRESS = os.getenv("EVM_ADDRESS")
EVM_NETWORK: Network = "eip155:84532"  # Base Sepolia
FACILITATOR_URL = os.getenv("FACILITATOR_URL", "https://x402.org/facilitator")

if not EVM_ADDRESS:
    print("❌ EVM_ADDRESS environment variable is required")
    sys.exit(1)

if not FACILITATOR_URL:
    print("❌ FACILITATOR_URL environment variable is required")
    sys.exit(1)

print("\n🔧 Custom x402 Server Implementation")
print("This example demonstrates manual payment handling without middleware.\n")
print(f"✅ Payment address: {EVM_ADDRESS}")
print(f"✅ Facilitator: {FACILITATOR_URL}\n")


# Create facilitator client and resource server
facilitator_client = HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL))
resource_server = x402ResourceServer(facilitator_client).register(
    EVM_NETWORK,
    ExactEvmServerScheme(),
)


# Route payment configuration
@dataclass
class RoutePaymentConfig:
    """Payment configuration for a route."""

    scheme: str
    price: str
    network: Network
    pay_to: str
    description: str
    mime_type: str


route_configs: dict[str, RoutePaymentConfig] = {
    "GET /weather": RoutePaymentConfig(
        scheme="exact",
        price="$0.001",
        network=EVM_NETWORK,
        pay_to=EVM_ADDRESS,  # type: ignore
        description="Weather data",
        mime_type="application/json",
    ),
}


# Cache for built payment requirements
@dataclass
class RouteRequirementsCache:
    """Cache for route payment requirements."""

    cache: dict[str, PaymentRequirements] = field(default_factory=dict)


route_requirements = RouteRequirementsCache()


# Create FastAPI app
app = FastAPI(
    title="Custom x402 Server",
    description="Manual x402 payment handling implementation",
)


@app.middleware("http")
async def custom_payment_middleware(request: Request, call_next) -> Response:
    """Custom payment middleware implementation.

    Demonstrates the x402 payment flow:
    1. Check for payment in request headers
    2. If no payment, return 402 with payment requirements
    3. If payment provided, verify with facilitator
    4. Execute handler
    5. Settle payment and add settlement headers to response
    """
    route_key = f"{request.method} {request.url.path}"
    route_config = route_configs.get(route_key)

    # If route doesn't require payment, continue
    if route_config is None:
        return await call_next(request)

    print(f"📥 Request received: {route_key}")

    # Build PaymentRequirements from config (cached for efficiency)
    if route_key not in route_requirements.cache:
        config = ResourceConfig(
            scheme=route_config.scheme,
            price=route_config.price,
            network=route_config.network,
            pay_to=route_config.pay_to,
        )
        built_requirements = resource_server.build_payment_requirements(config)
        if len(built_requirements) == 0:
            print("❌ Failed to build payment requirements")
            return JSONResponse(
                status_code=500,
                content={"error": "Server configuration error"},
            )
        route_requirements.cache[route_key] = built_requirements[0]

    requirements = route_requirements.cache[route_key]

    # Step 1: Check for payment in headers (v2: PAYMENT-SIGNATURE, v1: X-PAYMENT)
    payment_header = request.headers.get("payment-signature") or request.headers.get("x-payment")

    if not payment_header:
        print("💳 No payment provided, returning 402 Payment Required")

        # Step 2: Return 402 with payment requirements
        payment_required = resource_server.create_payment_required_response(
            [requirements],
            resource={
                "url": str(request.url),
                "description": route_config.description,
                "mime_type": route_config.mime_type,
            },
        )

        # Use base64 encoding for the PAYMENT-REQUIRED header (v2 protocol)
        requirements_header = base64.b64encode(
            json.dumps(payment_required.model_dump(by_alias=True)).encode()
        ).decode()

        return JSONResponse(
            status_code=402,
            content={
                "error": "Payment Required",
                "message": "This endpoint requires payment",
            },
            headers={"PAYMENT-REQUIRED": requirements_header},
        )

    try:
        # Step 3: Verify payment
        print("🔐 Payment provided, verifying with facilitator...")

        payment_payload_dict = json.loads(base64.b64decode(payment_header).decode("utf-8"))
        payment_payload = PaymentPayload.model_validate(payment_payload_dict)
        verify_result = await resource_server.verify_payment(payment_payload, requirements)

        if not verify_result.is_valid:
            print(f"❌ Payment verification failed: {verify_result.invalid_reason}")
            return JSONResponse(
                status_code=402,
                content={
                    "error": "Invalid Payment",
                    "reason": verify_result.invalid_reason,
                },
            )

        print("✅ Payment verified successfully")

        # Step 4: Execute handler
        response = await call_next(request)

        # Only settle for successful responses (2xx)
        if 200 <= response.status_code < 300:
            # Step 5: Settle payment
            print("💰 Settling payment on-chain...")

            try:
                settle_result = await resource_server.settle_payment(payment_payload, requirements)

                print(f"✅ Payment settled: {settle_result.transaction}")

                # Add settlement headers (v2 protocol uses PAYMENT-RESPONSE)
                settlement_header = base64.b64encode(
                    json.dumps(settle_result.model_dump(by_alias=True)).encode()
                ).decode()

                # Create new response with settlement header
                body = b""
                async for chunk in response.body_iterator:
                    body += chunk

                return Response(
                    content=body,
                    status_code=response.status_code,
                    headers={**dict(response.headers), "PAYMENT-RESPONSE": settlement_header},
                    media_type=response.media_type,
                )

            except Exception as e:
                print(f"❌ Settlement failed: {e}")
                # Continue with response even if settlement fails
                return response

        return response

    except Exception as e:
        print(f"❌ Payment processing error: {e}")
        return JSONResponse(
            status_code=500,
            content={
                "error": "Payment Processing Error",
                "message": str(e),
            },
        )


# Routes
@app.get("/health")
async def health_check() -> dict[str, str]:
    """Health check endpoint (no payment required)."""
    return {"status": "ok", "version": "2.0.0"}


@app.get("/weather")
async def get_weather(city: str = "San Francisco") -> dict:
    """Protected weather endpoint (requires payment)."""
    print("🌤️  Executing weather endpoint handler")

    weather_data = {
        "San Francisco": {"weather": "foggy", "temperature": 60},
        "New York": {"weather": "cloudy", "temperature": 55},
        "London": {"weather": "rainy", "temperature": 50},
        "Tokyo": {"weather": "clear", "temperature": 65},
    }

    data = weather_data.get(city, {"weather": "sunny", "temperature": 70})

    from datetime import datetime

    return {
        "city": city,
        "weather": data["weather"],
        "temperature": data["temperature"],
        "timestamp": datetime.now().isoformat(),
    }


@app.on_event("startup")
async def startup_event() -> None:
    """Initialize the resource server on startup."""
    resource_server.initialize()
    print("🚀 Resource server initialized\n")
    print("Key implementation steps:")
    print("  1. ✅ Check for payment headers in requests")
    print("  2. ✅ Return 402 with requirements if no payment")
    print("  3. ✅ Verify payments with facilitator")
    print("  4. ✅ Execute handler on successful verification")
    print("  5. ✅ Settle payment and add response headers\n")
    print("Test with: curl http://localhost:4021/weather")
    print("Or use a client from: ../../clients/\n")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=4021)
