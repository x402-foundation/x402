"""
Custom x402 Client Implementation (v2 Protocol)

This example demonstrates how to implement x402 payment handling manually
using only the core packages, without the convenience wrappers like x402HttpxClient.

x402 v2 Protocol Headers:
- PAYMENT-REQUIRED: Server -> Client (402 response)
- PAYMENT-SIGNATURE: Client -> Server (retry with payment)
- PAYMENT-RESPONSE: Server -> Client (settlement confirmation)

This gives you complete control over every step of the payment flow,
useful for integrating with non-standard HTTP libraries or implementing
specialized retry logic.
"""

import asyncio
import os
import sys

import httpx
from dotenv import load_dotenv
from eth_account import Account

from x402 import x402Client
from x402.http.constants import (
    HTTP_STATUS_PAYMENT_REQUIRED,
    PAYMENT_REQUIRED_HEADER,
    PAYMENT_RESPONSE_HEADER,
    PAYMENT_SIGNATURE_HEADER,
)
from x402.http.utils import (
    decode_payment_required_header,
    decode_payment_response_header,
    encode_payment_signature_header,
)
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client
from x402.mechanisms.svm import KeypairSigner
from x402.mechanisms.svm.exact.register import register_exact_svm_client
from x402.schemas import PaymentRequired

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

    missing = []
    if not evm_private_key and not svm_private_key:
        missing.append("EVM_PRIVATE_KEY or SVM_PRIVATE_KEY")
    if not base_url:
        missing.append("RESOURCE_SERVER_URL")
    if not endpoint_path:
        missing.append("ENDPOINT_PATH")

    if missing:
        print(f"Error: Missing required environment variables: {', '.join(missing)}")
        print("Please copy .env-local to .env and fill in the values.")
        sys.exit(1)

    return evm_private_key, svm_private_key, base_url, endpoint_path


async def make_request_with_payment(client: x402Client, url: str) -> None:
    """
    Makes a request with manual x402 payment handling.

    This function demonstrates the complete payment flow:
    1. Make initial request
    2. Handle 402 Payment Required response
    3. Decode payment requirements from header
    4. Create signed payment payload
    5. Retry request with payment signature
    6. Handle success and settlement confirmation

    Args:
        client: The x402 client instance configured with payment schemes.
        url: The URL to request.
    """
    print(f"\n  Making initial request to: {url}\n")

    async with httpx.AsyncClient(timeout=30.0) as http:
        # Step 1: Make initial request (no payment)
        response = await http.get(url)
        print(f"  Initial response status: {response.status_code}\n")

        # Step 2: Handle 402 Payment Required
        if response.status_code == HTTP_STATUS_PAYMENT_REQUIRED:
            print("  Payment required! Processing...\n")

            # Step 3: Decode payment requirements from PAYMENT-REQUIRED header
            payment_required_header = response.headers.get(PAYMENT_REQUIRED_HEADER)
            if not payment_required_header:
                raise ValueError(f"Missing {PAYMENT_REQUIRED_HEADER} header")

            payment_required: PaymentRequired = decode_payment_required_header(
                payment_required_header
            )

            # Display available payment options
            accepts = payment_required.accepts
            requirements = accepts if isinstance(accepts, list) else [accepts]

            print("  Payment requirements:")
            for i, req in enumerate(requirements, 1):
                print(f"     {i}. {req.network} / {req.scheme} - {req.amount}")

            # Step 4: Create signed payment payload
            # The client will select the appropriate scheme based on registration
            print("\n  Creating payment...\n")
            payment_payload = await client.create_payment_payload(payment_required)

            # Step 5: Encode payment and retry with PAYMENT-SIGNATURE header
            payment_header = encode_payment_signature_header(payment_payload)

            print("  Retrying with payment...\n")
            response = await http.get(
                url,
                headers={PAYMENT_SIGNATURE_HEADER: payment_header},
            )
            print(f"  Response status: {response.status_code}\n")

        # Step 6: Handle response
        if response.status_code == 200:
            print("  Success!\n")
            print(f"Response: {response.json()}")

            # Decode settlement confirmation from PAYMENT-RESPONSE header
            settlement_header = response.headers.get(PAYMENT_RESPONSE_HEADER)
            if settlement_header:
                settlement = decode_payment_response_header(settlement_header)
                print("\n  Settlement:")
                print(f"     Transaction: {settlement.transaction}")
                print(f"     Network: {settlement.network}")
                print(f"     Payer: {settlement.payer}")
        elif response.status_code == HTTP_STATUS_PAYMENT_REQUIRED:
            # Payment was rejected (e.g., insufficient balance, invalid signature)
            print("  Payment rejected!\n")
            payment_response_header = response.headers.get(PAYMENT_RESPONSE_HEADER)
            if payment_response_header:
                payment_response = decode_payment_response_header(
                    payment_response_header
                )
                print(f"  Error: {payment_response.error_reason}")
            else:
                print("  No error details available in response headers.")
                print(f"  Response body: {response.text}")
        else:
            raise RuntimeError(f"Unexpected status: {response.status_code}")


async def main() -> None:
    """Main entry point demonstrating custom x402 client usage."""
    print("\n  Custom x402 Client (v2 Protocol)\n")

    # Validate environment variables
    evm_private_key, svm_private_key, base_url, endpoint_path = validate_environment()

    # Create x402 client
    # You can optionally provide a custom selector function to choose
    # between payment options when multiple are available:
    #
    #   def select_payment(version: int, requirements: list) -> PaymentRequirements:
    #       # Custom logic to select preferred payment option
    #       return requirements[0]  # Default: use first option
    #
    #   client = x402Client(selector=select_payment)
    #
    client = x402Client()

    # Register EVM payment scheme if private key provided
    if evm_private_key:
        account = Account.from_key(evm_private_key)
        register_exact_evm_client(client, EthAccountSigner(account))
        print(f"  Initialized EVM account: {account.address}")

    # Register SVM payment scheme if private key provided
    if svm_private_key:
        svm_signer = KeypairSigner.from_base58(svm_private_key)
        register_exact_svm_client(client, svm_signer)
        print(f"  Initialized SVM account: {svm_signer.address}")

    print("  Client ready\n")

    # Build full URL and make request
    url = f"{base_url}{endpoint_path}"
    await make_request_with_payment(client, url)

    print("\n  Done!")


if __name__ == "__main__":
    asyncio.run(main())
