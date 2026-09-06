"""Shared x402 client setup + batch-settlement scenario runner for httpx/requests."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

from eth_account import Account

from x402 import x402Client, x402ClientSync
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

from catalog_network import network_caip2_pattern, resolve_network_caip2


@dataclass
class ClientContext:
    base_url: str
    endpoint_path: str
    client: x402Client | x402ClientSync
    batch_scheme: Optional[BatchSettlementClientScheme]
    batch_settlement_phase: Optional[str]


def create_e2e_client(*, sync: bool = False) -> ClientContext:
    """Build a configured x402Client (or x402ClientSync) with e2e scheme registrations.

    Args:
        sync: If True, build an x402ClientSync for use with sync HTTP clients
            (e.g. requests). Defaults to False, building an async x402Client
            for use with async HTTP clients (e.g. httpx).
    """
    evm_private_key = os.getenv("CLIENT_EVM_PRIVATE_KEY")
    svm_private_key = os.getenv("CLIENT_SVM_PRIVATE_KEY")
    tvm_private_key = os.getenv("CLIENT_TVM_PRIVATE_KEY")
    evm_rpc_url = os.getenv("EVM_RPC_URL", "https://sepolia.base.org")
    svm_rpc_url = os.getenv("SVM_RPC_URL")
    tvm_provider = (os.getenv("TVM_PROVIDER") or "").strip().lower()
    toncenter_api_key = os.getenv("TVM_TONCENTER_API_KEY")
    tonapi_api_key = os.getenv("TVM_TONAPI_API_KEY")
    tvm_rpc_url = os.getenv("TVM_RPC_URL")
    tvm_network = resolve_network_caip2("tvm")
    base_url = os.getenv("RESOURCE_SERVER_URL")
    endpoint_path = os.getenv("ENDPOINT_PATH")
    channel_salt = os.getenv("EVM_BATCH_SETTLEMENT_CHANNEL")
    voucher_signer_key = os.getenv("CLIENT_EVM_BATCH_SETTLEMENT_VOUCHER_SIGNER_PRIVATE_KEY")
    batch_settlement_phase = os.getenv("EVM_BATCH_SETTLEMENT_PHASE")

    if not base_url or not endpoint_path:
        print(json.dumps({"success": False, "error": "Missing required environment variables"}))
        raise SystemExit(1)

    if not evm_private_key and not svm_private_key and not tvm_private_key:
        print(
            json.dumps(
                {
                    "success": False,
                    "error": "At least one of CLIENT_EVM_PRIVATE_KEY, CLIENT_SVM_PRIVATE_KEY, or CLIENT_TVM_PRIVATE_KEY must be set",
                }
            )
        )
        raise SystemExit(1)

    client: x402Client | x402ClientSync = x402ClientSync() if sync else x402Client()
    batch_scheme: Optional[BatchSettlementClientScheme] = None

    if evm_private_key:
        evm_pattern = network_caip2_pattern("evm")
        evm_account = Account.from_key(evm_private_key)
        evm_signer = EthAccountSignerWithRPC(evm_account, rpc_url=evm_rpc_url)
        register_exact_evm_client(client, evm_signer, networks=evm_pattern)
        client.register(evm_pattern, UptoEvmClientScheme(evm_signer))

        voucher_signer = None
        if voucher_signer_key:
            voucher_account = Account.from_key(voucher_signer_key)
            voucher_signer = EthAccountSignerWithRPC(voucher_account, rpc_url=evm_rpc_url)
        batch_scheme = BatchSettlementClientScheme(
            evm_signer,
            BatchSettlementEvmSchemeOptions(
                storage=InMemoryClientChannelStorage(),
                salt=channel_salt,
                voucher_signer=voucher_signer,
            ),
        )
        client.register(evm_pattern, batch_scheme)

    if svm_private_key:
        svm_signer = KeypairSigner.from_base58(svm_private_key)
        register_exact_svm_client(
            client, svm_signer, networks=network_caip2_pattern("svm"), rpc_url=svm_rpc_url
        )

    if tvm_private_key:
        if tvm_network not in {TVM_TESTNET, TVM_MAINNET}:
            raise ValueError(f"Unsupported TVM network: {tvm_network}")
        tvm_config = WalletV5R1Config.from_private_key(tvm_network, tvm_private_key)
        tvm_config.provider = tvm_provider or tvm_config.provider
        tvm_config.api_key = (
            tonapi_api_key if tvm_provider == TVM_PROVIDER_TONAPI else toncenter_api_key
        )
        tvm_config.provider_base_url = tvm_rpc_url
        client.register(
            network_caip2_pattern("tvm"),
            ExactTvmClientScheme(WalletV5R1MnemonicSigner(tvm_config)),
        )

    # E2e exercises custom assets and amounts above the default $1 USD cap.
    client.set_spend_controls(False)

    return ClientContext(
        base_url=base_url,
        endpoint_path=endpoint_path,
        client=client,
        batch_scheme=batch_scheme,
        batch_settlement_phase=batch_settlement_phase,
    )


def aggregate_batch_result(phase: str, results: list[dict], details: dict) -> dict:
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


def _emit_and_exit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload))
    raise SystemExit(0)


def run_client_scenario_sync(
    ctx: ClientContext,
    issue_request: Callable[[], dict[str, Any]],
    refund: Callable[[str], Any] | None = None,
) -> None:
    """Sync single-request / batch-settlement runner (requests client)."""
    if not ctx.batch_settlement_phase:
        _emit_and_exit(issue_request())

    if ctx.batch_scheme is None:
        raise RuntimeError(
            "batch-settlement scheme not registered (CLIENT_EVM_PRIVATE_KEY required)"
        )
    if refund is None:
        raise RuntimeError("refund callback required for batch-settlement phases")

    url = f"{ctx.base_url}{ctx.endpoint_path}"

    if ctx.batch_settlement_phase == "initial":
        deposit = issue_request()
        voucher = issue_request()
        _emit_and_exit(
            aggregate_batch_result(
                "initial",
                [deposit, voucher],
                {"deposit": deposit, "voucher": voucher},
            )
        )

    if ctx.batch_settlement_phase == "recovery-refund":
        recovery_voucher = issue_request()
        refund_settle = refund(url)
        refund_result = {
            "success": refund_settle.success,
            "data": {"refund": True},
            "status_code": 200,
            "payment_response": refund_settle.model_dump(),
        }
        _emit_and_exit(
            aggregate_batch_result(
                "recovery-refund",
                [recovery_voucher, refund_result],
                {"recoveryVoucher": recovery_voucher, "refund": refund_result},
            )
        )

    if ctx.batch_settlement_phase == "full":
        deposit = issue_request()
        voucher = issue_request()
        refund_settle = refund(url)
        refund_result = {
            "success": refund_settle.success,
            "data": {"refund": True},
            "status_code": 200,
            "payment_response": refund_settle.model_dump(),
        }
        _emit_and_exit(
            aggregate_batch_result(
                "full",
                [deposit, voucher, refund_result],
                {
                    "deposit": deposit,
                    "voucher": voucher,
                    "refund": refund_result,
                },
            )
        )

    raise RuntimeError(f"Unknown EVM_BATCH_SETTLEMENT_PHASE: {ctx.batch_settlement_phase}")


async def run_client_scenario(
    ctx: ClientContext,
    issue_request: Callable[[], Awaitable[dict[str, Any]]],
    refund: Callable[[str], Awaitable[Any]] | None = None,
) -> None:
    """Async single-request / batch-settlement runner (httpx client)."""
    if not ctx.batch_settlement_phase:
        _emit_and_exit(await issue_request())

    if ctx.batch_scheme is None:
        raise RuntimeError(
            "batch-settlement scheme not registered (CLIENT_EVM_PRIVATE_KEY required)"
        )
    if refund is None:
        raise RuntimeError("refund callback required for batch-settlement phases")

    url = f"{ctx.base_url}{ctx.endpoint_path}"

    if ctx.batch_settlement_phase == "initial":
        deposit = await issue_request()
        voucher = await issue_request()
        _emit_and_exit(
            aggregate_batch_result(
                "initial",
                [deposit, voucher],
                {"deposit": deposit, "voucher": voucher},
            )
        )

    if ctx.batch_settlement_phase == "recovery-refund":
        recovery_voucher = await issue_request()
        refund_settle = await refund(url)
        refund_result = {
            "success": refund_settle.success,
            "data": {"refund": True},
            "status_code": 200,
            "payment_response": refund_settle.model_dump(),
        }
        _emit_and_exit(
            aggregate_batch_result(
                "recovery-refund",
                [recovery_voucher, refund_result],
                {"recoveryVoucher": recovery_voucher, "refund": refund_result},
            )
        )

    if ctx.batch_settlement_phase == "full":
        deposit = await issue_request()
        voucher = await issue_request()
        refund_settle = await refund(url)
        refund_result = {
            "success": refund_settle.success,
            "data": {"refund": True},
            "status_code": 200,
            "payment_response": refund_settle.model_dump(),
        }
        _emit_and_exit(
            aggregate_batch_result(
                "full",
                [deposit, voucher, refund_result],
                {
                    "deposit": deposit,
                    "voucher": voucher,
                    "refund": refund_result,
                },
            )
        )

    raise RuntimeError(f"Unknown EVM_BATCH_SETTLEMENT_PHASE: {ctx.batch_settlement_phase}")
