"""httpx e2e test client using x402 v2 SDK."""

import logging
import os
import json
import asyncio
from dotenv import load_dotenv
from eth_account import Account

logging.basicConfig(
    level=logging.INFO,
    format="%(name)s %(levelname)s: %(message)s",
    stream=__import__("sys").stderr,
)
logging.getLogger("x402.signers").setLevel(logging.DEBUG)
logging.getLogger("x402.permit2").setLevel(logging.DEBUG)

from x402 import x402Client
from x402.http import decode_payment_response_header
from x402.http.clients import x402_httpx_transport
from x402.mechanisms.evm import EthAccountSignerWithRPC
from x402.mechanisms.evm.exact import register_exact_evm_client
from x402.mechanisms.evm.upto import UptoEvmClientScheme
from x402.mechanisms.evm.batch_settlement.client import (
    BatchSettlementEvmScheme as BatchSettlementClientScheme,
    BatchSettlementEvmSchemeOptions,
    InMemoryClientChannelStorage,
)
from x402.mechanisms.svm import KeypairSigner
from x402.mechanisms.svm.exact import register_exact_svm_client
from x402.mechanisms.tvm import (
    TVM_MAINNET,
    TVM_PROVIDER_TONAPI,
    TVM_TESTNET,
    WalletV5R1Config,
    WalletV5R1MnemonicSigner,
)
from x402.mechanisms.tvm.exact import ExactTvmClientScheme
import httpx

# Load environment variables
load_dotenv()

# Get environment variables
evm_private_key = os.getenv("EVM_PRIVATE_KEY")
svm_private_key = os.getenv("SVM_PRIVATE_KEY")
tvm_private_key = os.getenv("TVM_PRIVATE_KEY")
evm_rpc_url = os.getenv("EVM_RPC_URL", "https://sepolia.base.org")
svm_rpc_url = os.getenv("SVM_RPC_URL")
tvm_provider = (os.getenv("TVM_PROVIDER") or "").strip().lower()
toncenter_api_key = os.getenv("TONCENTER_API_KEY")
toncenter_base_url = os.getenv("TONCENTER_BASE_URL")
tonapi_api_key = os.getenv("TONAPI_API_KEY")
tonapi_base_url = os.getenv("TONAPI_BASE_URL")
tvm_network = os.getenv("TVM_NETWORK", TVM_TESTNET)
base_url = os.getenv("RESOURCE_SERVER_URL")
endpoint_path = os.getenv("ENDPOINT_PATH")
channel_salt = os.getenv("CHANNEL_SALT")
voucher_signer_key = os.getenv("EVM_VOUCHER_SIGNER_PRIVATE_KEY")
batch_settlement_phase = os.getenv("BATCH_SETTLEMENT_PHASE")

if not base_url or not endpoint_path:
    error_result = {"success": False, "error": "Missing required environment variables"}
    print(json.dumps(error_result))
    exit(1)

if not evm_private_key and not svm_private_key and not tvm_private_key:
    error_result = {
        "success": False,
        "error": "At least one of EVM_PRIVATE_KEY, SVM_PRIVATE_KEY, or TVM_PRIVATE_KEY must be set",
    }
    print(json.dumps(error_result))
    exit(1)


