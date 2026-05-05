"""
Prediction Market Oracle — x402 example server.

Fetches live Polymarket signals from the DeepBlue trading API and gates
them behind a per-call x402 micropayment. Any x402-capable agent can
pay and immediately receive a directional signal with confidence score.

Run:
    uv run python main.py
"""

import os

import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel

from x402.http import FacilitatorConfig, HTTPFacilitatorClient, PaymentOption
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.http.types import RouteConfig
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.mechanisms.svm.exact import ExactSvmServerScheme
from x402.server import x402ResourceServer

load_dotenv()

EVM_ADDRESS = os.getenv("EVM_ADDRESS")
SVM_ADDRESS = os.getenv("SVM_ADDRESS")
EVM_NETWORK = "eip155:8453"   # Base Mainnet
SVM_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"  # Solana Mainnet
FACILITATOR_URL = os.getenv("FACILITATOR_URL", "https://x402.org/facilitator")
DEEPBLUE_API = "https://api.deepbluebase.xyz"

if not EVM_ADDRESS or not SVM_ADDRESS:
    raise ValueError("EVM_ADDRESS and SVM_ADDRESS must be set in .env")


# ── Response schemas ─────────────────────────────────────────────────────────

class Signal(BaseModel):
    coin: str
    direction: str       # "UP" or "DOWN"
    confidence: float    # 0.50 – 0.78
    regime: str
    source: str


class PolymarketMarket(BaseModel):
    question: str
    market_id: str
    best_bid: float
    best_ask: float
    volume_24h: float


class HealthResponse(BaseModel):
    status: str
    version: str


# ── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Prediction Market Oracle",
    description=(
        "Live Polymarket signals from an autonomous trading bot. "
        "Pay $0.002 per signal with USDC via x402."
    ),
    version="1.0.0",
)

facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL))
server = x402ResourceServer(facilitator)
server.register(EVM_NETWORK, ExactEvmServerScheme())
server.register(SVM_NETWORK, ExactSvmServerScheme())

routes = {
    "GET /signal/{coin}": RouteConfig(
        accepts=[
            PaymentOption(scheme="exact", pay_to=EVM_ADDRESS, price="$0.002", network=EVM_NETWORK),
            PaymentOption(scheme="exact", pay_to=SVM_ADDRESS, price="$0.002", network=SVM_NETWORK),
        ],
        description="5-minute directional signal for BTC, ETH, SOL, or XRP",
    ),
    "GET /markets": RouteConfig(
        accepts=[
            PaymentOption(scheme="exact", pay_to=EVM_ADDRESS, price="$0.005", network=EVM_NETWORK),
            PaymentOption(scheme="exact", pay_to=SVM_ADDRESS, price="$0.005", network=SVM_NETWORK),
        ],
        description="Top Polymarket crypto prediction markets with live odds",
    ),
}

app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(status="ok", version="1.0.0")


@app.get("/signal/{coin}", response_model=Signal)
async def get_signal(coin: str):
    """
    Returns a 5-minute directional trading signal for the given coin.
    Powered by a live Polymarket bot with a verified track record.
    Costs $0.002 USDC per call via x402.
    """
    coin = coin.upper()
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{DEEPBLUE_API}/signals", params={"coin": coin})
        resp.raise_for_status()
        data = resp.json()

    signals = data.get("signals", [])
    match = next((s for s in signals if s.get("coin", "").upper() == coin), None)
    if not match:
        # Return neutral signal if coin not found
        return Signal(coin=coin, direction="NEUTRAL", confidence=0.50, regime="unknown", source="deepblue")

    return Signal(
        coin=match["coin"],
        direction=match.get("direction", "NEUTRAL"),
        confidence=float(match.get("confidence", 0.50)),
        regime=match.get("regime", "unknown"),
        source="deepblue-polymarket-bot",
    )


@app.get("/markets", response_model=list[PolymarketMarket])
async def get_markets():
    """
    Returns top Polymarket crypto prediction markets with live odds.
    Costs $0.005 USDC per call via x402.
    """
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{DEEPBLUE_API}/polymarket")
        resp.raise_for_status()
        data = resp.json()

    markets = data.get("markets", [])[:10]
    return [
        PolymarketMarket(
            question=m.get("question", ""),
            market_id=m.get("market_id", ""),
            best_bid=float(m.get("best_bid", 0)),
            best_ask=float(m.get("best_ask", 0)),
            volume_24h=float(m.get("volume_24h", 0)),
        )
        for m in markets
    ]


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=4022)
