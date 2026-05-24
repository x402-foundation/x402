"""x402 batch-settlement FastAPI server example.

Demonstrates a usage-based pricing API protected by the batch-settlement
EVM scheme on Base Sepolia. Clients first deposit into a payment channel,
then issue follow-up requests as off-chain vouchers — the server's
ChannelManager periodically claims/settles vouchers and refunds idle
channels.

Run with:
    uv sync && uv run python main.py

Environment variables:
    EVM_ADDRESS                            Required. Receiver/payee address.
    FACILITATOR_URL                        Required. Batch-settlement-aware facilitator URL.
    EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY    Optional. Local receiver-authorizer signer
                                           (when unset, falls back to the facilitator).
    STORAGE_DIR                            Optional. Persist channel state across restarts.
    DEFERRED_WITHDRAW_DELAY_SECONDS        Optional. Channel withdraw delay (default 86400).
"""

from __future__ import annotations

import os
import random
import sys
from contextlib import asynccontextmanager
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi import Response as FastAPIResponse

from x402 import x402ResourceServer
from x402.http import FacilitatorConfig, HTTPFacilitatorClient
from x402.http.middleware.fastapi import payment_middleware, set_settlement_overrides
from x402.mechanisms.evm.batch_settlement import SCHEME_BATCH_SETTLEMENT
from x402.mechanisms.evm.batch_settlement.authorizer_signer import LocalAuthorizerSigner
from x402.mechanisms.evm.batch_settlement.server import (
    AutoSettlementConfig,
    BatchSettlementEvmScheme,
    BatchSettlementEvmSchemeServerConfig,
    FileChannelStorage,
)

load_dotenv()

PORT = int(os.getenv("PORT", "4021"))
EVM_NETWORK = "eip155:84532"  # Base Sepolia
MAX_PRICE = "$0.01"

EVM_ADDRESS = os.getenv("EVM_ADDRESS")
FACILITATOR_URL = os.getenv("FACILITATOR_URL")
RECEIVER_AUTH_KEY = os.getenv("EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY")
STORAGE_DIR = os.getenv("STORAGE_DIR")
WITHDRAW_DELAY = int(os.getenv("DEFERRED_WITHDRAW_DELAY_SECONDS", "86400"))

if not EVM_ADDRESS:
    print("Missing required EVM_ADDRESS")
    sys.exit(1)
if not FACILITATOR_URL:
    print("Missing required FACILITATOR_URL")
    sys.exit(1)

scheme_config = BatchSettlementEvmSchemeServerConfig(
    withdraw_delay=WITHDRAW_DELAY,
    receiver_authorizer_signer=(
        LocalAuthorizerSigner(RECEIVER_AUTH_KEY) if RECEIVER_AUTH_KEY else None
    ),
    storage=FileChannelStorage(STORAGE_DIR) if STORAGE_DIR else None,
)
scheme = BatchSettlementEvmScheme(EVM_ADDRESS, scheme_config)

facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL))
server = x402ResourceServer(facilitator)
server.register(EVM_NETWORK, scheme)

manager = scheme.create_channel_manager(facilitator, EVM_NETWORK)

_auto_settle_config = AutoSettlementConfig(
    claim_interval_secs=60,
    settle_interval_secs=120,
    refund_interval_secs=180,
    max_claims_per_batch=100,
    # Refund channels idle for > 3 minutes.
    select_refund_channels=lambda channels, ctx: [
        c
        for c in channels
        if c.balance not in ("", "0")
        and (c.pending_request is None or c.pending_request.expires_at <= ctx.now)
        and ctx.now - c.last_request_timestamp >= 180_000
    ],
    on_claim=lambda r: print(f"Claimed {r.vouchers} vouchers (tx: {r.transaction})"),
    on_settle=lambda r: print(f"Settled to {EVM_ADDRESS} (tx: {r.transaction})"),
    on_refund=lambda r: print(f"Refunded channel {r.channel} (tx: {r.transaction})"),
    on_error=lambda err: print(f"Settlement error: {err}"),
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    manager.start(_auto_settle_config)
    yield
    print("Shutting down — flushing pending claims…")
    await manager.stop(flush=True)


app = FastAPI(lifespan=lifespan)

routes = {
    "GET /weather": {
        "accepts": {
            "scheme": SCHEME_BATCH_SETTLEMENT,
            "payTo": EVM_ADDRESS,
            "price": MAX_PRICE,
            "network": EVM_NETWORK,
        },
    },
}


@app.middleware("http")
async def x402_payment_middleware(request, call_next):
    return await payment_middleware(routes, server)(request, call_next)


@app.get("/weather")
async def weather(response: FastAPIResponse) -> dict[str, Any]:
    """Bill a random 1-100% fraction of MAX_PRICE to demonstrate usage-based pricing."""
    percent = 1 + random.randint(0, 99)
    set_settlement_overrides(response, {"amount": f"{percent}%"})
    return {"report": {"weather": "sunny", "temperature": 70}}


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    print(f"Batch-settlement server listening at http://localhost:{PORT}")
    print("  GET /weather")
    if scheme_config.receiver_authorizer_signer is not None:
        print(
            f"  Receiver authorizer: local signer "
            f"{scheme_config.receiver_authorizer_signer.address}"
        )
    else:
        print("  Receiver authorizer: facilitator")

    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
