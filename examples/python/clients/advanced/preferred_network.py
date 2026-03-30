"""Custom network preference selector example.

Demonstrates how to configure client-side payment option preferences.
The client can specify which network/scheme it prefers, with automatic
fallback to other supported options if the preferred one isn't available.

Use cases:
- Prefer specific networks or chains (e.g., prefer L2 over L1, or Solana over EVM)
- User preference settings in a wallet UI
- Cost optimization (prefer cheaper networks)
- Cross-chain flexibility (support both EVM and SVM)
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
from x402.mechanisms.svm import KeypairSigner, SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2
from x402.mechanisms.svm.exact.register import register_exact_svm_client
from x402.schemas import PaymentRequirements, PaymentRequirementsV1

load_dotenv()

# Type alias for requirements
RequirementsView = PaymentRequirements | PaymentRequirementsV1

# Define network preference order (most preferred first)
# Includes both EVM (eip155) and SVM (solana) networks
NETWORK_PREFERENCES = [
    SOLANA_MAINNET_CAIP2,  # Solana mainnet (preferred - fast & low fees)
    "eip155:8453",  # Base mainnet (low fees)
    "eip155:42161",  # Arbitrum One
    "eip155:10",  # Optimism
    "eip155:1",  # Ethereum mainnet
    SOLANA_DEVNET_CAIP2,  # Solana devnet (testnet)
    "eip155:84532",  # Base Sepolia (testnet)
]


def preferred_network_selector(
    version: int,
    options: list[RequirementsView],
) -> RequirementsView:
    """Custom selector that picks payment options based on preference order.

    NOTE: By the time this selector is called, `options` has already been
    filtered to only include options that BOTH the server offers AND the
    client has registered support for. So fallback to options[0] means
    "first mutually-supported option" (which preserves server's preference order).

    Args:
        version: The x402 protocol version.
        options: Array of mutually supported payment options.

    Returns:
        The selected payment requirement based on network preference.
    """
    print("📋 Mutually supported payment options (server offers + client supports):")
    for i, opt in enumerate(options):
        print(f"   {i + 1}. {opt.network} ({opt.scheme})")
    print()

    # Try each preference in order
    for preference in NETWORK_PREFERENCES:
        for opt in options:
            if opt.network == preference or opt.network.startswith(
                preference.split(":")[0] + ":"
            ):
                print(f"✨ Selected preferred network: {opt.network}")
                return opt

    # Fallback to first mutually-supported option (server's top preference among what we support)
    print(f"⚠️  No preferred network available, falling back to: {options[0].network}")
    return options[0]


async def run_preferred_network_example(
    evm_private_key: str | None,
    svm_private_key: str | None,
    url: str,
) -> None:
    """Run the preferred network example.

    Args:
        evm_private_key: EVM private key for signing (optional).
        svm_private_key: Solana private key for signing (optional).
        url: URL to make the request to.
    """
    if not evm_private_key and not svm_private_key:
        print("Error: At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required")
        sys.exit(1)

    print("🎯 Creating client with preferred network selection...\n")

    # Create client with custom selector
    client = x402Client(payment_requirements_selector=preferred_network_selector)

    # Register EVM signer if private key provided
    if evm_private_key:
        account = Account.from_key(evm_private_key)
        print(f"EVM wallet address: {account.address}")
        register_exact_evm_client(client, EthAccountSigner(account))

    # Register SVM signer if private key provided
    if svm_private_key:
        svm_signer = KeypairSigner.from_base58(svm_private_key)
        print(f"Solana wallet address: {svm_signer.address}")
        register_exact_svm_client(client, svm_signer)

    print(f"Network preferences: {', '.join(NETWORK_PREFERENCES)}\n")

    # Create HTTP client helper for payment response extraction
    http_client = x402HTTPClient(client)

    print(f"🌐 Making request to: {url}\n")

    async with x402HttpxClient(client) as http:
        response = await http.get(url)
        await response.aread()

        print(f"\nResponse status: {response.status_code}")
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
    evm_private_key = os.getenv("EVM_PRIVATE_KEY")
    svm_private_key = os.getenv("SVM_PRIVATE_KEY")
    base_url = os.getenv("RESOURCE_SERVER_URL", "http://localhost:4021")
    endpoint_path = os.getenv("ENDPOINT_PATH", "/weather")

    if not evm_private_key and not svm_private_key:
        print("Error: At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required")
        print("Please copy .env-local to .env and fill in the values.")
        sys.exit(1)

    url = f"{base_url}{endpoint_path}"
    await run_preferred_network_example(evm_private_key, svm_private_key, url)


if __name__ == "__main__":
    asyncio.run(main())
