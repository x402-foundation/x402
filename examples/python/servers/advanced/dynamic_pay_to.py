"""Dynamic pay-to routing example."""

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

# Address lookup for dynamic pay-to
ADDRESS_LOOKUP: dict[str, str] = {
    "US": EVM_ADDRESS,
    "UK": EVM_ADDRESS,
    "CA": EVM_ADDRESS,
    "AU": EVM_ADDRESS,
}


def get_dynamic_pay_to(context: HTTPRequestContext) -> str:
    """Get dynamic pay-to address based on country query parameter."""
    country = context.adapter.get_query_param("country") or "US"
    return ADDRESS_LOOKUP.get(country, EVM_ADDRESS)


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
    print("\n=== Dynamic Pay-To - After verify ===")
    print(f"Pay to: {ctx.requirements.pay_to}")
    print(f"Payer: {ctx.result.payer}")


server.on_after_verify(after_verify)

routes = {
    "GET /weather": RouteConfig(
        accepts=[
            PaymentOption(
                scheme="exact",
                pay_to=get_dynamic_pay_to,
                price="$0.001",
                network=EVM_NETWORK,
            ),
        ],
    ),
}
app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)


@app.get("/weather")
async def get_weather(city: str = "San Francisco", country: str = "US") -> WeatherResponse:
    return WeatherResponse(report=WeatherReport(weather="sunny", temperature=70))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=4021)
