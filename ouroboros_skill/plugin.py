"""
x402_agentpay — OuroborosHub Extension Skill
Gives Ouroboros the ability to pay for AI agent services using USDC on Base L2
via the x402 micropayment protocol.

Endpoints exposed:
  GET  /x402/agents          — list all available x402 agents with prices
  POST /x402/query           — query a specific agent (pays USDC via x402)
  GET  /x402/agwc-price      — live AGWC/USD price from on-chain pool
  GET  /x402/economy         — live AgentWorld economy snapshot (free)
  POST /x402/discover        — discover x402 endpoints from any base URL
"""

from __future__ import annotations
import json, urllib.request, urllib.error
from typing import Any

# ── constants ──────────────────────────────────────────────────────────────────
AGENTSTORE_BASE   = "https://agentpaystore.com"
FACILITATOR_URL   = "https://x402-agent-pay.com/facilitator"
AGENTWORLD_API    = "https://agentworld.me/api/agentworld"
TREASURY_ADDRESS  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

AGENTS = {
    "wally":    {"name": "WALLY",    "desc": "Real-time market analysis + Tavily web search", "price": 0.10, "slug": "wally"},
    "cipher":   {"name": "CIPHER",   "desc": "Crypto intelligence + on-chain data",           "price": 0.10, "slug": "cipher"},
    "scout":    {"name": "SCOUT",    "desc": "Research & lead generation",                     "price": 0.10, "slug": "scout"},
    "feeds":    {"name": "FEEDS",    "desc": "Live crypto news aggregation",                   "price": 0.05, "slug": "feeds"},
    "gridiron": {"name": "GRIDIRON", "desc": "NFL stats & fantasy analysis",                   "price": 0.10, "slug": "gridiron"},
    "hardwood": {"name": "HARDWOOD", "desc": "NBA stats & analytics",                          "price": 0.10, "slug": "hardwood"},
    "blades":   {"name": "BLADES",   "desc": "NHL analysis",                                   "price": 0.10, "slug": "blades"},
    "duke":     {"name": "DUKE",     "desc": "General AI assistant",                           "price": 0.10, "slug": "duke"},
}

# ── helpers ────────────────────────────────────────────────────────────────────

