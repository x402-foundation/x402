"""Payment lifecycle hooks example.

Demonstrates how to register hooks for payment creation lifecycle events.
Hooks allow you to add custom logic at different stages:
- on_before_payment_creation: Called before payment creation starts, can abort
- on_after_payment_creation: Called after successful payment creation
- on_payment_creation_failure: Called when payment creation fails, can recover

This is an advanced feature useful for:
- Logging payment events for debugging and monitoring
- Custom validation before allowing payments
- Error recovery strategies
- Metrics and analytics collection
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
from x402.schemas import (
    AbortResult,
    PaymentCreatedContext,
    PaymentCreationContext,
    PaymentCreationFailureContext,
)

load_dotenv()


async def before_payment_creation_hook(
    context: PaymentCreationContext,
) -> AbortResult | None:
    """Hook called before payment creation.

    This hook receives context about the payment being created.
    Return AbortResult to abort the payment, or None to continue.
    """
    print("🔍 [BeforePaymentCreation] Creating payment for:")
    print(f"   Network: {context.selected_requirements.network}")
    print(f"   Scheme: {context.selected_requirements.scheme}")
    print(f"   Amount: {context.selected_requirements.get_amount()}")
    print()

    # Example: Abort payments over a certain amount
    # amount = int(context.selected_requirements.get_amount())
    # if amount > 1_000_000_000:  # 1000 USDC (6 decimals)
    #     return AbortResult(reason="Payment amount exceeds limit")

    return None  # Continue with payment creation


async def after_payment_creation_hook(context: PaymentCreatedContext) -> None:
    """Hook called after successful payment creation.

    Use this for logging, metrics, or other side effects.
    Errors here are logged but don't fail the payment.
    """
    print("✅ [AfterPaymentCreation] Payment created successfully")
    print(f"   Version: {context.payment_payload.x402_version}")
    print(f"   Network: {context.selected_requirements.network}")
    print(f"   Scheme: {context.selected_requirements.scheme}")
    print()


async def payment_creation_failure_hook(
    context: PaymentCreationFailureContext,
) -> None:
    """Hook called when payment creation fails.

    You could attempt to recover by returning RecoveredPayloadResult
    with an alternative payload.
    """
    print(f"❌ [OnPaymentCreationFailure] Payment creation failed: {context.error}")
    print(f"   Network: {context.selected_requirements.network}")
    print(f"   Scheme: {context.selected_requirements.scheme}")
    print()

    # Example: Recover with a cached or alternative payload
    # return RecoveredPayloadResult(payload=cached_payload)

    return None  # Don't recover, let it fail


async def run_hooks_example(private_key: str, url: str) -> None:
    """Run the hooks example.

    Args:
        private_key: EVM private key for signing.
        url: URL to make the request to.
    """
    print("🔧 Creating client with payment lifecycle hooks...\n")

    account = Account.from_key(private_key)
    print(f"Wallet address: {account.address}\n")

    # Create client with hooks registered via builder pattern
    client = x402Client()
    register_exact_evm_client(client, EthAccountSigner(account))

    # Register lifecycle hooks
    client.on_before_payment_creation(before_payment_creation_hook)
    client.on_after_payment_creation(after_payment_creation_hook)
    client.on_payment_creation_failure(payment_creation_failure_hook)

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
    base_url = os.getenv("RESOURCE_SERVER_URL", "http://localhost:4021")
    endpoint_path = os.getenv("ENDPOINT_PATH", "/weather")

    if not private_key:
        print("Error: EVM_PRIVATE_KEY environment variable is required")
        print("Please copy .env-local to .env and fill in the values.")
        sys.exit(1)

    url = f"{base_url}{endpoint_path}"
    await run_hooks_example(private_key, url)


if __name__ == "__main__":
    asyncio.run(main())
