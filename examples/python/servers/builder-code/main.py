"""Builder Code Extension Server Example.

Demonstrates how to declare ERC-8021 builder-code attribution on paid endpoints
via ``declare_builder_code_extension``.

Required environment variables:
- EVM_ADDRESS: The EVM address to receive payments
- APP_BUILDER_CODE: The service app builder code (``a``)
- FACILITATOR_URL: Facilitator endpoint URL
"""

import os

from dotenv import load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel

from x402.extensions.builder_code import BUILDER_CODE, declare_builder_code_extension
from x402.http import FacilitatorConfig, HTTPFacilitatorClient, PaymentOption
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.http.types import RouteConfig
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.schemas import Network
from x402.server import x402ResourceServer

load_dotenv()

EVM_ADDRESS = os.getenv("EVM_ADDRESS")
EVM_NETWORK: Network = "eip155:84532"  # Base Sepolia
FACILITATOR_URL = os.getenv("FACILITATOR_URL", "http://localhost:4022")
APP_BUILDER_CODE = os.getenv("APP_BUILDER_CODE")

if not EVM_ADDRESS:
    raise ValueError("Missing required EVM_ADDRESS environment variable")
if not APP_BUILDER_CODE:
    raise ValueError("Missing required APP_BUILDER_CODE environment variable")


class WeatherReport(BaseModel):
    weather: str
    temperature: int


class WeatherResponse(BaseModel):
    report: WeatherReport


app = FastAPI()

facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL))
server = x402ResourceServer(facilitator)
server.register(EVM_NETWORK, ExactEvmServerScheme())

routes = {
    "GET /weather": RouteConfig(
        accepts=[
            PaymentOption(
                scheme="exact",
                price="$0.001",
                network=EVM_NETWORK,
                pay_to=EVM_ADDRESS,
            ),
        ],
        description="Weather data",
        mime_type="application/json",
        extensions={
            BUILDER_CODE: declare_builder_code_extension(APP_BUILDER_CODE),
        },
    ),
}

app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)


@app.get("/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/weather")
async def get_weather() -> WeatherResponse:
    return WeatherResponse(report=WeatherReport(weather="sunny", temperature=70))


if __name__ == "__main__":
    import uvicorn

    print("\nBuilder Code Example Server")
    print("   Listening at http://localhost:4021\n")

    uvicorn.run(app, host="0.0.0.0", port=4021)
