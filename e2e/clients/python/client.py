"""Shared x402 client setup + batch-settlement scenario runner for httpx/requests."""

from __future__ import annotations

import json
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from catalog_network import network_caip2_pattern, resolve_network_caip2
from eth_account import Account

from x402 import x402Client, x402ClientSync
from x402.mechanisms.evm import EthAccountSignerWithRPC
from x402.mechanisms.evm.batch_settlement.client import (
    BatchSettlementEvmScheme as BatchSettlementClientScheme,
)
from x402.mechanisms.evm.batch_settlement.client import (
    BatchSettlementEvmSchemeOptions,
    InMemoryClientChannelStorage,
)
from x402.mechanisms.evm.exact import register_exact_evm_client
from x402.mechanisms.evm.upto import UptoEvmClientScheme
from x402.mechanisms.svm import KeypairSigner
from x402.mechanisms.svm.batch_settlement import (
    BatchServerSignedChannelsPolicy,
    BatchSvmClientConfig,
    BatchSvmClientScheme,
)
from x402.mechanisms.svm.exact import register_exact_svm_client
from x402.mechanisms.tvm import (
    TVM_MAINNET,
    TVM_PROVIDER_TONAPI,
    TVM_TESTNET,
    WalletV5R1Config,
    WalletV5R1MnemonicSigner,
)
from x402.mechanisms.tvm.exact import ExactTvmClientScheme

BatchSettlementScheme = BatchSettlementClientScheme | BatchSvmClientScheme


def svm_channel_salt(channel_salt: str) -> str:
    """Fold the harness's 32-byte hex salt to the same u64 used by TypeScript."""
    value = int(channel_salt, 16 if channel_salt.lower().startswith("0x") else 10)
    if value < 0:
        raise ValueError("BATCH_SETTLEMENT_CHANNEL must be unsigned")
    return str(value % (1 << 64))


