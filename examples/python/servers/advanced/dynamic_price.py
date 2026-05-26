"""Dynamic pricing example."""

import os

from dotenv import load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel

from x402.http import FacilitatorConfig, HTTPFacilitatorClient, PaymentOption
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.http.types import HTTPRequestContext, RouteConfig
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.schemas import Network
from x402.server import x402ResourceServer

load_dotenv()

# Config
EVM_ADDRESS = os.getenv("EVM_ADDRESS")
EVM_NETWORK: Network = "eip155:84532"  # Base Sepolia
FACILITATOR_URL = os.getenv("FACILITATOR_URL", "https://x402.org/facilitator")

if not EVM_ADDRESS:
    raise ValueError("Missing required EVM_ADDRESS environment variable")


def get_dynamic_price(context: HTTPRequestContext) -> str:
    """Get dynamic price based on tier query parameter."""
    tier = context.adapter.get_query_param("tier") or "standard"
    return "$0.005" if tier == "premium" else "$0.001"


class WeatherReport(BaseModel):
    weather: str
    temperature: int


class WeatherResponse(BaseModel):
    report: WeatherReport


app = FastAPI()

facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL))
server = x402ResourceServer(facilitator)
server.register(EVM_NETWORK, ExactEvmServerScheme())


# Register hooks to log selected payment option
async def after_verify(ctx):
    print("\n=== Dynamic Price - After verify ===")
    print(f"Amount: {ctx.requirements.amount}")
    print(f"Payer: {ctx.result.payer}")


server.on_after_verify(after_verify)

routes = {
    "GET /weather": RouteConfig(
        accepts=[
            PaymentOption(
                scheme="exact",
                pay_to=EVM_ADDRESS,
                price=get_dynamic_price,
                network=EVM_NETWORK,
            ),
        ],
    ),
}
app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)


@app.get("/weather")
async def get_weather(city: str = "San Francisco", tier: str = "standard") -> WeatherResponse:
    return WeatherResponse(report=WeatherReport(weather="sunny", temperature=70))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=4021)