async def main():
    # Create x402 client
    client = x402Client()
    batch_scheme = None

    # Register EVM exact scheme if private key is available
    if evm_private_key:
        evm_account = Account.from_key(evm_private_key)
        evm_signer = EthAccountSignerWithRPC(evm_account, rpc_url=evm_rpc_url)
        register_exact_evm_client(client, evm_signer)
        client.register("eip155:*", UptoEvmClientScheme(evm_signer))

        # Batch-settlement scheme uses a per-scenario salt (CHANNEL_SALT) so
        # concurrent e2e runs don't collide on the same on-chain channel id. An
        # optional voucher signer (EVM_VOUCHER_SIGNER_PRIVATE_KEY) exercises the
        # alt-EOA voucher branch while deposits keep using the main client signer.
        voucher_signer = None
        if voucher_signer_key:
            voucher_account = Account.from_key(voucher_signer_key)
            voucher_signer = EthAccountSignerWithRPC(
                voucher_account, rpc_url=evm_rpc_url
            )
        batch_scheme = BatchSettlementClientScheme(
            evm_signer,
            BatchSettlementEvmSchemeOptions(
                storage=InMemoryClientChannelStorage(),
                salt=channel_salt,
                voucher_signer=voucher_signer,
            ),
        )
        client.register("eip155:*", batch_scheme)

    # Register SVM exact scheme if private key is available
    if svm_private_key:
        svm_signer = KeypairSigner.from_base58(svm_private_key)
        register_exact_svm_client(client, svm_signer, rpc_url=svm_rpc_url)

    if tvm_private_key:
        if tvm_network not in {TVM_TESTNET, TVM_MAINNET}:
            raise ValueError(f"Unsupported TVM network: {tvm_network}")
        tvm_config = WalletV5R1Config.from_private_key(tvm_network, tvm_private_key)
        tvm_config.provider = tvm_provider or tvm_config.provider
        tvm_config.api_key = (
            tonapi_api_key if tvm_provider == TVM_PROVIDER_TONAPI else toncenter_api_key
        )
        tvm_config.provider_base_url = (
            tonapi_base_url
            if tvm_provider == TVM_PROVIDER_TONAPI
            else toncenter_base_url
        )
        client.register(
            tvm_network,
            ExactTvmClientScheme(WalletV5R1MnemonicSigner(tvm_config)),
        )

    # Create httpx client with x402 payment transport and increased timeout
    # Set timeout to 30 seconds to handle busy servers during test runs
    timeout = httpx.Timeout(30.0, connect=10.0)
    async with httpx.AsyncClient(
        base_url=base_url,
        timeout=timeout,
        transport=x402_httpx_transport(client),
    ) as http_client:
        async def issue_request() -> dict:
            response = await http_client.get(endpoint_path)
            response_data = json.loads(response.content.decode())
            result = {
                "success": True,
                "data": response_data,
                "status_code": response.status_code,
                "payment_response": None,
            }
            payment_header = response.headers.get(
                "PAYMENT-RESPONSE"
            ) or response.headers.get("X-PAYMENT-RESPONSE")
            if payment_header:
                payment_response = decode_payment_response_header(payment_header)
                result["payment_response"] = payment_response.model_dump()
                if not payment_response.success:
                    result["success"] = False
            return result

        def aggregate_batch_result(
            phase: str, results: list[dict], details: dict
        ) -> dict:
            last = results[-1]
            return {
                "success": all(r["success"] for r in results),
                "data": {
                    "batchSettlement": {
                        "phase": phase,
                        "requests": results,
                        **details,
                    },
                },
                "status_code": last["status_code"],
                "payment_response": last.get("payment_response"),
            }

        try:
            if not batch_settlement_phase:
                result = await issue_request()
                print(json.dumps(result))
                exit(0)

            if batch_scheme is None:
                raise RuntimeError(
                    "batch-settlement scheme not registered (EVM_PRIVATE_KEY required)"
                )
            url = f"{base_url}{endpoint_path}"

            if batch_settlement_phase == "initial":
                deposit = await issue_request()
                voucher = await issue_request()
                print(
                    json.dumps(
                        aggregate_batch_result(
                            "initial",
                            [deposit, voucher],
                            {"deposit": deposit, "voucher": voucher},
                        )
                    )
                )
                exit(0)

            if batch_settlement_phase == "recovery-refund":
                recovery_voucher = await issue_request()
                refund_settle = await asyncio.to_thread(batch_scheme.refund, url)
                refund = {
                    "success": refund_settle.success,
                    "data": {"refund": True},
                    "status_code": 200,
                    "payment_response": refund_settle.model_dump(),
                }
                print(
                    json.dumps(
                        aggregate_batch_result(
                            "recovery-refund",
                            [recovery_voucher, refund],
                            {"recoveryVoucher": recovery_voucher, "refund": refund},
                        )
                    )
                )
                exit(0)

            if batch_settlement_phase == "full":
                deposit = await issue_request()
                voucher = await issue_request()
                refund_settle = await asyncio.to_thread(batch_scheme.refund, url)
                refund = {
                    "success": refund_settle.success,
                    "data": {"refund": True},
                    "status_code": 200,
                    "payment_response": refund_settle.model_dump(),
                }
                print(
                    json.dumps(
                        aggregate_batch_result(
                            "full",
                            [deposit, voucher, refund],
                            {
                                "deposit": deposit,
                                "voucher": voucher,
                                "refund": refund,
                            },
                        )
                    )
                )
                exit(0)

            raise RuntimeError(
                f"Unknown BATCH_SETTLEMENT_PHASE: {batch_settlement_phase}"
            )

        except Exception as e:
            error_result = {
                "success": False,
                "error": str(e),
                "status_code": getattr(e, "response", {}).get("status_code", None)
                if hasattr(e, "response")
                else None,
            }
            print(json.dumps(error_result))
            exit(1)


if __name__ == "__main__":
    asyncio.run(main())
