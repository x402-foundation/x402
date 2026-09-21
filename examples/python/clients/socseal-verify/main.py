"""socseal-verify — reference: pay an exact USDC fee (x402 v2) for PQ-signed
verification over https://socseal.xyz (price-gated data + settlement proof).
The client answers the 402 challenge, pays, retries, and receives an
ML-DSA-87 (FIPS-204) receipt proving the settlement MINED on-chain. Zero
trust: a bot verifies the signature offline — no account, no KYC.

Usage:
    pip install "x402[extensions]" eth-account python-dotenv
    export EVM_PRIVATE_KEY=... && python3 main.py
"""
import asyncio
import json
import os
import sys

from dotenv import load_dotenv
from eth_account import Account

from x402 import x402Client
from x402.http import x402HTTPClient
from x402.http.clients import x402HttpxClient
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client

load_dotenv()
BASE = os.getenv("SOCSEAL_URL", "https://socseal.xyz")


async def paid_get(http, path: str) -> dict:
    res = await http.get(f"{BASE}{path}")
    await res.aread()
    try:
        return json.loads(res.text)
    except Exception:
        return {"status": getattr(res, "status_code", "?"), "body": res.text[:200]}


async def main() -> None:
    key = os.getenv("EVM_PRIVATE_KEY", "")
    if not key:
        print("EVM_PRIVATE_KEY required"); sys.exit(1)
    account = Account.from_key(key)
    print("payer:", account.address)

    client = x402Client()
    register_exact_evm_client(client, EthAccountSigner(account))
    http_client = x402HTTPClient(client)

    async with x402HttpxClient(client) as http:
        r1 = await paid_get(http, "/data/price?pair=BTCUSDT")          # $0.09
        print("price:", r1)
        r2 = await paid_get(http, "/data/brief?pair=NEARUSDT")         # $0.27
        print("brief keys:", list(r2)[:8] if isinstance(r2, dict) else r2)
    print("verify the ML-DSA-87 signature offline; /settle/verify covers SOC receipts.")


if __name__ == "__main__":
    asyncio.run(main())
