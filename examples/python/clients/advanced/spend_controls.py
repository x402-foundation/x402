"""Spend controls example.

Demonstrates client-side spend_controls: the default ``$1`` USD cap on
recognized pegged assets, opt-in ``allowed_assets`` (atomic per-asset caps or
uncapped), and ticker overrides for a default asset.
"""

from __future__ import annotations

from eth_account import Account

from x402 import x402Client, x402ClientConfig, SchemeRegistration
from x402.http import x402HTTPClient
from x402.http.clients import x402HttpxClient
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact import ExactEvmScheme
from x402.mechanisms.evm.upto import UptoEvmScheme


async def run_spend_controls_example(evm_private_key: str, url: str) -> None:
    """Run the spend controls example.

    Args:
        evm_private_key: The EVM private key for signing.
        url: The URL to make the request to.
    """
    print("🛡️  Creating client with spend_controls...\n")

    account = Account.from_key(evm_private_key)
    evm_signer = EthAccountSigner(account)

    client = x402Client.from_config(
        x402ClientConfig(
            schemes=[
                SchemeRegistration(network="eip155:*", client=ExactEvmScheme(evm_signer)),
                SchemeRegistration(network="eip155:*", client=UptoEvmScheme(evm_signer)),
            ],
            spend_controls={
                "max_amount_per_payment": "$1",  # default USD cap on recognized pegged assets
                "allowed_assets": [
                    # opt-in non-default with atomic cap
                    {
                        "network": "eip155:*",
                        "asset": "0xCustomToken",
                        "max_amount_per_payment": "2000000",
                    },
                    # opt-in non-default uncapped
                    {"network": "eip155:*", "asset": "0xOtherToken"},
                    # override USD cap for a default asset by ticker (or on-chain id)
                    {
                        "network": "eip155:*",
                        "asset": "USDC",
                        "max_amount_per_payment": "1000000",
                    },
                ],
            },
        )
    )

    http_client = x402HTTPClient(client)

    print(f"🌐 Making request to: {url}\n")
    async with x402HttpxClient(client) as http:
        response = await http.get(url)
        await response.aread()
        body = response.text

    print("✅ Request completed with spend_controls\n")
    print(f"Response body: {body}")

    try:
        payment_response = http_client.get_payment_settle_response(
            lambda name: response.headers.get(name)
        )
        print(f"\n💰 Payment Details: {payment_response.model_dump_json(indent=2)}")
    except ValueError:
        print("\nNo payment response header found")
