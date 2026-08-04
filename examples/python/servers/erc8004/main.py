"""ERC-8004 agent resource server for the x402 HTTP ticket demo.

Serves two paid endpoints (USDC via EIP-3009, DAI via Permit2), declares
``agentId`` in 402 responses, and attaches ``X-X402-Interaction-Attestation``
after settlement.

Run:
    cd examples/python/servers/erc8004
    uv sync
    uv run python main.py
"""

from __future__ import annotations

import os
import sys

from dotenv import load_dotenv
from eth_account import Account
from fastapi import FastAPI, Request
from starlette.responses import Response

from attestation_middleware import erc8004_payment_middleware
from x402.extensions.erc8004 import (
    ERC8004Config,
    create_erc8004_resource_server_extension,
    declare_erc8004_extension,
)
from x402.http import FacilitatorConfig, HTTPFacilitatorClient, PaymentOption
from x402.http.types import RouteConfig
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.schemas import AssetAmount
from x402.server import x402ResourceServer

load_dotenv()

PORT = int(os.environ.get("PORT", "4021"))
NETWORK = os.environ.get("NETWORK", "eip155:1")
FACILITATOR_URL = os.environ.get("FACILITATOR_URL", "http://127.0.0.1:4022")
EVM_RPC_URL = os.environ.get("EVM_RPC_URL", "http://127.0.0.1:8545")
WRAPPER_ADDRESS = os.environ.get("WRAPPER_ADDRESS")
IDENTITY_REGISTRY = os.environ.get("IDENTITY_REGISTRY")
AGENT_ID = os.environ.get("AGENT_ID")
AGENT_ADDRESS = os.environ.get("AGENT_ADDRESS")
AGENT_OWNER_KEY = os.environ.get("AGENT_OWNER_PRIVATE_KEY")
USDC_ADDRESS = os.environ.get("USDC_ADDRESS")
DAI_ADDRESS = os.environ.get("DAI_ADDRESS")
AMOUNT_USDC = os.environ.get("AMOUNT_USDC", "1000000")
AMOUNT_DAI = os.environ.get("AMOUNT_DAI", "1000000000000000000")

required = {
    "WRAPPER_ADDRESS": WRAPPER_ADDRESS,
    "IDENTITY_REGISTRY": IDENTITY_REGISTRY,
    "AGENT_ID": AGENT_ID,
    "AGENT_ADDRESS": AGENT_ADDRESS,
    "AGENT_OWNER_PRIVATE_KEY": AGENT_OWNER_KEY,
    "USDC_ADDRESS": USDC_ADDRESS,
    "DAI_ADDRESS": DAI_ADDRESS,
}
missing = [k for k, v in required.items() if not v]
if missing:
    print(f"ERROR: missing env vars: {', '.join(missing)}")
    print("Run bootstrap_fork.py --write-env first.")
    sys.exit(1)

agent_owner = Account.from_key(AGENT_OWNER_KEY)  # type: ignore[arg-type]
agent_id = int(AGENT_ID)  # type: ignore[arg-type]

facilitator_client = HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL))
server = x402ResourceServer(facilitator_client)
server.register(NETWORK, ExactEvmServerScheme())

erc8004_config = ERC8004Config(
    network=NETWORK,
    wrapper_address=WRAPPER_ADDRESS,
    reputation_registry=WRAPPER_ADDRESS,
    identity_registry=IDENTITY_REGISTRY,
    rpc_url=EVM_RPC_URL,
    agent_id=agent_id,
)
server.register_extension(create_erc8004_resource_server_extension(erc8004_config))

erc8004_route_extensions = {"erc8004": declare_erc8004_extension()}

routes = {
    "GET /agent/usdc": RouteConfig(
        accepts=[
            PaymentOption(
                scheme="exact",
                pay_to=AGENT_ADDRESS,  # type: ignore[arg-type]
                price=AssetAmount(
                    amount=AMOUNT_USDC,
                    asset=USDC_ADDRESS,  # type: ignore[arg-type]
                    extra={"name": "USD Coin", "version": "2"},
                ),
                network=NETWORK,  # type: ignore[arg-type]
            ),
        ],
        mime_type="application/json",
        description="USDC resource (EIP-3009)",
        extensions=erc8004_route_extensions,
    ),
    "GET /agent/dai": RouteConfig(
        accepts=[
            PaymentOption(
                scheme="exact",
                pay_to=AGENT_ADDRESS,  # type: ignore[arg-type]
                price=AssetAmount(
                    amount=AMOUNT_DAI,
                    asset=DAI_ADDRESS,  # type: ignore[arg-type]
                    extra={
                        "assetTransferMethod": "permit2",
                        "name": "Dai Stablecoin",
                        "version": "1",
                    },
                ),
                network=NETWORK,  # type: ignore[arg-type]
            ),
        ],
        mime_type="application/json",
        description="DAI resource (Permit2)",
        extensions=erc8004_route_extensions,
    ),
}

app = FastAPI(title="ERC-8004 Agent Server")

_payment_mw = erc8004_payment_middleware(
    routes,
    server,
    agent_owner=agent_owner,
    wrapper_address=WRAPPER_ADDRESS,  # type: ignore[arg-type]
    agent_id=agent_id,
)


@app.middleware("http")
async def x402_middleware(request: Request, call_next) -> Response:
    return await _payment_mw(request, call_next)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/agent/usdc")
async def agent_usdc() -> dict[str, str | int]:
    return {"resource": "usdc", "agentId": agent_id, "message": "paid USDC content"}


@app.get("/agent/dai")
async def agent_dai() -> dict[str, str | int]:
    return {"resource": "dai", "agentId": agent_id, "message": "paid DAI content"}


if __name__ == "__main__":
    import uvicorn

    print(f"Agent server listening on port {PORT}")
    print(f"  agentId={agent_id}  payTo={AGENT_ADDRESS}")
    print(f"  facilitator={FACILITATOR_URL}")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
