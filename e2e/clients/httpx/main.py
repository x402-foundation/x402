"""httpx e2e test client using x402 v2 SDK."""

import logging
import os
import json
import asyncio
from dotenv import load_dotenv
from eth_account import Account

logging.basicConfig(
    level=logging.INFO,
    format="%(name)s %(levelname)s: %(message)s",
    stream=__import__("sys").stderr,
)
logging.getLogger("x402.signers").setLevel(logging.DEBUG)
logging.getLogger("x402.permit2").setLevel(logging.DEBUG)

from x402 import x402Client
from x402.http import decode_payment_response_header
from x402.http.clients import x402_httpx_transport
from x402.mechanisms.evm import EthAccountSignerWithRPC
from x402.mechanisms.evm.exact import register_exact_evm_client
from x402.mechanisms.evm.upto import UptoEvmClientScheme
from x402.mechanisms.svm import KeypairSigner
from x402.mechanisms.svm.exact import register_exact_svm_client
from x402.mechanisms.tvm import (
    TVM_MAINNET,
    TVM_PROVIDER_TONAPI,
    TVM_TESTNET,
    WalletV5R1Config,
    WalletV5R1MnemonicSigner,
)
from x402.mechanisms.tvm.exact import ExactTvmClientScheme
import httpx

# Load environment variables
load_dotenv()

# Get environment variables
evm_private_key = os.getenv("EVM_PRIVATE_KEY")
svm_private_key = os.getenv("SVM_PRIVATE_KEY")
tvm_private_key = os.getenv("TVM_PRIVATE_KEY")
evm_rpc_url = os.getenv("EVM_RPC_URL", "https://sepolia.base.org")
tvm_provider = (os.getenv("TVM_PROVIDER") or "").strip().lower()
toncenter_api_key = os.getenv("TONCENTER_API_KEY")
toncenter_base_url = os.getenv("TONCENTER_BASE_URL")
tonapi_api_key = os.getenv("TONAPI_API_KEY")
tonapi_base_url = os.getenv("TONAPI_BASE_URL")
tvm_network = os.getenv("TVM_NETWORK", TVM_TESTNET)
base_url = os.getenv("RESOURCE_SERVER_URL")
endpoint_path = os.getenv("ENDPOINT_PATH")

if not base_url or not endpoint_path:
    error_result = {"success": False, "error": "Missing required environment variables"}
    print(json.dumps(error_result))
    exit(1)

if not evm_private_key and not svm_private_key and not tvm_private_key:
    error_result = {
        "success": False,
        "error": "At least one of EVM_PRIVATE_KEY, SVM_PRIVATE_KEY, or TVM_PRIVATE_KEY must be set",
    }
    print(json.dumps(error_result))
    exit(1)


async def main():
    # Create x402 client
    client = x402Client()

    # Register EVM exact scheme if private key is available
    if evm_private_key:
        evm_account = Account.from_key(evm_private_key)
        evm_signer = EthAccountSignerWithRPC(evm_account, rpc_url=evm_rpc_url)
        register_exact_evm_client(client, evm_signer)
        client.register("eip155:*", UptoEvmClientScheme(evm_signer))

    # Register SVM exact scheme if private key is available
    if svm_private_key:
        svm_signer = KeypairSigner.from_base58(svm_private_key)
        register_exact_svm_client(client, svm_signer)

    if tvm_private_key:
        if tvm_network not in {TVM_TESTNET, TVM_MAINNET}:
            raise ValueError(f"Unsupported TVM network: {tvm_network}")
        tvm_config = WalletV5R1Config.from_private_key(tvm_network, tvm_private_key)
        tvm_config.provider = tvm_provider or tvm_config.provider
        tvm_config.api_key = (
            tonapi_api_key if tvm_provider == TVM_PROVIDER_TONAPI else toncenter_api_key
        )
        tvm_config.provider_base_url = (
            tonapi_base_url
            if tvm_provider == TVM_PROVIDER_TONAPI
            else toncenter_base_url
        )
        client.register(
            tvm_network,
            ExactTvmClientScheme(WalletV5R1MnemonicSigner(tvm_config)),
        )

    # Create httpx client with x402 payment transport and increased timeout
    # Set timeout to 30 seconds to handle busy servers during test runs
    timeout = httpx.Timeout(30.0, connect=10.0)
    async with httpx.AsyncClient(
        base_url=base_url,
        timeout=timeout,
        transport=x402_httpx_transport(client),
    ) as http_client:
        # Make request
        try:
            response = await http_client.get(endpoint_path)

            # Read the response content
            content = response.content
            response_data = json.loads(content.decode())

            # Prepare result
            result = {
                "success": True,
                "data": response_data,
                "status_code": response.status_code,
                "payment_response": None,
            }

            # Check for payment response header (V2: PAYMENT-RESPONSE, V1: X-PAYMENT-RESPONSE)
            payment_header = response.headers.get(
                "PAYMENT-RESPONSE"
            ) or response.headers.get("X-PAYMENT-RESPONSE")
            if payment_header:
                payment_response = decode_payment_response_header(payment_header)
                result["payment_response"] = payment_response.model_dump()

            # Output structured result as JSON for proxy to parse
            print(json.dumps(result))
            exit(0)

        except Exception as e:
            error_result = {
                "success": False,
                "error": str(e),
                "status_code": getattr(e, "response", {}).get("status_code", None)
                if hasattr(e, "response")
                else None,
            }
            print(json.dumps(error_result))
            exit(1)


if __name__ == "__main__":
    asyncio.run(main())