def _get(url: str, timeout: int = 8) -> dict:
    """Simple GET → JSON dict."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}", "url": url}
    except Exception as e:
        return {"error": str(e), "url": url}


def _post(url: str, body: dict, headers: dict | None = None, timeout: int = 15) -> dict:
    """Simple POST JSON → JSON dict."""
    data = json.dumps(body).encode()
    req  = urllib.request.Request(url, data=data,
           headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return {"error": f"HTTP {e.code}", "body": json.loads(raw)}
        except Exception:
            return {"error": f"HTTP {e.code}", "raw": raw.decode(errors="replace")}
    except Exception as e:
        return {"error": str(e)}


# ── plugin API ─────────────────────────────────────────────────────────────────

def register(plugin_api):
    """Called by Ouroboros when the skill is loaded."""

    @plugin_api.tool("x402_list_agents")
    def list_agents() -> dict:
        """
        List all available AI agents on AgentPayStore with their capabilities
        and per-query USDC price. No payment required — this is a free discovery call.
        """
        return {
            "agents": [
                {
                    "slug":  a["slug"],
                    "name":  a["name"],
                    "desc":  a["desc"],
                    "price_usdc": a["price"],
                    "endpoint": f"{AGENTSTORE_BASE}/{a['slug']}/api/query",
                    "openapi":  f"{AGENTSTORE_BASE}/{a['slug']}/openapi.json",
                }
                for a in AGENTS.values()
            ],
            "facilitator": FACILITATOR_URL,
            "payment_asset": "USDC",
            "network": "Base L2",
            "note": "All agents accept per-query micropayments via x402. No subscription required.",
        }

    @plugin_api.tool("x402_query_agent")
    def query_agent(slug: str, query: str, access_code: str = "") -> dict:
        """
        Query a specific AI agent on AgentPayStore. This tool calls the agent's
        x402-gated endpoint. The query is sent to the facilitator which handles
        USDC payment on Base L2, then forwards to the agent and returns the response.

        Args:
            slug:        Agent slug (e.g. 'wally', 'cipher', 'scout', 'feeds')
            query:       Your question or task for the agent
            access_code: Optional access code if you have a pre-paid plan
        """
        slug = slug.lower().strip()
        if slug not in AGENTS:
            return {
                "error": f"Unknown agent '{slug}'",
                "available": list(AGENTS.keys()),
            }
        agent = AGENTS[slug]
        endpoint = f"{AGENTSTORE_BASE}/{slug}/api/query"

        # First — probe the endpoint to get x402 payment descriptor
        probe = _post(endpoint, {"query": query, "access_code": access_code})

        # If we got a 402, the facilitator handles the payment cycle
        if probe.get("error", "").startswith("HTTP 402") or probe.get("payment_required"):
            # Route through facilitator
            fac_payload = {
                "endpoint":    endpoint,
                "query":       query,
                "access_code": access_code,
                "asset":       "USDC",
                "amount":      str(agent["price"]),
                "network":     "base",
                "pay_to":      TREASURY_ADDRESS,
            }
            result = _post(f"{FACILITATOR_URL}/pay-and-forward", fac_payload)
            return {
                "agent":   agent["name"],
                "query":   query,
                "paid_usdc": agent["price"],
                "response": result,
            }

        # If access_code worked or endpoint is open — return directly
        return {
            "agent":    agent["name"],
            "query":    query,
            "response": probe,
        }

    @plugin_api.tool("x402_agwc_price")
    def agwc_price() -> dict:
        """
        Get the live $AGWC token price in USD from the AgentWorld Uniswap V2
        pool on Base L2. Free — no payment required.

        $AGWC (AgentWorld Credits) is the native utility token of AgentWorld.
        Contract: 0xfa6071375b2bC079BF781D51906Beee0b6F53b0B (Base L2)
        Pool: 0x24235Fa9dab948E6fde2d2B369BDa08d598E8242 (Uniswap V2, AGWC/USDC)
        """
        data = _get(f"{AGENTWORLD_API}/agwc-price")
        if "error" in data:
            return {"price_usd": 0.000002, "source": "fallback", "note": str(data["error"])}
        return {
            "price_usd":       data.get("price_usd", 0),
            "agwc_reserve":    data.get("agwc_reserve"),
            "usdc_reserve":    data.get("usdc_reserve"),
            "liquidity_usd":   data.get("liquidity_usd"),
            "contract":        "0xfa6071375b2bC079BF781D51906Beee0b6F53b0B",
            "pool":            "0x24235Fa9dab948E6fde2d2B369BDa08d598E8242",
            "network":         "Base L2",
            "dex":             "Uniswap V2",
            "tokenomics_page": "https://agentworld.me/tokenomics",
        }

    @plugin_api.tool("x402_agentworld_economy")
    def agentworld_economy() -> dict:
        """
        Get a live snapshot of the AgentWorld autonomous AI economy.
        Shows treasury USDC, active agents, AGWC circulation, Gini coefficient,
        and city GDP breakdown. Free — no payment required.
        """
        data = _get(f"{AGENTWORLD_API}/economy")
        if "error" in data:
            return {"error": str(data["error"]), "url": AGENTWORLD_API + "/economy"}
        return {
            "treasury_usdc":  data.get("treasury_usdc"),
            "total_agents":   data.get("total_agents"),
            "total_awc":      data.get("total_awc"),
            "gini":           data.get("gini"),
            "tick":           data.get("tick"),
            "cities":         data.get("cities", {}),
            "live_url":       "https://agentworld.me",
            "note": (
                "AgentWorld is a live autonomous AI economy on Base L2. "
                "99+ agents earn USDC, trade jobs, bet on MLB games, and mine $AGWC 24/7. "
                "Part of the $MUSKOX on Solana ecosystem — MUSKOX holders earn platform dividends."
            ),
        }

    @plugin_api.tool("x402_discover_endpoints")
    def discover_endpoints(base_url: str = "https://agentpaystore.com") -> dict:
        """
        Discover all x402-compatible agent endpoints from a base URL by
        fetching its OpenAPI manifest. Returns endpoint paths, pricing,
        and payment details for each agent.

        Args:
            base_url: The root URL to check for an OpenAPI manifest (default: agentpaystore.com)
        """
        openapi_url = base_url.rstrip("/") + "/openapi.json"
        spec = _get(openapi_url)
        if "error" in spec:
            return {"error": f"Could not fetch OpenAPI from {openapi_url}", "detail": spec}

        endpoints = []
        paths = spec.get("paths", {})
        for path, methods in paths.items():
            for method, op in methods.items():
                if method.lower() in ("get", "post", "put"):
                    endpoints.append({
                        "path":        path,
                        "method":      method.upper(),
                        "summary":     op.get("summary", ""),
                        "price_usdc":  op.get("x-price-usdc"),
                        "security":    op.get("security"),
                    })

        payment_info = spec.get("info", {}).get("x-payment-required", {})
        return {
            "base_url":     base_url,
            "title":        spec.get("info", {}).get("title", ""),
            "facilitator":  spec.get("x-facilitator", FACILITATOR_URL),
            "payment":      payment_info,
            "endpoints":    endpoints,
            "total":        len(endpoints),
        }
