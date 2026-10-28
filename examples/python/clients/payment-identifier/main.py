"""Payment-Identifier Extension Client Example.

Demonstrates how to use the payment-identifier extension to enable idempotency
when making payments. This allows safe retries without duplicate payments.

This example:
1. Makes a request with a unique payment ID
2. Captures the first exact encoded payment header
3. Replays that header on a later 402 only for the configured exact request URL
   and selected accepted terms. The helper is sequential single-URL scope.
4. The second request returns from cache without payment processing

Required environment variables:
- EVM_PRIVATE_KEY: The private key of the EVM signer
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import time
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

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
from x402.schemas import (
    PaymentCreatedContext,
    PaymentCreationContext,
    PaymentRequiredContext,
    PaymentRequiredHeadersResult,
)

load_dotenv()


def _requirements_mapping(value: Any) -> Mapping[str, Any]:
    if value is None:
        return {}
    if isinstance(value, Mapping):
        return value
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        dumped = dump(by_alias=True)
        if isinstance(dumped, Mapping):
            return dumped
    return {}


def accepted_terms_fingerprint(requirements: Any) -> str:
    """Deterministic fingerprint of selected accepted payment terms.

    Covers scheme, network, asset, amount, payTo, maxTimeoutSeconds, and
    recursively canonical extra. Used only as a replay-context key.
    """
    terms = _requirements_mapping(requirements)
    extra = terms.get("extra")
    timeout = terms.get("maxTimeoutSeconds", terms.get("max_timeout_seconds"))
    material = {
        "amount": str(terms.get("amount") or ""),
        "asset": str(terms.get("asset") or ""),
        "extra": json.dumps(
            extra if extra is not None else {},
            separators=(",", ":"),
            sort_keys=True,
            ensure_ascii=False,
        ),
        "maxTimeoutSeconds": "" if timeout is None else str(timeout),
        "network": str(terms.get("network") or ""),
        "payTo": str(terms.get("payTo") or terms.get("pay_to") or ""),
        "scheme": str(terms.get("scheme") or ""),
    }
    canonical = json.dumps(
        material, separators=(",", ":"), sort_keys=True, ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _accepts_include_terms(payment_required: Any, terms: str) -> bool:
    accepts = getattr(payment_required, "accepts", None) or []
    return any(accepted_terms_fingerprint(item) == terms for item in accepts)


def configure_exact_header_replay(
    client: x402Client, http_client: x402HTTPClient, target_url: str
) -> tuple[
    dict[str, object],
    Callable[[PaymentCreatedContext], Awaitable[None]],
]:
    """Capture the first encoded payment header for one exact target URL.

    ``target_url`` is immutable configuration. PaymentCreatedContext has no
    request URL, so a shared mutable pending_url cannot correlate concurrent
    402s. This helper is an educational sequential-retry client for that one
    URL. A 402 for any other origin, path, or query before capture poisons
    capture (fail closed): the credential is not stored and is not replayed.
    Replay still requires an exact URL string match and matching selected
    accepted terms. Never replays cross-origin, cross-path, or against
    different accepted terms. Does not print or persist the header.
    """
    captured: dict[str, object] = {"url": target_url}
    saw_target_required = False
    saw_foreign_required = False

    async def after_payment_creation(context: PaymentCreatedContext) -> None:
        if (
            captured.get("headers")
            or not target_url
            or not saw_target_required
            or saw_foreign_required
        ):
            return
        captured["headers"] = dict(
            http_client.encode_payment_signature_header(context.payment_payload)
        )
        captured["terms"] = accepted_terms_fingerprint(context.selected_requirements)

    async def on_payment_required(
        context: PaymentRequiredContext,
    ) -> PaymentRequiredHeadersResult | None:
        nonlocal saw_target_required, saw_foreign_required
        headers = captured.get("headers")
        if context.request_url != target_url:
            if not isinstance(headers, dict) or not headers:
                saw_foreign_required = True
            return None
        if isinstance(headers, dict) and headers:
            terms = captured.get("terms")
            if not isinstance(terms, str) or not _accepts_include_terms(
                context.payment_required, terms
            ):
                return None
            return PaymentRequiredHeadersResult(headers=headers)
        if target_url:
            saw_target_required = True
        return None

    client.on_after_payment_creation(after_payment_creation)
    http_client.on_payment_required(on_payment_required)
    return captured, after_payment_creation


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

    http_client = x402HTTPClient(client)
    configure_exact_header_replay(client, http_client, url)

    # First request - will process payment
    print("\n" + "=" * 52)
    print(f"First Request (with payment ID: {payment_id})")
    print("=" * 52)
    print(f"Making request to: {url}\n")

    async with x402HttpxClient(http_client) as http:
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
            print(f"\nPayment settled on {settle_response.network}")
        except ValueError:
            pass

        # Second request - same payment ID, replay the exact encoded header
        print("\n" + "=" * 52)
        print(f"Second Request (SAME payment ID: {payment_id})")
        print("=" * 52)
        print(f"Making request to: {url}\n")
        print(
            "Expected: replay exact payment header; cached response, no new signature\n"
        )

        start_time2 = time.time()
        response2 = await http.get(url)
        await response2.aread()
        duration2 = int((time.time() - start_time2) * 1000)

        print(f"Response ({duration2}ms): {response2.text}")

        try:
            settle_response = http_client.get_payment_settle_response(
                lambda name: response2.headers.get(name)
            )
            print(f"\nPayment settled on {settle_response.network}")
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
