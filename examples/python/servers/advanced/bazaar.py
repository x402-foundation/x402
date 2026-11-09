"""Bazaar discovery extension example."""

import json
import logging
import os

from dotenv import load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel

from x402.extensions.bazaar import (
    OutputConfig,
    bazaar_resource_server_extension,
    declare_discovery_extension,
)
from x402.http import FacilitatorConfig, HTTPFacilitatorClient, PaymentOption
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.http.types import RouteConfig
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.schemas import Network
from x402.schemas.hooks import SettleResultContext, VerifyResultContext
from x402.server import x402ResourceServer

load_dotenv()

logging.basicConfig(level=logging.INFO)

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
server.register_extension(bazaar_resource_server_extension)


def _log_extension_responses(phase: str, ctx: VerifyResultContext | SettleResultContext) -> None:
    """Process facilitator extension sidechannel metadata."""
    extension_responses = ctx.extension_responses
    if not extension_responses:
        print(f"\n=== {phase}: no facilitator extension responses ===")
        return

    print(f"\n=== {phase}: facilitator extension responses (sidechannel) ===")
    print(json.dumps(extension_responses, indent=2))

    bazaar = extension_responses.get("bazaar")
    if not isinstance(bazaar, dict):
        return

    status = bazaar.get("status")
    if status == "success":
        print("   ✅ Bazaar cataloging confirmed by facilitator")
    elif status == "processing":
        print("   ⏳ Bazaar cataloging in progress")
    elif status == "rejected":
        reason = bazaar.get("rejectedReason", "unknown")
        print(f"   ⚠️  Bazaar rejected: {reason}")


server.on_after_verify(lambda ctx: _log_extension_responses("After verify", ctx))
server.on_after_settle(lambda ctx: _log_extension_responses("After settle", ctx))

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
        description="Weather data",
        mime_type="application/json",
        service_name="Weather API",
        tags=["weather", "api"],
        extensions={
            **declare_discovery_extension(
                input={"city": "San Francisco"},
                input_schema={
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
                output=OutputConfig(
                    example={"weather": "sunny", "temperature": 70},
                    schema={
                        "properties": {
                            "weather": {"type": "string"},
                            "temperature": {"type": "number"},
                        },
                        "required": ["weather", "temperature"],
                    },
                ),
            )
        },
    ),
}
app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)


@app.get("/weather")
async def get_weather(city: str = "San Francisco") -> WeatherResponse:
    return WeatherResponse(report=WeatherReport(weather="sunny", temperature=70))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=4021)
