"""Sign-In-With-X client example."""

import asyncio
import json
import os
import sys

from dotenv import load_dotenv
from eth_account import Account

from x402 import x402Client
from x402.extensions.sign_in_with_x import (
    CreateSIWxClientExtensionOptions,
    create_siwx_client_extension,
)
from x402.http import x402HTTPClient
from x402.http.clients import x402HttpxClient
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client
from x402.mechanisms.svm.signers import KeypairSigner

load_dotenv()

EVM_PRIVATE_KEY = os.getenv("EVM_PRIVATE_KEY")
SVM_PRIVATE_KEY = os.getenv("SVM_PRIVATE_KEY")
BASE_URL = os.getenv("RESOURCE_SERVER_URL", "http://localhost:4021")


def log_payment_response(http_client: x402HTTPClient, response) -> bool:
    """Print settlement details when the response includes a payment header."""
    try:
        settle_response = http_client.get_payment_settle_response(
            lambda name: response.headers.get(name)
        )
        body = json.dumps(
            settle_response.model_dump(by_alias=True, exclude_none=True),
            indent=2,
        )
        print("   ✓ Paid via payment settlement")
        print("   Payment response:")
        print("\n".join(f"   {line}" for line in body.splitlines()))
        return True
    except ValueError:
        return False


async def demonstrate_auth_only(http: x402HttpxClient) -> None:
    print("\n--- /profile (auth-only, no payment) ---")
    response = await http.get(f"{BASE_URL}/profile")
    await response.aread()
    body = response.json()
    if response.is_success:
        print("   ✓ Authenticated via SIWX (no payment required)")
        print("   Response:", body)
    else:
        print("   ✗ Auth failed:", body)


async def demonstrate_resource(http: x402HttpxClient, http_client: x402HTTPClient, path: str) -> None:
    url = f"{BASE_URL}{path}"
    print(f"\n--- {path} ---")
    print("1. First request...")
    response1 = await http.get(url)
    await response1.aread()
    body1 = response1.json()
    log_payment_response(http_client, response1)
    if response1.is_success:
        print("   Response:", body1)

    print("2. Second request...")
    response2 = await http.get(url)
    await response2.aread()
    body2 = response2.json()
    has_payment = log_payment_response(http_client, response2)
    if response2.is_success:
        if not has_payment:
            print("   ✓ Authenticated via SIWX (previously paid)")
        print("   Response:", body2)


async def main() -> None:
    if not EVM_PRIVATE_KEY and not SVM_PRIVATE_KEY:
        print("Error: At least one private key required (EVM_PRIVATE_KEY or SVM_PRIVATE_KEY)")
        sys.exit(1)

    signers = []
    client = x402Client()
    if EVM_PRIVATE_KEY:
        account = Account.from_key(EVM_PRIVATE_KEY)
        print(f"Client EVM address: {account.address}")
        register_exact_evm_client(client, EthAccountSigner(account))
        signers.append(account)
    if SVM_PRIVATE_KEY:
        svm_signer = KeypairSigner.from_base58(SVM_PRIVATE_KEY)
        print(f"Client SVM address: {svm_signer.address}")
        from x402.mechanisms.svm.exact.register import register_exact_svm_client

        register_exact_svm_client(client, svm_signer)
        signers.append(svm_signer)

    client.register_extension(
        create_siwx_client_extension(CreateSIWxClientExtensionOptions(signers=signers))
    )
    http_client = x402HTTPClient(client)

    print(f"Server: {BASE_URL}")
    async with x402HttpxClient(client) as http:
        await demonstrate_auth_only(http)
        await demonstrate_resource(http, http_client, "/weather")
        await asyncio.sleep(0.3)
        await demonstrate_resource(http, http_client, "/joke")

    print("\nDone. /profile used auth-only SIWX. /weather and /joke used payment + SIWX.")


if __name__ == "__main__":
    asyncio.run(main())
