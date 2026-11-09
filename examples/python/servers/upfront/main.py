"""FastAPI server demonstrating the upfront payment flow on the exact scheme.

Settlement happens before the route handler runs — useful when the resource
needs on-chain finality before execution (for example, long-running handlers
on Solana where a signed transaction's blockhash expires before the handler
finishes under the default authorization flow).
"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel

from x402.http import FacilitatorConfig, HTTPFacilitatorClient, PaymentOption
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.http.types import RouteConfig
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.mechanisms.svm.exact import ExactSvmServerScheme
from x402.schemas import Network
from x402.server import x402ResourceServer

load_dotenv()

EVM_ADDRESS = os.getenv("EVM_ADDRESS")
SVM_ADDRESS = os.getenv("SVM_ADDRESS")
EVM_NETWORK: Network = "eip155:84532"  # Base Sepolia
SVM_NETWORK: Network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"  # Solana Devnet
FACILITATOR_URL = os.getenv("FACILITATOR_URL", "https://x402.org/facilitator")

if not EVM_ADDRESS or not SVM_ADDRESS:
    raise ValueError("Missing required environment variables EVM_ADDRESS and SVM_ADDRESS")
if not FACILITATOR_URL:
    raise ValueError("Missing required environment variable FACILITATOR_URL")


class WeatherReport(BaseModel):
    weather: str
    temperature: int


class WeatherResponse(BaseModel):
    report: WeatherReport


facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL))
server = x402ResourceServer(facilitator)
server.register(EVM_NETWORK, ExactEvmServerScheme())
server.register(SVM_NETWORK, ExactSvmServerScheme())


def _log_after_settle(ctx) -> None:
    print(f"[upfront] settled ({ctx.phase}) tx={ctx.result.transaction}")


server.on_after_settle(_log_after_settle)

routes = {
    "GET /weather": RouteConfig(
        accepts=[
            PaymentOption(
                scheme="exact",
                pay_to=EVM_ADDRESS,
                price="$0.001",
                network=EVM_NETWORK,
                extra={"paymentFlow": "upfront"},
            ),
            PaymentOption(
                scheme="exact",
                pay_to=SVM_ADDRESS,
                price="$0.001",
                network=SVM_NETWORK,
                extra={"paymentFlow": "upfront"},
            ),
        ],
        mime_type="application/json",
        description="Weather data",
    ),
}

app = FastAPI()
app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)


@app.get("/weather")
async def get_weather() -> WeatherResponse:
    print("[upfront] handler running (settlement already completed)")
    return WeatherResponse(report=WeatherReport(weather="sunny", temperature=70))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=4021)