@dataclass
class ClientContext:
    base_url: str
    endpoint_path: str
    client: x402Client | x402ClientSync
    batch_scheme: BatchSettlementScheme | None
    batch_settlement_phase: str | None


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
    channel_salt = os.getenv("BATCH_SETTLEMENT_CHANNEL", os.getenv("EVM_BATCH_SETTLEMENT_CHANNEL"))
    voucher_signer_key = os.getenv("CLIENT_EVM_BATCH_SETTLEMENT_VOUCHER_SIGNER_PRIVATE_KEY")
    batch_settlement_phase = os.getenv(
        "BATCH_SETTLEMENT_PHASE", os.getenv("EVM_BATCH_SETTLEMENT_PHASE")
    )

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
    batch_scheme: BatchSettlementScheme | None = None
    # Both wallets may be configured; the route determines the lifecycle/refund family.
    # MCP uses underscore-separated catalog tool names instead of HTTP paths.
    batch_family = "svm" if "svm" in endpoint_path.replace("/", "_").split("_") else "evm"

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
        evm_batch_scheme = BatchSettlementClientScheme(
            evm_signer,
            BatchSettlementEvmSchemeOptions(
                storage=InMemoryClientChannelStorage(),
                salt=channel_salt,
                voucher_signer=voucher_signer,
            ),
        )
        client.register(evm_pattern, evm_batch_scheme)
        if batch_family == "evm":
            batch_scheme = evm_batch_scheme

    if svm_private_key:
        svm_signer = KeypairSigner.from_base58(svm_private_key)
        svm_pattern = network_caip2_pattern("svm")
        register_exact_svm_client(client, svm_signer, networks=svm_pattern, rpc_url=svm_rpc_url)
        operators = [
            value.strip()
            for value in os.getenv("CLIENT_SVM_SERVER_SIGNED_OPERATORS", "").split(",")
            if value.strip()
        ]
        max_deposit = os.getenv("CLIENT_SVM_SERVER_SIGNED_MAX_DEPOSIT", "").strip()
        svm_batch_scheme = BatchSvmClientScheme(
            svm_signer,
            BatchSvmClientConfig(
                rpc_url=svm_rpc_url,
                salt=svm_channel_salt(channel_salt) if channel_salt else 0,
                # Recovery runs in a fresh process and must discover the initial channel.
                discover_channels=True,
                server_signed_channels_policy=(
                    BatchServerSignedChannelsPolicy(
                        allowed_operators=operators, max_deposit=max_deposit or "$1"
                    )
                    if operators
                    else None
                ),
            ),
        )
        client.register(svm_pattern, svm_batch_scheme)
        if batch_family == "svm":
            batch_scheme = svm_batch_scheme
            client.register_policy(svm_batch_scheme.payment_policy)

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
    failed = next((result for result in results if not result["success"]), None)
    last = failed or results[-1]
    return {
        "success": all(r["success"] for r in results),
        **({"error": last["error"]} if last.get("error") else {}),
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


def _refund_failure(error: Exception) -> dict[str, Any]:
    return {"success": False, "status_code": 500, "error": str(error)}


def refund_batch_channel(ctx: ClientContext, url: str) -> Any:
    """Allow remote SVM refunds the same response time as ordinary E2E requests."""
    if isinstance(ctx.batch_scheme, BatchSvmClientScheme):
        import httpx

        def fetch(url: str, headers: dict[str, str]) -> Any:
            return httpx.get(url, headers=headers, timeout=httpx.Timeout(30.0, connect=10.0))

        return ctx.batch_scheme.refund(url, fetch=fetch)
    return ctx.batch_scheme.refund(url)


def _refund_result(settle: Any) -> dict[str, Any]:
    return {
        "success": settle.success,
        "data": {"refund": True},
        "status_code": 200,
        "payment_response": settle.model_dump(),
    }


def _stop_failed_deposit(phase: str, deposit: dict[str, Any]) -> None:
    if not deposit["success"]:
        _emit_and_exit(aggregate_batch_result(phase, [deposit], {"deposit": deposit}))


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
            "batch-settlement scheme not registered for this endpoint "
            "(CLIENT_EVM_PRIVATE_KEY or CLIENT_SVM_PRIVATE_KEY required)"
        )
    if refund is None:
        raise RuntimeError("refund callback required for batch-settlement phases")

    url = f"{ctx.base_url}{ctx.endpoint_path}"

    if ctx.batch_settlement_phase == "initial":
        deposit = issue_request()
        _stop_failed_deposit("initial", deposit)
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
        try:
            refund_result = _refund_result(refund(url))
        except Exception as error:
            refund_result = _refund_failure(error)
        _emit_and_exit(
            aggregate_batch_result(
                "recovery-refund",
                [recovery_voucher, refund_result],
                {"recoveryVoucher": recovery_voucher, "refund": refund_result},
            )
        )

    if ctx.batch_settlement_phase == "full":
        deposit = issue_request()
        _stop_failed_deposit("full", deposit)
        voucher = issue_request()
        try:
            refund_result = _refund_result(refund(url))
        except Exception as error:
            refund_result = _refund_failure(error)
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

    raise RuntimeError(f"Unknown BATCH_SETTLEMENT_PHASE: {ctx.batch_settlement_phase}")


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
            "batch-settlement scheme not registered for this endpoint "
            "(CLIENT_EVM_PRIVATE_KEY or CLIENT_SVM_PRIVATE_KEY required)"
        )
    if refund is None:
        raise RuntimeError("refund callback required for batch-settlement phases")

    url = f"{ctx.base_url}{ctx.endpoint_path}"

    if ctx.batch_settlement_phase == "initial":
        deposit = await issue_request()
        _stop_failed_deposit("initial", deposit)
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
        try:
            refund_result = _refund_result(await refund(url))
        except Exception as error:
            refund_result = _refund_failure(error)
        _emit_and_exit(
            aggregate_batch_result(
                "recovery-refund",
                [recovery_voucher, refund_result],
                {"recoveryVoucher": recovery_voucher, "refund": refund_result},
            )
        )

    if ctx.batch_settlement_phase == "full":
        deposit = await issue_request()
        _stop_failed_deposit("full", deposit)
        voucher = await issue_request()
        try:
            refund_result = _refund_result(await refund(url))
        except Exception as error:
            refund_result = _refund_failure(error)
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

    raise RuntimeError(f"Unknown BATCH_SETTLEMENT_PHASE: {ctx.batch_settlement_phase}")
