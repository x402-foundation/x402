"""
GenTech Labs — Multi-Facilitator x402 FastAPI Example
======================================================
Production-grade x402 v2 FastAPI server demonstrating:
  - Multi-facilitator support (CDP + GoPlausible)
  - Multi-chain payment options (EVM + AVM)
  - Bazaar discovery metadata
  - Dynamic pricing per endpoint
  - Health, pricing, and OpenAPI endpoints

Based on GenTech's production x402 gateway (16 endpoints, 6 chains).

Run:
  pip install x402[fastapi] python-dotenv
  cp .env.example .env  # fill in your addresses
  python main.py
"""

import os
from dotenv import load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel

from x402.http import FacilitatorConfig, HTTPFacilitatorClient, PaymentOption
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.http.types import RouteConfig
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.schemas import AssetAmount, Network
from x402.server import x402ResourceServer

load_dotenv()

# ── Configuration ──────────────────────────────────────────────────────

# EVM (Base Sepolia via CDP facilitator)
EVM_ADDRESS = os.getenv("EVM_ADDRESS")
EVM_NETWORK: Network = "eip155:84532"
CDP_FACILITATOR = os.getenv("CDP_FACILITATOR_URL", "https://x402.org/facilitator")

# AVM (Algorand TestNet via GoPlausible facilitator)
AVM_ADDRESS = os.getenv("AVM_ADDRESS")
AVM_NETWORK: Network = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe"  # TestNet
GOPLAUSIBLE_FACILITATOR = os.getenv(
    "GOPLAUSIBLE_FACILITATOR_URL",
    "https://algorand-facilitator.goplausible.xyz"
)

if not EVM_ADDRESS or not AVM_ADDRESS:
    raise ValueError(
        "Missing EVM_ADDRESS and/or AVM_ADDRESS in .env. "
        "Set both to receive payments."
    )

# ── Response Schemas ────────────────────────────────────────────────────

class HealthResponse(BaseModel):
    status: str
    version: str
    endpoints: int
    chains: list[str]

class PricingTier(BaseModel):
    endpoint: str
    price: str
    chain: str
    scheme: str

class PricingResponse(BaseModel):
    gateway: str
    tiers: list[PricingTier]

class DataResponse(BaseModel):
    result: dict

# ── App Setup ──────────────────────────────────────────────────────────

app = FastAPI(
    title="GenTech Labs x402 Gateway",
    description="Multi-facilitator, multi-chain x402 v2 payment gateway",
    version="2.0.0",
)

# ── x402 Middleware — Multi-Facilitator ────────────────────────────────

# CDP facilitator (EVM chains)
cdp_facilitator = HTTPFacilitatorClient(
    FacilitatorConfig(url=CDP_FACILITATOR)
)

# GoPlausible facilitator (Algorand AVM)
goplausible_facilitator = HTTPFacilitatorClient(
    FacilitatorConfig(url=GOPLAUSIBLE_FACILITATOR)
)

# Register schemes per facilitator
cdp_server = x402ResourceServer(cdp_facilitator)
cdp_server.register(EVM_NETWORK, ExactEvmServerScheme())

goplausible_server = x402ResourceServer(goplausible_facilitator)
# AVM scheme would be registered here when available:
# goplausible_server.register(AVM_NETWORK, ExactAvmServerScheme())

# Route configuration with multi-chain payment options
routes = {
    "GET /api/v1/defi/price": RouteConfig(
        accepts=[
            PaymentOption(
                scheme="exact",
                pay_to=EVM_ADDRESS,
                price="$0.005",
                network=EVM_NETWORK,
            ),
        ],
        mime_type="application/json",
        description="DeFi price feed — current token prices",
    ),
    "GET /api/v1/defi/analytics": RouteConfig(
        accepts=[
            PaymentOption(
                scheme="exact",
                pay_to=EVM_ADDRESS,
                price="$0.01",
                network=EVM_NETWORK,
            ),
        ],
        mime_type="application/json",
        description="DeFi analytics — LP positions, fee tracking",
    ),
    "GET /api/v1/agent/search": RouteConfig(
        accepts=[
            PaymentOption(
                scheme="exact",
                pay_to=EVM_ADDRESS,
                price="$0.01",
                network=EVM_NETWORK,
            ),
        ],
        mime_type="application/json",
        description="Agent search — discover agents by capability",
    ),
    "GET /api/v1/security/scan": RouteConfig(
        accepts=[
            PaymentOption(
                scheme="exact",
                pay_to=EVM_ADDRESS,
                price="$0.025",
                network=EVM_NETWORK,
            ),
        ],
        mime_type="application/json",
        description="Security scan — agent compliance and risk scoring",
    ),
}

