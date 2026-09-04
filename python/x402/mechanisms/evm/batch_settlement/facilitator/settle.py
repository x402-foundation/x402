"""Facilitator-side settle execution (sweep claimed funds to receiver)."""

from __future__ import annotations

try:
    from eth_utils import to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .....schemas import PaymentRequirements, SettleResponse
from ...settle_receipt import wait_for_receipt_and_build_response
from ...signer import FacilitatorEvmSigner
from ...utils import truncate_error_message
from ..abi import BATCH_SETTLEMENT_ABI
from ..constants import BATCH_SETTLEMENT_ADDRESS
from ..errors import (
    ERR_NOTHING_TO_SETTLE,
    ERR_RPC_READ_FAILED,
    ERR_SETTLE_SIMULATION_FAILED,
    ERR_SETTLE_TRANSACTION_FAILED,
    ERR_SETTLED_EVENT_MISMATCH,
)
from ..types import SettlePayload


def execute_settle(
    signer: FacilitatorEvmSigner,
    payload: SettlePayload,
    requirements: PaymentRequirements,
    data_suffix: str | None = None,
) -> SettleResponse:
    """Transfer claimed funds from the contract to the receiver.

    Call after one or more `claimWithSignature()` transactions have updated
    `totalClaimed` accounting for the (receiver, token) pair.
    """
    network = str(requirements.network)
    contract_addr = to_checksum_address(BATCH_SETTLEMENT_ADDRESS)
    receiver = to_checksum_address(payload.receiver)
    token = to_checksum_address(payload.token)

    try:
        result = signer.read_contract(
            contract_addr, BATCH_SETTLEMENT_ABI, "receivers", receiver, token
        )
        total_claimed, total_settled = _unpack_pair(result)
        if total_claimed <= total_settled:
            return SettleResponse(
                success=False,
                error_reason=ERR_NOTHING_TO_SETTLE,
                error_message="nothing to settle for receiver and token",
                transaction="",
                network=network,
            )
    except Exception as e:
        return SettleResponse(
            success=False,
            error_reason=ERR_RPC_READ_FAILED,
            error_message=truncate_error_message(str(e)),
            transaction="",
            network=network,
        )

    try:
        signer.read_contract(contract_addr, BATCH_SETTLEMENT_ABI, "settle", receiver, token)
    except Exception as e:
        return SettleResponse(
            success=False,
            error_reason=ERR_SETTLE_SIMULATION_FAILED,
            error_message=truncate_error_message(str(e)),
            transaction="",
            network=network,
        )

    try:
        tx = signer.write_contract(
            contract_addr,
            BATCH_SETTLEMENT_ABI,
            "settle",
            receiver,
            token,
            data_suffix=data_suffix,
        )
    except Exception as e:
        return SettleResponse(
            success=False,
            error_reason=ERR_SETTLE_TRANSACTION_FAILED,
            error_message=truncate_error_message(str(e)),
            transaction="",
            network=network,
        )

    return wait_for_receipt_and_build_response(
        signer,
        tx,
        network,
        None,
        failed_reason=ERR_SETTLE_TRANSACTION_FAILED,
        on_success=lambda receipt: _settle_response_from_receipt(
            signer, receipt, tx, network, contract_addr, receiver, token
        ),
    )


def _settle_response_from_receipt(
    signer: FacilitatorEvmSigner,
    receipt,
    tx: str,
    network: str,
    contract_addr: str,
    receiver: str,
    token: str,
) -> SettleResponse:
    """Fail closed when the receipt has no positive Settled amount."""
    amount = _parse_settled_amount(signer, receipt, contract_addr, receiver, token)
    if not amount or amount == "0":
        return SettleResponse(
            success=False,
            error_reason=ERR_SETTLED_EVENT_MISMATCH,
            error_message=(
                "settle receipt missing Settled event with positive amount "
                "(possible no-op early return)"
            ),
            transaction=tx,
            network=network,
        )
    return SettleResponse(
        success=True,
        transaction=tx,
        network=network,
        amount=amount,
    )


def _unpack_pair(value) -> tuple[int, int]:
    if isinstance(value, list | tuple) and len(value) >= 2:
        return int(value[0]), int(value[1])
    raise ValueError(f"expected (uint, uint) pair, got {value!r}")


def _parse_settled_amount(
    signer: FacilitatorEvmSigner,
    receipt,
    contract_addr: str,
    receiver: str,
    token: str,
) -> str:
    """Extract Settled amount from receipt logs.

    Empty or "0" means the caller must fail closed. Looks up web3 on the signer
    as `web3`, `w3`, or `_w3` so FacilitatorWeb3Signer and protocol-compatible
    custom signers all decode.
    """
    logs = getattr(receipt, "logs", None)
    if not logs:
        return ""

    try:
        web3 = (
            getattr(signer, "web3", None)
            or getattr(signer, "w3", None)
            or getattr(signer, "_w3", None)
        )
        if web3 is None:
            return ""
        contract = web3.eth.contract(address=contract_addr, abi=BATCH_SETTLEMENT_ABI)
        settled_event = contract.events.Settled()
        for log in logs:
            log_addr = getattr(log, "address", None) or (
                log.get("address") if isinstance(log, dict) else None
            )
            if log_addr is None or to_checksum_address(log_addr) != contract_addr:
                continue
            try:
                decoded = settled_event.process_log(log)
            except Exception:
                continue
            args = decoded.get("args", {})
            log_receiver = args.get("receiver")
            log_token = args.get("token")
            if (
                log_receiver
                and log_token
                and to_checksum_address(log_receiver) == receiver
                and to_checksum_address(log_token) == token
            ):
                return str(args.get("amount", 0))
    except Exception:
        return ""
    return ""


__all__ = ["execute_settle"]
