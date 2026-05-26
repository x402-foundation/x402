"""Sign-In-With-X server example."""

import os

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from x402.extensions.sign_in_with_x import (
    CreateSIWxHookOptions,
    DeclareSIWxOptions,
    InMemorySIWxStorage,
    create_siwx_resource_server_extension,
    declare_siwx_extension,
    parse_siwx_header,
)
from x402.http import FacilitatorConfig, HTTPFacilitatorClient
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.http.types import PaymentOption, RouteConfig
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.mechanisms.svm.exact import ExactSvmServerScheme
from x402.server import x402ResourceServer

load_dotenv()

EVM_ADDRESS = os.getenv("EVM_ADDRESS")
SVM_ADDRESS = os.getenv("SVM_ADDRESS")
FACILITATOR_URL = os.getenv("FACILITATOR_URL")
PORT = 4021
EVM_NETWORK = "eip155:84532"
SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"

if not EVM_ADDRESS and not SVM_ADDRESS:
    raise ValueError("Missing EVM_ADDRESS or SVM_ADDRESS")
if not FACILITATOR_URL:
    raise ValueError("Missing FACILITATOR_URL")

storage = InMemorySIWxStorage()


def on_event(event: dict) -> None:
    print(f"[SIWX] {event['type']}", event)


def route_config(path: str) -> RouteConfig:
    accepts: list[PaymentOption] = []
    if EVM_ADDRESS:
        accepts.append(
            PaymentOption(
                scheme="exact",
                price="$0.001",
                network=EVM_NETWORK,
                pay_to=EVM_ADDRESS,
            )
        )
    if SVM_ADDRESS:
        accepts.append(
            PaymentOption(
                scheme="exact",
                price="$0.001",
                network=SVM_NETWORK,
                pay_to=SVM_ADDRESS,
            )
        )
    return RouteConfig(
        accepts=accepts,
        description=f"Protected resource: {path}",
        mime_type="application/json",
        extensions=declare_siwx_extension(),
    )


routes = {
    "GET /weather": route_config("/weather"),
    "GET /joke": route_config("/joke"),
    "GET /profile": RouteConfig(
        accepts=[],
        description="Auth-only: wallet signature required",
        extensions=declare_siwx_extension(
            DeclareSIWxOptions(
                network=[n for n in ([EVM_NETWORK] if EVM_ADDRESS else []) + ([SVM_NETWORK] if SVM_ADDRESS else [])],
                statement="Sign in to view your profile",
                expiration_seconds=300,
            )
        ),
    ),
}

facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL))
server = x402ResourceServer(facilitator)
if EVM_ADDRESS:
    server.register(EVM_NETWORK, ExactEvmServerScheme())
if SVM_ADDRESS:
    server.register(SVM_NETWORK, ExactSvmServerScheme())
server.register_extension(
    create_siwx_resource_server_extension(
        CreateSIWxHookOptions(storage=storage, on_event=on_event)
    )
)

app = FastAPI()
app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)


@app.get("/weather")
async def weather() -> dict:
    return {"weather": "sunny", "temperature": 72}


@app.get("/joke")
async def joke() -> dict:
    return {
        "joke": "Why do programmers prefer dark mode? Because light attracts bugs.",
    }


@app.get("/profile")
async def profile(request: Request) -> JSONResponse:
    header = request.headers.get("sign-in-with-x") or request.headers.get("SIGN-IN-WITH-X")
    payload = parse_siwx_header(header or "")
    return JSONResponse({"address": payload.address, "data": "Your profile data"})


if __name__ == "__main__":
    import uvicorn

    print(f"Server running at http://localhost:{PORT}")
    print("Routes: GET /weather, GET /joke, GET /profile (auth-only)")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
