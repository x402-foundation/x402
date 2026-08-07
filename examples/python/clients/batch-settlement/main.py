"""x402 batch-settlement httpx client example.

Issues a sequence of paid requests against a batch-settlement-protected
resource. The first request opens an on-chain payment channel (deposit);
each subsequent request is settled off-chain as a voucher against the
same channel until the client cooperatively refunds the unused balance.

Run with:
    uv sync && uv run python main.py

Environment variables:
    RESOURCE_SERVER_URL              Required. e.g. http://localhost:4021
    ENDPOINT_PATH                    Optional. e.g. /weather (default /weather)
    EVM_PRIVATE_KEY                  Required. Payer (client) private key.
    EVM_VOUCHER_SIGNER_PRIVATE_KEY   Optional. Dedicated voucher-signing key (payerAuthorizer).
    EVM_RPC_URL                      Optional. Defaults to https://sepolia.base.org.
    CHANNEL_SALT                     Optional. 32-byte hex salt for channel ID derivation.
    DEPOSIT_MULTIPLIER               Optional. Deposit = multiplier * request_price (default 5).
    STORAGE_DIR                      Optional. Directory for persistent file-backed channel storage.
    NUMBER_OF_REQUESTS               Optional. Number of paid requests to issue (default 3).
    REFUND_AFTER_REQUESTS            Optional. Set to "true" to issue a cooperative refund at the end.
    REFUND_AMOUNT                    Optional. Base-unit amount for partial refund (default: full balance).
"""

from __future__ import annotations

import asyncio
import os
import sys
import time

from dotenv import load_dotenv
from eth_account import Account
import httpx

from x402 import x402Client
from x402.http import x402HTTPClient
from x402.http.clients import x402_httpx_transport
from x402.mechanisms.evm import EthAccountSignerWithRPC
from x402.mechanisms.evm.batch_settlement.client import (
    BatchSettlementDepositPolicy,
    BatchSettlementEvmScheme,
    BatchSettlementEvmSchemeOptions,
    FileChannelStorageOptions,
    FileClientChannelStorage,
    InMemoryClientChannelStorage,
    RefundOptions,
)
from x402.mechanisms.evm.signers import EthAccountSigner

load_dotenv()

RESOURCE_SERVER_URL = os.getenv("RESOURCE_SERVER_URL") or "http://localhost:4021"
ENDPOINT_PATH = os.getenv("ENDPOINT_PATH", "/weather")
EVM_PRIVATE_KEY = os.getenv("EVM_PRIVATE_KEY")
EVM_VOUCHER_SIGNER_PRIVATE_KEY = os.getenv("EVM_VOUCHER_SIGNER_PRIVATE_KEY", "").strip() or None
EVM_RPC_URL = os.getenv("EVM_RPC_URL", "https://sepolia.base.org")
CHANNEL_SALT = (
    os.getenv("CHANNEL_SALT")
    or "0x0000000000000000000000000000000000000000000000000000000000000000"
)
DEPOSIT_MULTIPLIER = int(os.getenv("DEPOSIT_MULTIPLIER", "5"))
STORAGE_DIR = os.getenv("STORAGE_DIR")
NUMBER_OF_REQUESTS = int(os.getenv("NUMBER_OF_REQUESTS", "3"))
REFUND_AFTER_REQUESTS = os.getenv("REFUND_AFTER_REQUESTS", "").lower() == "true"
REFUND_AMOUNT = os.getenv("REFUND_AMOUNT", "").strip() or None

if not (RESOURCE_SERVER_URL and EVM_PRIVATE_KEY):
    print("Missing required EVM_PRIVATE_KEY")
    sys.exit(1)


async def main() -> None:
    account = Account.from_key(EVM_PRIVATE_KEY)
    signer = EthAccountSignerWithRPC(account, rpc_url=EVM_RPC_URL)

    voucher_signer: EthAccountSigner | None = None
    if EVM_VOUCHER_SIGNER_PRIVATE_KEY:
        voucher_signer = EthAccountSigner(Account.from_key(EVM_VOUCHER_SIGNER_PRIVATE_KEY))

    storage = (
        FileClientChannelStorage(FileChannelStorageOptions(directory=STORAGE_DIR))
        if STORAGE_DIR
        else InMemoryClientChannelStorage()
    )

    batch_scheme = BatchSettlementEvmScheme(
        signer,
        BatchSettlementEvmSchemeOptions(
            deposit_policy=BatchSettlementDepositPolicy(deposit_multiplier=DEPOSIT_MULTIPLIER),
            salt=CHANNEL_SALT,
            storage=storage,
            voucher_signer=voucher_signer,
        ),
    )
    client = x402Client().register("eip155:*", batch_scheme)
    http_client = x402HTTPClient(client)

    url = f"{RESOURCE_SERVER_URL}{ENDPOINT_PATH}"

    payer_authorizer = voucher_signer.address if voucher_signer else account.address
    print(f"Base URL: {RESOURCE_SERVER_URL}, endpoint: {ENDPOINT_PATH}")
    print(f"payer: {account.address}")
    print(f"payerAuthorizer: {payer_authorizer}\n")
    print(f"Issuing {NUMBER_OF_REQUESTS} paid request(s) to {url}\n")

    timeout = httpx.Timeout(30.0, connect=10.0)
    async with httpx.AsyncClient(
        timeout=timeout, transport=x402_httpx_transport(client)
    ) as http:
        for i in range(NUMBER_OF_REQUESTS):
            t0 = time.perf_counter()
            response = await http.get(url)
            elapsed = time.perf_counter() - t0

            label = "deposit" if i == 0 else "voucher"
            print(f"Request {i + 1} — RESPONSE ({label})")
            try:
                print(response.json())
            except ValueError:
                print(response.text)
            try:
                settle = http_client.get_payment_settle_response(
                    lambda name: response.headers.get(name)
                )
                print(settle.model_dump_json(indent=2))
            except ValueError:
                pass
            print(f"Request {i + 1} — completed in {elapsed:.3f}s\n")

    if REFUND_AFTER_REQUESTS:
        if REFUND_AMOUNT:
            print(f"REQUESTING PARTIAL REFUND of {REFUND_AMOUNT} base units")
        else:
            print("REQUESTING FULL REFUND of remaining channel balance")

        t0 = time.perf_counter()
        refund = await asyncio.to_thread(
            batch_scheme.refund, url, RefundOptions(amount=REFUND_AMOUNT)
        )
        elapsed = time.perf_counter() - t0
        print(refund.model_dump_json(indent=2))
        print(f"Refund completed in {elapsed:.3f}s")


if __name__ == "__main__":
    asyncio.run(main())
