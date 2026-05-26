"""MCP E2E Test Client with x402 Payment Support.

One-shot client that connects to an MCP server via SSE, calls a paid tool,
and outputs a structured JSON result for the e2e test framework to parse.
Uses the x402 SDK's MCP client wrapper for automatic payment handling.
"""

import asyncio
import json
import os
import sys

from dotenv import load_dotenv

load_dotenv()

# Get environment variables
server_url = os.getenv("RESOURCE_SERVER_URL", "")
endpoint_path = os.getenv("ENDPOINT_PATH", "")  # tool name, e.g. "get_weather"
evm_private_key = os.getenv("EVM_PRIVATE_KEY", "")
tvm_private_key = os.getenv("TVM_PRIVATE_KEY", "")

if not server_url or not endpoint_path or not (evm_private_key or tvm_private_key):
    result = {
        "success": False,
        "error": (
            "Missing required environment variables: RESOURCE_SERVER_URL, ENDPOINT_PATH, "
            "and one of EVM_PRIVATE_KEY or TVM_PRIVATE_KEY"
        ),
    }
    print(json.dumps(result))
    sys.exit(1)


async def main() -> dict:
    """Run the MCP client and call the paid tool. Returns the e2e result dict."""
    from eth_account import Account

    from x402 import x402Client
    from x402.mcp import create_x402_mcp_client
    from x402.mechanisms.evm.exact import register_exact_evm_client
    from x402.mechanisms.evm.signers import EthAccountSigner
    from x402.mechanisms.tvm import (
        TVM_MAINNET,
        TVM_PROVIDER_TONAPI,
        TVM_TESTNET,
        WalletV5R1Config,
        WalletV5R1MnemonicSigner,
    )
    from x402.mechanisms.tvm.exact import ExactTvmClientScheme

    # Create x402 client with the configured payment schemes
    client = x402Client()
    if evm_private_key:
        account = Account.from_key(evm_private_key)
        evm_signer = EthAccountSigner(account)
        register_exact_evm_client(client, evm_signer)

    if tvm_private_key:
        tvm_network = os.getenv("TVM_NETWORK", TVM_TESTNET)
        if tvm_network not in {TVM_TESTNET, TVM_MAINNET}:
            raise ValueError(f"Unsupported TVM network: {tvm_network}")
        tvm_config = WalletV5R1Config.from_private_key(tvm_network, tvm_private_key)
        tvm_provider = (os.getenv("TVM_PROVIDER") or "").strip().lower()
        tvm_config.provider = tvm_provider or tvm_config.provider
        tvm_config.api_key = (
            os.getenv("TONAPI_API_KEY")
            if tvm_provider == TVM_PROVIDER_TONAPI
            else os.getenv("TONCENTER_API_KEY")
        )
        tvm_config.provider_base_url = (
            os.getenv("TONAPI_BASE_URL")
            if tvm_provider == TVM_PROVIDER_TONAPI
            else os.getenv("TONCENTER_BASE_URL")
        )
        client.register(
            tvm_network,
            ExactTvmClientScheme(WalletV5R1MnemonicSigner(tvm_config)),
        )

    try:
        async with create_x402_mcp_client(client, server_url, auto_payment=True) as mcp:
            # Call the paid tool - payment is handled automatically
            result = await mcp.call_tool(endpoint_path, {"city": "San Francisco"})

            # Extract data from content
            data = None
            for item in result.content:
                if hasattr(item, "text"):
                    try:
                        data = json.loads(item.text)
                    except (json.JSONDecodeError, TypeError):
                        data = {"text": item.text}
                    break

            # Build payment response dict
            payment_response = None
            if result.payment_response:
                pr = result.payment_response
                if hasattr(pr, "model_dump"):
                    payment_response = pr.model_dump(by_alias=True)
                elif isinstance(pr, dict):
                    payment_response = pr

            return {
                "success": not result.is_error,
                "data": data,
                "status_code": 200,
                "payment_response": payment_response,
            }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "status_code": 500,
        }


if __name__ == "__main__":
    e2e_result = asyncio.run(main())
    print(json.dumps(e2e_result))
    sys.exit(0 if e2e_result.get("success") else 1)
