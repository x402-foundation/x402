"""Network-specific registration with builder pattern example.

Demonstrates how to configure the x402Client using the builder pattern,
chaining .register() calls to map network patterns to mechanism schemes.

Use this approach when you need:
- Different signers for different networks (e.g., separate keys for mainnet vs testnet)
- Fine-grained control over which networks are supported
- Custom scheme configurations per network
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
from x402.mechanisms.evm.exact import ExactEvmScheme

load_dotenv()


async def run_builder_pattern_example(
    private_key: str,
    url: str,
    mainnet_key: str | None = None,
    testnet_key: str | None = None,
) -> None:
    """Run the builder pattern example.

    Args:
        private_key: Default EVM private key for signing.
        url: URL to make the request to.
        mainnet_key: Optional separate key for mainnet (defaults to private_key).
        testnet_key: Optional separate key for testnet (defaults to private_key).
    """
    print("🔧 Creating client with builder pattern...\n")

    # Create accounts - in production, you might use different keys per network
    default_account = Account.from_key(private_key)
    mainnet_account = Account.from_key(mainnet_key) if mainnet_key else default_account
    testnet_account = Account.from_key(testnet_key) if testnet_key else default_account

    # Create signers for different networks
    default_signer = EthAccountSigner(default_account)
    mainnet_signer = EthAccountSigner(mainnet_account)
    testnet_signer = EthAccountSigner(testnet_account)

    # Builder pattern allows fine-grained control over network registration
    # More specific patterns take precedence over wildcards
    client = (
        x402Client()
        # Wildcard: All EVM networks (fallback)
        .register("eip155:*", ExactEvmScheme(default_signer))
        # Specific: Ethereum mainnet with dedicated signer
        .register("eip155:1", ExactEvmScheme(mainnet_signer))
        # Specific: Base mainnet
        .register("eip155:8453", ExactEvmScheme(mainnet_signer))
        # Specific: Base Sepolia testnet with testnet signer
        .register("eip155:84532", ExactEvmScheme(testnet_signer))
        # Specific: Sepolia testnet
        .register("eip155:11155111", ExactEvmScheme(testnet_signer))
    )

    print("Registered networks:")
    print(f"  - eip155:* (all EVM): {default_account.address}")
    print(f"  - eip155:1 (Ethereum mainnet): {mainnet_account.address}")
    print(f"  - eip155:8453 (Base mainnet): {mainnet_account.address}")
    print(f"  - eip155:84532 (Base Sepolia): {testnet_account.address}")
    print(f"  - eip155:11155111 (Sepolia): {testnet_account.address}")
    print()

    # Show registered schemes for debugging
    schemes = client.get_registered_schemes()
    print(f"Total registered schemes: {len(schemes.get(2, []))} (v2)")
    print()

    # Create HTTP client helper for payment response extraction
    http_client = x402HTTPClient(client)

    print(f"🌐 Making request to: {url}\n")

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
            print(f"\n💰 Payment Details: {settle_response.model_dump_json(indent=2)}")
        except ValueError:
            print("\nNo payment response header found")


async def main() -> None:
    """Main entry point."""
    private_key = os.getenv("EVM_PRIVATE_KEY")
    mainnet_key = os.getenv("MAINNET_PRIVATE_KEY")  # Optional: separate mainnet key
    testnet_key = os.getenv("TESTNET_PRIVATE_KEY")  # Optional: separate testnet key
    base_url = os.getenv("RESOURCE_SERVER_URL", "http://localhost:4021")
    endpoint_path = os.getenv("ENDPOINT_PATH", "/weather")

    if not private_key:
        print("Error: EVM_PRIVATE_KEY environment variable is required")
        print("Please copy .env-local to .env and fill in the values.")
        sys.exit(1)

    url = f"{base_url}{endpoint_path}"
    await run_builder_pattern_example(private_key, url, mainnet_key, testnet_key)


if __name__ == "__main__":
    asyncio.run(main())
