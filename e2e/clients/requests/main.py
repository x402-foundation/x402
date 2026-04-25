"""requests e2e test client using x402 v2 SDK."""

import os
import json
from dotenv import load_dotenv
from eth_account import Account

from x402 import x402ClientSync
from x402.http import decode_payment_response_header
from x402.http.clients import x402_requests
from x402.mechanisms.evm import EthAccountSignerWithRPC
from x402.mechanisms.evm.exact import register_exact_evm_client
from x402.mechanisms.evm.upto import UptoEvmClientScheme
from x402.mechanisms.svm import KeypairSigner
from x402.mechanisms.svm.exact import register_exact_svm_client

# Load environment variables
load_dotenv()

# Get environment variables
evm_private_key = os.getenv("EVM_PRIVATE_KEY")
svm_private_key = os.getenv("SVM_PRIVATE_KEY")
evm_rpc_url = os.getenv("EVM_RPC_URL", "https://sepolia.base.org")
base_url = os.getenv("RESOURCE_SERVER_URL")
endpoint_path = os.getenv("ENDPOINT_PATH")

if not base_url or not endpoint_path:
    error_result = {"success": False, "error": "Missing required environment variables"}
    print(json.dumps(error_result))
    exit(1)

if not evm_private_key and not svm_private_key:
    error_result = {
        "success": False,
        "error": "At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY must be set",
    }
    print(json.dumps(error_result))
    exit(1)


def main():
    # Create x402 client (sync for requests)
    client = x402ClientSync()

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

    # Create a session with x402 payment handling
    session = x402_requests(client)

    # Make request
    try:
        response = session.get(f"{base_url}{endpoint_path}")

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
    main()