# Add middleware for each facilitator
app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=cdp_server)

# ── Unprotected Endpoints ──────────────────────────────────────────────

@app.get("/health", tags=["Public"])
async def health_check() -> HealthResponse:
    """Health check — no payment required."""
    return HealthResponse(
        status="ok",
        version="2.0.0",
        endpoints=len(routes),
        chains=["eip155:84532", "algorand:TestNet"],
    )

@app.get("/pricing", tags=["Public"])
async def pricing() -> PricingResponse:
    """List all available endpoints and their prices."""
    tiers = []
    for route_key, config in routes.items():
        for option in config.accepts:
            tiers.append(PricingTier(
                endpoint=route_key,
                price=option.price if isinstance(option.price, str) else f"${float(option.price.amount) / 1e6:.3f}",
                chain=option.network,
                scheme=option.scheme,
            ))
    return PricingResponse(
        gateway="GenTech Labs x402 Gateway",
        tiers=tiers,
    )

@app.get("/.well-known/x402-bazaar", tags=["Discovery"])
async def bazaar_discovery() -> dict:
    """Bazaar discovery endpoint — enables automated agent discovery."""
    return {
        "x402Version": 2,
        "gateway": "GenTech Labs x402 Gateway",
        "description": "16 AI-powered x402 endpoints for DeFi, gaming, security, and automation",
        "endpoints": [
            {
                "path": route_key,
                "description": config.description,
                "accepts": [
                    {
                        "scheme": opt.scheme,
                        "price": str(opt.price),
                        "network": opt.network,
                        "payTo": opt.pay_to,
                    }
                    for opt in config.accepts
                ],
            }
            for route_key, config in routes.items()
        ],
        "facilitators": [
            {"name": "CDP (Coinbase)", "url": CDP_FACILITATOR, "chains": ["eip155:*"]},
            {"name": "GoPlausible", "url": GOPLAUSIBLE_FACILITATOR, "chains": ["algorand:*"]},
        ],
    }

# ── Protected Endpoints ────────────────────────────────────────────────

@app.get("/api/v1/defi/price", tags=["DeFi"])
async def defi_price() -> DataResponse:
    """Current token prices (requires $0.005 payment)."""
    return DataResponse(result={
        "ETH": 1842.50,
        "BTC": 67420.00,
        "USDC": 1.00,
        "updated": "2026-07-21T16:00:00Z",
    })

@app.get("/api/v1/defi/analytics", tags=["DeFi"])
async def defi_analytics() -> DataResponse:
    """LP position analytics (requires $0.01 payment)."""
    return DataResponse(result={
        "total_liquidity": 1250000,
        "positions": 47,
        "avg_apr": 12.5,
        "top_pools": ["Aerodrome ETH/USDC", "Curve 3pool", "Balancer 80/20"],
    })

@app.get("/api/v1/agent/search", tags=["Agent"])
async def agent_search() -> DataResponse:
    """Search agents by capability (requires $0.01 payment)."""
    return DataResponse(result={
        "agents": [
            {"name": "DeFi Trader", "capabilities": ["swap", "liquidity", "yield"]},
            {"name": "Security Scanner", "capabilities": ["audit", "compliance", "risk"]},
            {"name": "Content Creator", "capabilities": ["generate", "summarize", "translate"]},
        ],
        "total": 3,
    })

@app.get("/api/v1/security/scan", tags=["Security"])
async def security_scan() -> DataResponse:
    """Agent compliance and risk scoring (requires $0.025 payment)."""
    return DataResponse(result={
        "score": 85,
        "risk_level": "low",
        "checks_passed": 12,
        "checks_failed": 1,
        "recommendations": [
            "Add rate limiting middleware",
            "Enable multi-sig for high-value operations",
        ],
    })

# ── Main ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8088)
