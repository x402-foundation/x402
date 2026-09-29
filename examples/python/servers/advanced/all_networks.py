"""All Networks Server Example.

Demonstrates how to create a server that supports all available networks with
optional chain configuration via environment variables.

New chain support should be added here in alphabetic order by network prefix
(e.g., "eip155" before "solana" before "tvm").
"""

import os
import sys

from dotenv import load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel

from x402.http import FacilitatorConfig, HTTPFacilitatorClient, PaymentOption
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.http.types import RouteConfig
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.mechanisms.svm.exact import ExactSvmServerScheme
from x402.mechanisms.tvm import TVM_TESTNET
from x402.mechanisms.tvm.exact import ExactTvmServerScheme
from x402.schemas import Network
from x402.server import x402ResourceServer

load_dotenv()

# Configuration - optional per network
EVM_ADDRESS = os.getenv("EVM_ADDRESS")
SVM_ADDRESS = os.getenv("SVM_ADDRESS")
TVM_ADDRESS = os.getenv("TVM_ADDRESS")

# Validate at least one address is provided
if not EVM_ADDRESS and not SVM_ADDRESS and not TVM_ADDRESS:
    print("❌ At least one of EVM_ADDRESS, SVM_ADDRESS, or TVM_ADDRESS is required")
    sys.exit(1)

# Network configuration
EVM_NETWORK: Network = "eip155:84532"  # Base Sepolia
SVM_NETWORK: Network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"  # Solana Devnet
TVM_NETWORK: Network = os.getenv("TVM_NETWORK", TVM_TESTNET)  # TON testnet by default
FACILITATOR_URL = os.getenv("FACILITATOR_URL", "https://x402.org/facilitator")


# Response schemas
class WeatherReport(BaseModel):
    weather: str
    temperature: int


class WeatherResponse(BaseModel):
    report: WeatherReport


# App
app = FastAPI(
    title="All Networks Server",
    description="x402 server supporting EVM, SVM, and TVM networks",
    version="2.0.0",
)


# Build accepts array dynamically based on configured addresses
accepts: list[PaymentOption] = []
if EVM_ADDRESS:
    accepts.append(
        PaymentOption(
            scheme="exact",
            pay_to=EVM_ADDRESS,
            price="$0.001",
            network=EVM_NETWORK,
        )
    )
if SVM_ADDRESS:
    accepts.append(
        PaymentOption(
            scheme="exact",
            pay_to=SVM_ADDRESS,
            price="$0.001",
            network=SVM_NETWORK,
        )
    )
if TVM_ADDRESS:
    accepts.append(
        PaymentOption(
            scheme="exact",
            pay_to=TVM_ADDRESS,
            price="$0.001",
            network=TVM_NETWORK,
        )
    )

# x402 Middleware
facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL))
server = x402ResourceServer(facilitator)

# Register schemes dynamically based on configured addresses
if EVM_ADDRESS:
    server.register(EVM_NETWORK, ExactEvmServerScheme())
if SVM_ADDRESS:
    server.register(SVM_NETWORK, ExactSvmServerScheme())
if TVM_ADDRESS:
    server.register(TVM_NETWORK, ExactTvmServerScheme())

routes = {
    "GET /weather": RouteConfig(
        accepts=accepts,
        mime_type="application/json",
        description="Weather report",
    ),
}
app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)


# Routes
@app.get("/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/weather")
async def get_weather() -> WeatherResponse:
    return WeatherResponse(report=WeatherReport(weather="sunny", temperature=70))


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "4021"))
    print(f"🚀 All Networks Server listening on http://localhost:{port}")
    if EVM_ADDRESS:
        print(f"   EVM: {EVM_ADDRESS} on {EVM_NETWORK}")
    if SVM_ADDRESS:
        print(f"   SVM: {SVM_ADDRESS} on {SVM_NETWORK}")
    if TVM_ADDRESS:
        print(f"   TVM: {TVM_ADDRESS} on {TVM_NETWORK}")
    print(f"   Facilitator: {FACILITATOR_URL}")
    print()
    uvicorn.run(app, host="0.0.0.0", port=port)
