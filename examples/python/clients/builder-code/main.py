"""Builder Code Extension Client Example.

Example client for builder-code attribution on x402-protected endpoints. Makes a
paid request and verifies that ERC-8021 builder-code attribution was appended to
the settlement transaction calldata.

Required environment variables:
- EVM_PRIVATE_KEY: The private key of the EVM signer

Optional environment variables:
- EVM_RPC_URL: JSON-RPC endpoint for onchain verification (defaults to Base Sepolia)
- CLIENT_BUILDER_CODE: Optional builder code for client attribution (``s``)
- RESOURCE_SERVER_URL: Resource server base URL
- ENDPOINT_PATH: Paid endpoint path
"""

import asyncio
import json
import os
import sys

from dotenv import load_dotenv
from eth_account import Account
from web3 import Web3

from x402 import x402Client
from x402.extensions.builder_code import (
    BuilderCodeClientExtension,
    parse_builder_code_suffix_from_calldata,
)
from x402.http import x402HTTPClient
from x402.http.clients import x402HttpxClient
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client

load_dotenv()


async def main() -> None:
    """Make a paid request and verify builder-code attribution onchain."""
    private_key = os.getenv("EVM_PRIVATE_KEY")
    if not private_key:
        print("Error: EVM_PRIVATE_KEY environment variable is required")
        sys.exit(1)

    evm_rpc_url = os.getenv("EVM_RPC_URL", "https://sepolia.base.org")
    client_builder_code = os.getenv("CLIENT_BUILDER_CODE")
    base_url = os.getenv("RESOURCE_SERVER_URL", "http://localhost:4021")
    endpoint_path = os.getenv("ENDPOINT_PATH", "/weather")
    url = f"{base_url}{endpoint_path}"

    account = Account.from_key(private_key)
    client = x402Client()
    register_exact_evm_client(client, EthAccountSigner(account))

    if client_builder_code:
        client.register_extension(BuilderCodeClientExtension(client_builder_code))

    http_client = x402HTTPClient(client)

    print(f"Making request to: {url}\n")

    async with x402HttpxClient(client) as http:
        response = await http.get(url)
        await response.aread()

        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            body = response.json()
            print(f"Response body: {json.dumps(body)}")
        else:
            print(f"Response body: {response.text}")

        settle_response = http_client.get_payment_settle_response(
            lambda name: response.headers.get(name)
        )
        print(f"\nPayment response: {settle_response.model_dump_json(indent=2)}")

        if not settle_response.success or not settle_response.transaction:
            raise RuntimeError("Settlement did not return a transaction hash")

        tx_hash = settle_response.transaction
        w3 = Web3(Web3.HTTPProvider(evm_rpc_url))
        tx = w3.eth.get_transaction(tx_hash)
        calldata = tx["input"].hex() if isinstance(tx["input"], bytes) else tx["input"]
        if not calldata.startswith("0x"):
            calldata = f"0x{calldata}"

        attribution = parse_builder_code_suffix_from_calldata(calldata)
        if not attribution:
            raise RuntimeError(f"ERC-8021 builder-code suffix not found in calldata for {tx_hash}")

        print("\nBuilder-code attribution verified onchain:", attribution)
        print(f"Explorer: https://sepolia.basescan.org/tx/{tx_hash}")


if __name__ == "__main__":
    asyncio.run(main())
