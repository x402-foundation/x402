"""Server lifecycle hooks example."""

import os
from pprint import pprint

from dotenv import load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel

from x402.http import FacilitatorConfig, HTTPFacilitatorClient, PaymentOption
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.http.types import RouteConfig
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


class WeatherReport(BaseModel):
    weather: str
    temperature: int


class WeatherResponse(BaseModel):
    report: WeatherReport


app = FastAPI()

facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL))
server = x402ResourceServer(facilitator)
server.register(EVM_NETWORK, ExactEvmServerScheme())


# Register async hooks
async def before_verify(ctx):
    print("\n=== Before verify ===")
    pprint(vars(ctx))


async def after_verify(ctx):
    print("\n=== After verify ===")
    pprint(vars(ctx))


async def verify_failure(ctx):
    print("\n=== Verify failure ===")
    pprint(vars(ctx))


async def before_settle(ctx):
    print("\n=== Before settle ===")
    pprint(vars(ctx))


async def after_settle(ctx):
    print("\n=== After settle ===")
    pprint(vars(ctx))


async def settle_failure(ctx):
    print("\n=== Settle failure ===")
    pprint(vars(ctx))


server.on_before_verify(before_verify)
server.on_after_verify(after_verify)
server.on_verify_failure(verify_failure)
server.on_before_settle(before_settle)
server.on_after_settle(after_settle)
server.on_settle_failure(settle_failure)

routes = {
    "GET /weather": RouteConfig(
        accepts=[
            PaymentOption(
                scheme="exact",
                pay_to=EVM_ADDRESS,
                price="$0.001",
                network=EVM_NETWORK,
            ),
        ],
    ),
}
app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)


@app.get("/weather")
async def get_weather(city: str = "San Francisco") -> WeatherResponse:
    return WeatherResponse(report=WeatherReport(weather="sunny", temperature=70))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=4021)
