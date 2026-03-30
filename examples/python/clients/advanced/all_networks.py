"""All Networks Client Example.

Demonstrates how to create a client that supports all available networks with
optional chain configuration via environment variables.

New chain support should be added here in alphabetic order by network prefix
(e.g., "eip155" before "solana").
"""

import asyncio
import os
import sys

from dotenv import load_dotenv
from eth_account import Account

from x402 import x402Client
from x402.http import x402HTTPClient
from x402.http.clients import x402HttpxClient
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client
from x402.mechanisms.svm import KeypairSigner
from x402.mechanisms.svm.exact.register import register_exact_svm_client

# Load environment variables
load_dotenv()


def validate_environment() -> tuple[str | None, str | None, str, str]:
    """Validate required environment variables.

    Returns:
        Tuple of (evm_private_key, svm_private_key, base_url, endpoint_path).

    Raises:
        SystemExit: If required environment variables are missing.
    """
    evm_private_key = os.getenv("EVM_PRIVATE_KEY")
    svm_private_key = os.getenv("SVM_PRIVATE_KEY")
    base_url = os.getenv("RESOURCE_SERVER_URL")
    endpoint_path = os.getenv("ENDPOINT_PATH")

    # Validate at least one private key is provided
    if not evm_private_key and not svm_private_key:
        print("❌ At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required")
        print("Please copy .env-local to .env and fill in the values.")
        sys.exit(1)

    if not base_url:
        print("❌ RESOURCE_SERVER_URL is required")
        sys.exit(1)

    if not endpoint_path:
        print("❌ ENDPOINT_PATH is required")
        sys.exit(1)

    return evm_private_key, svm_private_key, base_url, endpoint_path


async def main() -> None:
    """Main entry point demonstrating httpx with x402 payments."""
    # Validate environment
    evm_private_key, svm_private_key, base_url, endpoint_path = validate_environment()

    # Create x402 client
    client = x402Client()

    # Register EVM payment scheme if private key provided
    if evm_private_key:
        account = Account.from_key(evm_private_key)
        register_exact_evm_client(client, EthAccountSigner(account))
        print(f"Initialized EVM account: {account.address}")

    # Register SVM payment scheme if private key provided
    if svm_private_key:
        svm_signer = KeypairSigner.from_base58(svm_private_key)
        register_exact_svm_client(client, svm_signer)
        print(f"Initialized SVM account: {svm_signer.address}")

    # Create HTTP client helper for payment response extraction
    http_client = x402HTTPClient(client)

    # Build full URL
    url = f"{base_url}{endpoint_path}"
    print(f"\nMaking request to: {url}\n")

    # Make request using async context manager
    async with x402HttpxClient(client) as http:
        response = await http.get(url)
        await response.aread()

        print(f"Response status: {response.status_code}")
        print(f"Response body: {response.text}")

        # Extract and print payment response if present
        try:
            settle_response = http_client.get_payment_settle_response(
                lambda name: response.headers.get(name)
            )
            print(f"\nPayment response: {settle_response.model_dump_json(indent=2)}")
        except ValueError:
            print("\nNo payment response header found")


if __name__ == "__main__":
    asyncio.run(main())
