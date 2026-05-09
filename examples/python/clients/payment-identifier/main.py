"""Payment-Identifier Extension Client Example.

Demonstrates how to use the payment-identifier extension to enable idempotency
when making payments. This allows safe retries without duplicate payments.

This example:
1. Makes a request with a unique payment ID
2. Makes a second request with the SAME payment ID
3. The second request returns from cache without payment processing

Required environment variables:
- EVM_PRIVATE_KEY: The private key of the EVM signer
"""

import asyncio
import os
import sys
import time

from dotenv import load_dotenv
from eth_account import Account

from x402 import x402Client
from x402.extensions.payment_identifier import (
    append_payment_identifier_to_extensions,
    generate_payment_id,
)
from x402.http import x402HTTPClient
from x402.http.clients import x402HttpxClient
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client
from x402.schemas import PaymentCreationContext

load_dotenv()


async def main() -> None:
    """Main entry point demonstrating payment-identifier extension for idempotency."""
    # Validate environment
    private_key = os.getenv("EVM_PRIVATE_KEY")
    if not private_key:
        print("Error: EVM_PRIVATE_KEY environment variable is required")
        sys.exit(1)

    base_url = os.getenv("RESOURCE_SERVER_URL", "http://localhost:4022")
    endpoint_path = os.getenv("ENDPOINT_PATH", "/weather")
    url = f"{base_url}{endpoint_path}"

    # Create x402 client
    account = Account.from_key(private_key)
    client = x402Client()
    register_exact_evm_client(client, EthAccountSigner(account))

    # Generate a unique payment ID for this request
    payment_id = generate_payment_id()
    print(f"\nGenerated Payment ID: {payment_id}")

    # Hook into the payment flow to add payment identifier BEFORE payload creation
    # We modify paymentRequired.extensions to include our payment ID
    async def before_payment_creation(context: PaymentCreationContext) -> None:
        extensions = context.payment_required.extensions
        if extensions is not None:
            # Append our payment ID to the extensions (only if server declared the extension)
            append_payment_identifier_to_extensions(extensions, payment_id)

    client.on_before_payment_creation(before_payment_creation)

    # Create HTTP client helper for payment response extraction
    http_client = x402HTTPClient(client)

    # First request - will process payment
    print("\n" + "=" * 52)
    print(f"First Request (with payment ID: {payment_id})")
    print("=" * 52)
    print(f"Making request to: {url}\n")

    async with x402HttpxClient(client) as http:
        start_time1 = time.time()
        response1 = await http.get(url)
        await response1.aread()
        duration1 = int((time.time() - start_time1) * 1000)

        print(f"Response ({duration1}ms): {response1.text}")

        # Extract and print payment response if present
        try:
            settle_response = http_client.get_payment_settle_response(
                lambda name: response1.headers.get(name)
            )
            print(f"\nPayment response: {settle_response.model_dump_json(indent=2)}")
        except ValueError:
            pass

        # Second request - same payment ID, should return from cache
        print("\n" + "=" * 52)
        print(f"Second Request (SAME payment ID: {payment_id})")
        print("=" * 52)
        print(f"Making request to: {url}\n")
        print("Expected: Server returns cached response without payment processing\n")

        start_time2 = time.time()
        response2 = await http.get(url)
        await response2.aread()
        duration2 = int((time.time() - start_time2) * 1000)

        print(f"Response ({duration2}ms): {response2.text}")

        try:
            settle_response = http_client.get_payment_settle_response(
                lambda name: response2.headers.get(name)
            )
            print(f"\nPayment response: {settle_response.model_dump_json(indent=2)}")
        except ValueError:
            print("\nNo payment processed - response served from cache!")

        # Summary
        print("\n" + "=" * 52)
        print("Summary")
        print("=" * 52)
        print(f"   Payment ID: {payment_id}")
        print(f"   First request:  {duration1}ms (payment processed)")
        print(f"   Second request: {duration2}ms (cached)")
        if duration2 < duration1 and duration1 > 0:
            speedup = round((1 - duration2 / duration1) * 100)
            print(f"   Cached response was {speedup}% faster!")
        print()


if __name__ == "__main__":
    asyncio.run(main())
